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

const TAIL_CHUNK_BYTES = 1024 * 1024
const RECENT_LINE_CAP = 4 * 1024 * 1024
const RECENT_SCAN_CAP = 32 * 1024 * 1024

function parseRecord(text) {
  try {
    const record = JSON.parse(text)
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null
  } catch {
    return null
  }
}

// The last `count` parseable records, oldest first, read backwards from the end
// of reviews.jsonl. The hooks only ever need the newest few records (dedup and
// "show the latest note"), and reading the whole store for them made every turn
// cost as much as the store is large. Damaged lines and a partial trailing
// append are skipped. A line over maxLineBytes is skipped without being held in
// memory: no record written since clampContext can reach that size, so one that
// does is a pre-clamp bloated record that tools/compact-bubo-store.js repairs.
// The scan stops after maxScanBytes, so even such a store costs a bounded read
// per turn (backward reads get no readahead, so an unbounded scan of a bloated
// store ran past a minute); the price is fewer recent records to dedup against.
function readRecentReviews(root, count, options = {}) {
  ensureProjectState(root)
  if (!Number.isInteger(count) || count <= 0) return []

  const chunkSize = options.chunkSize || TAIL_CHUNK_BYTES
  const maxLineBytes = options.maxLineBytes || RECENT_LINE_CAP
  const maxScanBytes = options.maxScanBytes || RECENT_SCAN_CAP
  const file = path.join(buboDir(root), 'reviews.jsonl')
  const found = []
  let pieces = []
  let pieceBytes = 0
  let oversized = false

  const addPiece = (piece) => {
    if (oversized || piece.length === 0) return
    pieceBytes += piece.length
    if (pieceBytes > maxLineBytes) {
      oversized = true
      pieces = []
      return
    }
    // Copied: the read buffer is reused for the next chunk.
    pieces.push(Buffer.from(piece))
  }

  const finishLine = () => {
    if (!oversized && pieceBytes > 0) {
      const record = parseRecord(Buffer.concat(pieces.reverse()).toString('utf8'))
      if (record) found.push(record)
    }
    pieces = []
    pieceBytes = 0
    oversized = false
  }

  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(chunkSize)
    const size = fs.fstatSync(fd).size
    const floor = Math.max(0, size - maxScanBytes)
    let pos = size
    while (pos > floor && found.length < count) {
      const length = Math.min(chunkSize, pos - floor)
      pos -= length
      fs.readSync(fd, buffer, 0, length, pos)
      const chunk = buffer.subarray(0, length)

      let end = length
      let newline = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1
      while (newline !== -1 && found.length < count) {
        addPiece(chunk.subarray(newline + 1, end))
        finishLine()
        end = newline
        newline = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1
      }
      if (found.length < count) addPiece(chunk.subarray(0, end))
    }
    // The first line of the file has no newline before it. A line cut off by
    // the scan budget is incomplete, so it is dropped rather than parsed.
    if (found.length < count && pos === 0) finishLine()
  } finally {
    fs.closeSync(fd)
  }

  return found.reverse()
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

const SCAN_CHUNK_BYTES = 1024 * 1024

// Every line is fully parsed: an id read off a damaged line could be anything,
// and one bogus high id would exhaust the id space for every later review. A
// line too long to become a string cannot be judged at all, so allocation
// stops with a fix rather than skipping it and risking reissuing its id.
function lineId(pieces, file) {
  let text
  try {
    text = Buffer.concat(pieces).toString('utf8')
  } catch (error) {
    if (error.code !== 'ERR_STRING_TOO_LONG') throw error
    throw new Error(
      `Bubo store has a record too large to read: ${file}\n` +
      '  Compact it with: node tools/compact-bubo-store.js <project> --write'
    )
  }
  const record = parseRecord(text)
  return record ? record.id : undefined
}

// The highest id the store has ever handed out. Scanned from reviews.jsonl
// itself — the only append-only, never-reset record of what is taken. Damaged
// lines are skipped rather than thrown on, so one bad record cannot block every
// future review. The file is streamed in chunks rather than read into one
// string, so memory follows the largest line rather than the whole store.
function maxReviewId(root, options = {}) {
  const file = path.join(buboDir(root), 'reviews.jsonl')
  if (!fs.existsSync(file)) return 0

  const chunkSize = options.chunkSize || SCAN_CHUNK_BYTES
  let max = 0
  let pieces = []

  const finishLine = () => {
    if (pieces.length) {
      const id = lineId(pieces, file)
      if (Number.isSafeInteger(id) && id > max) max = id
    }
    pieces = []
  }

  const fd = fs.openSync(file, 'r')
  try {
    for (;;) {
      // A fresh buffer per read: pieces of the current line keep references.
      const buffer = Buffer.allocUnsafe(chunkSize)
      const length = fs.readSync(fd, buffer, 0, chunkSize, null)
      if (length === 0) break
      const chunk = buffer.subarray(0, length)

      let start = 0
      let newline = chunk.indexOf(0x0a, start)
      while (newline !== -1) {
        if (newline > start) pieces.push(chunk.subarray(start, newline))
        finishLine()
        start = newline + 1
        newline = chunk.indexOf(0x0a, start)
      }
      if (start < length) pieces.push(chunk.subarray(start))
    }
    finishLine()
  } finally {
    fs.closeSync(fd)
  }

  return max
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
  readRecentReviews,
  readReviews,
  readState,
  rewriteReviews,
  withLock,
  writeState
}
