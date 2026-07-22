const fs = require('node:fs')
const path = require('node:path')

const lock = require('./lock')

const DEFAULT_CONFIG = {
  cooldowns: {
    turnMs: 10000,
    signalMs: 5000,
    reflectMs: 900000
  },
  dedupWindow: 5,
  largeDiffThreshold: 80,
  provider: {
    kind: 'heuristic'
  }
}

const DEFAULT_STATE = {
  lastTriggerAt: {},
  dedup: [],
  enabled: true
}

function buboDir(root) {
  return path.join(root, '.bubo')
}

// 'wx' creates only if the path does not exist, atomically. A plain
// existsSync-then-write is two steps: two first-time writers could both observe
// "no file" and the second write would truncate reviews the first had already
// appended, losing records and reissuing id 1.
function ensureFile(filePath, initialValue) {
  try {
    fs.writeFileSync(filePath, initialValue, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

function ensureProjectState(root) {
  const dir = buboDir(root)
  fs.mkdirSync(dir, { recursive: true })

  ensureFile(path.join(dir, 'state.json'), JSON.stringify(DEFAULT_STATE, null, 2) + '\n')

  ensureFile(path.join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
  ensureFile(path.join(dir, 'reviews.jsonl'), '')
}

// A missing file is a legitimate fresh start. Unreadable content is not: it
// means a write was interrupted or clobbered, and quietly substituting defaults
// discards real state (an explicit `bubo stop`, the cooldown clock) while
// looking like nothing happened.
function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  const raw = fs.readFileSync(filePath, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Bubo state file is corrupt: ${filePath}\n` +
      `  ${error.message}\n` +
      '  Delete the file to start fresh; reviews.jsonl is unaffected.'
    )
  }
}

// The lock protocol lives in ./lock.js so the runtime and the standalone repair
// tool cannot drift apart; see that file for why reclamation needs a breaker.
function withLock(root, fn, options = {}) {
  return lock.withLock(buboDir(root), fn, options)
}

function readConfig(root) {
  ensureProjectState(root)
  const config = readJsonFile(path.join(buboDir(root), 'config.json'), DEFAULT_CONFIG)

  return {
    ...DEFAULT_CONFIG,
    ...config,
    cooldowns: {
      ...DEFAULT_CONFIG.cooldowns,
      ...(config.cooldowns || {})
    },
    provider: {
      ...DEFAULT_CONFIG.provider,
      ...(config.provider || {})
    }
  }
}

function readState(root) {
  ensureProjectState(root)
  return {
    ...DEFAULT_STATE,
    ...readJsonFile(path.join(buboDir(root), 'state.json'), DEFAULT_STATE)
  }
}

// Write to a sibling temp file and rename over the target. rename(2) is atomic
// within a filesystem, so an interrupted or concurrent write can never leave a
// half-written state.json behind.
function writeState(root, state) {
  ensureProjectState(root)
  const dir = buboDir(root)
  const target = path.join(dir, 'state.json')
  const tmp = path.join(dir, `.state.json.${process.pid}.tmp`)

  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  try {
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

function appendReview(root, review) {
  ensureProjectState(root)
  fs.appendFileSync(path.join(buboDir(root), 'reviews.jsonl'), JSON.stringify(review) + '\n')
}

function readReviews(root) {
  ensureProjectState(root)
  const file = path.join(buboDir(root), 'reviews.jsonl')
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// Staged write plus rename. A plain writeFileSync truncates the canonical file
// first, so a kill or a full disk mid-write leaves partial JSONL: history is
// lost, and with it the high-water mark, so ids start being reissued. rename is
// atomic within a filesystem, so readers see either the old file or the new one.
function rewriteReviews(root, reviews, options = {}) {
  ensureProjectState(root)
  const file = path.join(buboDir(root), 'reviews.jsonl')
  const payload = reviews.map((review) => JSON.stringify(review)).join('\n')
  const tmp = options.tmpPath || `${file}.${process.pid}.${lock.mintToken()}.tmp`

  const handle = fs.openSync(tmp, 'wx')
  try {
    fs.writeFileSync(handle, payload ? `${payload}\n` : '')
    // rename gives atomic visibility, not durability; flush before publishing.
    fs.fsyncSync(handle)
  } catch (error) {
    // A write or flush failure must not strand the staged file.
    fs.closeSync(handle)
    fs.rmSync(tmp, { force: true })
    throw error
  }
  fs.closeSync(handle)

  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

// The highest id the store has ever handed out. Scanned from reviews.jsonl
// itself — the only append-only, never-reset record of what is taken. Damaged
// lines are skipped rather than thrown on, so one bad record cannot block every
// future review.
function maxReviewId(root) {
  const file = path.join(buboDir(root), 'reviews.jsonl')
  if (!fs.existsSync(file)) return 0

  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((max, line) => {
      let id
      try {
        id = JSON.parse(line).id
      } catch {
        return max
      }
      return Number.isSafeInteger(id) && id > max ? id : max
    }, 0)
}

// Past MAX_SAFE_INTEGER, `max + 1 === max` and every later review would silently
// share one id. Refuse rather than resume the exact bug this change removed.
function nextReviewId(root) {
  const max = maxReviewId(root)
  if (max >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Bubo review ids are exhausted: the store has reached the safe integer ceiling')
  }
  return max + 1
}

const CONTEXT_FIELD_CAP = 8192
const CONTEXT_TOTAL_CAP = 65536
const RECORD_TEXT_CAP = 8192

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null')
}

function capString(value, cap) {
  return value.length > cap
    ? `${value.slice(0, cap)}…[+${value.length - cap} chars]`
    : value
}

// The few fields dedup (fingerprint reads problem/rendered) and display use.
// Deliberately omits `context` — carrying it is what made recentReviews recurse.
function summarizeRecentReview(review) {
  if (!review || typeof review !== 'object') return review
  return {
    id: review.id,
    timestamp: review.timestamp,
    reason: review.reason,
    problem: typeof review.problem === 'string' ? capString(review.problem, CONTEXT_FIELD_CAP) : review.problem,
    rendered: typeof review.rendered === 'string' ? capString(review.rendered, CONTEXT_FIELD_CAP) : review.rendered
  }
}

// Bound what a review stores as context, to a hard UTF-8 byte budget under all
// inputs. The dangerous field was recentReviews: it carried whole prior reviews
// INCLUDING their context, which carried their recentReviews, and so on — each
// generation multiplying the store until a single record reached 124MB.
//
// Guarantee: the returned value serializes to at most CONTEXT_TOTAL_CAP bytes.
// recentReviews is reduced to the fields dedup and display read; oversized
// strings are capped; and if the whole thing is still over budget (many fields,
// or a pathological single field), the largest fields are replaced by markers
// until it fits. A non-object context is bounded too.
function clampContext(context) {
  if (context === undefined || context === null) return context

  if (typeof context !== 'object' || Array.isArray(context)) {
    // A primitive or array context is unusual; bound it rather than trust it.
    return utf8Bytes(context) <= CONTEXT_TOTAL_CAP
      ? context
      : { truncated: true, bytes: utf8Bytes(context) }
  }

  const out = {}
  for (const [key, value] of Object.entries(context)) {
    if (key === 'recentReviews' && Array.isArray(value)) {
      out[key] = value.map(summarizeRecentReview)
    } else if (typeof value === 'string') {
      out[key] = capString(value, CONTEXT_FIELD_CAP)
    } else {
      out[key] = value
    }
  }

  // Per-field capping handles the common case. If the whole thing is still over
  // budget — too many fields, or a large non-string field — collapse to a small
  // allowlist rather than iterating (repeatedly re-serialising a multi-megabyte
  // object to find the largest field is quadratic and was itself a hang). One
  // measurement decides; the fallback is bounded by construction.
  const originalBytes = utf8Bytes(out)
  if (originalBytes <= CONTEXT_TOTAL_CAP) return out

  const reduced = { truncated: true, originalBytes }
  for (const key of ['reason', 'cwd', 'timestamp']) {
    if (typeof out[key] === 'string') reduced[key] = capString(out[key], 256)
    else if (out[key] !== undefined) reduced[key] = out[key]
  }
  return reduced
}

// Bound the record's own free-text fields as well. rendered is clamped upstream,
// but createReview must not trust a caller to have done so.
function clampRecordText(review) {
  for (const field of ['problem', 'evidence', 'solution', 'rendered']) {
    if (typeof review[field] === 'string') {
      review[field] = capString(review[field], RECORD_TEXT_CAP)
    }
  }
  return review
}

// Ids come from reviews.jsonl rather than a counter in state.json: state.json
// is rewritten on nearly every turn and has been observed to rewind, which
// silently reissues ids that older records already own. The lock makes the
// read-then-append indivisible so concurrent sessions cannot claim the same id.
function createReview(root, payload) {
  ensureProjectState(root)

  return withLock(root, () => {
    const review = clampRecordText({
      timestamp: new Date().toISOString(),
      status: payload.status || 'new',
      ...payload,
      // Bound before storing, so an unbounded context cannot bloat the store.
      context: clampContext(payload.context),
      // Assigned last: the store owns ids, never the caller.
      id: nextReviewId(root)
    })

    appendReview(root, review)
    return review
  })
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  CONTEXT_TOTAL_CAP,
  clampContext,
  clampRecordText,
  summarizeRecentReview,
  appendReview,
  buboDir,
  createReview,
  ensureProjectState,
  maxReviewId,
  readConfig,
  readReviews,
  readState,
  rewriteReviews,
  withLock,
  writeState
}
