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
// Must exceed LOCK_STALE_MS. A contender that gave up first would never reach
// the point of declaring a lock stale, so abandoned locks could never be broken
// and the store would wedge permanently.
const LOCK_TIMEOUT_MS = 15000

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

let lockCounter = 0

// Every hold gets a token nobody else can guess or reproduce, so a holder can
// prove the lock it is about to release is still the one it took.
function mintToken() {
  lockCounter += 1
  return `${process.pid}-${lockCounter}-${Math.random().toString(36).slice(2)}`
}

// mkdir is atomic on POSIX and Windows alike: exactly one caller can create a
// given directory, which makes it a lock without a dependency.
//
// Two properties this has to get right, both learned the hard way:
//
//   Staleness is read from the lock directory's own mtime, not from the owner
//   file. A crash between mkdir and writing the owner leaves an ownerless lock;
//   judging staleness by file contents made that lock immortal and every later
//   writer timed out forever.
//
//   Breaking a stale lock claims it by rename rather than deleting it in place.
//   rename to a unique name is atomic, so when several contenders decide the
//   same lock is stale exactly one wins and the losers get ENOENT. A blind
//   recursive delete let a contender erase a lock somebody else had just
//   legitimately acquired.
function acquireLock(dir, now = Date.now) {
  const lockPath = path.join(dir, '.lock')
  const deadline = now() + LOCK_TIMEOUT_MS
  const token = mintToken()

  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      fs.writeFileSync(path.join(lockPath, 'owner'), `${token}\n`)
      return { lockPath, token }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      let heldSince = 0
      try {
        heldSince = fs.statSync(lockPath).mtimeMs
      } catch {
        // Released between our mkdir and our stat; just retry.
        continue
      }

      if (now() - heldSince > LOCK_STALE_MS) {
        try {
          // Atomically claim the stale lock. Only one contender's rename lands.
          fs.renameSync(lockPath, `${lockPath}.stale-${mintToken()}`)
        } catch {
          // Someone else claimed or released it first.
        }
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

// Only remove the lock if it is still ours. If a stale-breaker took it over
// while we were working, the directory now belongs to our successor and
// deleting it would hand the store to two writers at once.
function releaseLock({ lockPath, token }) {
  let owner = null
  try {
    owner = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim()
  } catch {
    return
  }

  if (owner === token) {
    fs.rmSync(lockPath, { recursive: true, force: true })
  }
}

// Sweep lock directories abandoned by stale-breaking. Cheap, and keeps .bubo
// from accumulating .lock.stale-* entries over a long-lived project.
function sweepStaleLocks(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  entries
    .filter((name) => name.startsWith('.lock.stale-'))
    .forEach((name) => fs.rmSync(path.join(dir, name), { recursive: true, force: true }))
}

function withLock(root, fn) {
  const dir = buboDir(root)
  const held = acquireLock(dir)
  try {
    return fn()
  } finally {
    releaseLock(held)
    sweepStaleLocks(dir)
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
      id: nextReviewId(root)
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
