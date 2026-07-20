const fs = require('node:fs')
const path = require('node:path')

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

// A held lock older than this is treated as abandoned (crashed process, killed
// session) and broken, so one dead writer cannot wedge the store forever.
const LOCK_STALE_MS = 10000
const LOCK_TIMEOUT_MS = 5000

function buboDir(root) {
  return path.join(root, '.bubo')
}

function ensureFile(filePath, initialValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialValue)
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

// mkdir is atomic on POSIX and Windows alike: exactly one caller can create a
// given directory, which makes it a lock without a dependency.
function acquireLock(dir, now = Date.now) {
  const lockPath = path.join(dir, '.lock')
  const deadline = now() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid} ${now()}\n`)
      return lockPath
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      let heldSince = 0
      try {
        heldSince = Number(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').split(' ')[1]) || 0
      } catch {
        // Lock created but owner not yet written, or already released.
      }

      if (heldSince && now() - heldSince > LOCK_STALE_MS) {
        releaseLock(lockPath)
        continue
      }

      if (now() > deadline) {
        throw new Error(`Timed out waiting for the Bubo store lock at ${lockPath}`)
      }

      // Synchronous sleep: callers of createReview are synchronous.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}

function releaseLock(lockPath) {
  fs.rmSync(lockPath, { recursive: true, force: true })
}

function withLock(root, fn) {
  const lockPath = acquireLock(buboDir(root))
  try {
    return fn()
  } finally {
    releaseLock(lockPath)
  }
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

function rewriteReviews(root, reviews) {
  ensureProjectState(root)
  const file = path.join(buboDir(root), 'reviews.jsonl')
  const payload = reviews.map((review) => JSON.stringify(review)).join('\n')
  fs.writeFileSync(file, payload ? `${payload}\n` : '')
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
      return Number.isInteger(id) && id > max ? id : max
    }, 0)
}

// Ids come from reviews.jsonl rather than a counter in state.json: state.json
// is rewritten on nearly every turn and has been observed to rewind, which
// silently reissues ids that older records already own. The lock makes the
// read-then-append indivisible so concurrent sessions cannot claim the same id.
function createReview(root, payload) {
  ensureProjectState(root)

  return withLock(root, () => {
    const review = {
      timestamp: new Date().toISOString(),
      status: payload.status || 'new',
      ...payload,
      // Assigned last: the store owns ids, never the caller.
      id: maxReviewId(root) + 1
    }

    appendReview(root, review)
    return review
  })
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
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
