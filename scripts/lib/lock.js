const fs = require('node:fs')
const path = require('node:path')

// The single lock specification for the Bubo store. Both the runtime
// (scripts/lib/store.js) and the standalone repair tool (tools/repair-bubo-ids.js)
// use this module, because two implementations of the same protocol drift: one
// wrote `token pid` owners and judged abandonment by process liveness while the
// other wrote token-only owners and evicted by age, so each would happily evict
// the other mid-write.
//
// Protocol
// --------
// `.bubo/.lock` is a directory. mkdir is atomic everywhere, so exactly one
// caller creates it. Inside it, `owner` records `<token> <pid> <acquiredAtMs>`.
//
// Reclaiming an abandoned lock is the hard part. Checking "is it abandoned?" and
// then renaming or deleting the path is check-then-act: rename does not compare
// source identity, so two contenders that both saw the same dead lock could each
// remove whatever occupied the path afterwards — including a lock a third
// process had legitimately acquired in between. Two writers then entered the
// critical section together.
//
// Reclamation therefore happens under a second, exclusive lock: `.lock.breaker`.
// While that is held, `.bubo/.lock` cannot change, because the only parties that
// could remove it are its own owner (verified dead) and another reclaimer (there
// can only be one). Re-checking abandonment under the breaker is then sound, and
// the removal cannot hit a successor.
//
// The breaker is itself age-reclaimed, which is safe in a way the main lock is
// not: it is held for microseconds, so a breaker older than BREAKER_STALE_MS
// belongs to a process that died mid-reclaim.

const LOCK_NAME = '.lock'
const BREAKER_NAME = '.lock.breaker'

const DEFAULT_TIMEOUT_MS = 15000
// Only used for a lock with no readable owner: a crash between creating the
// directory and writing the owner file leaves no pid to interrogate.
const OWNERLESS_STALE_MS = 10000
// A breaker is held for the duration of one stat and one rmdir.
const BREAKER_STALE_MS = 30000
// pids are recycled. A live pid that has "held" the lock for longer than any
// real operation is far more likely to be an unrelated process that inherited
// the number than a genuine holder, so stop trusting liveness past this bound.
const MAX_HOLD_MS = 3600000

let counter = 0

function mintToken() {
  counter += 1
  return `${process.pid}-${counter}-${Math.random().toString(36).slice(2)}`
}

// Signal 0 runs the existence and permission checks without delivering anything.
// EPERM means the process exists but belongs to another user: still alive.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readOwner(lockPath) {
  try {
    const raw = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim()
    const [token, pid, acquiredAt] = raw.split(/\s+/)
    return { token, pid: Number(pid), acquiredAt: Number(acquiredAt) }
  } catch {
    return null
  }
}

function directoryAge(lockPath, now) {
  try {
    return now - fs.statSync(lockPath).mtimeMs
  } catch {
    return null
  }
}

// Elapsed time is the wrong primary test: a holder doing legitimately slow work
// would be evicted mid-write. Whether the owning process still exists is the
// question that matters.
function isAbandoned(lockPath, now = Date.now()) {
  const owner = readOwner(lockPath)

  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    const age = directoryAge(lockPath, now)
    return age !== null && age > OWNERLESS_STALE_MS
  }

  if (!isProcessAlive(owner.pid)) return true

  // Alive, but guard against pid reuse making a dead holder look present.
  const heldFor = Number.isFinite(owner.acquiredAt) ? now - owner.acquiredAt : directoryAge(lockPath, now)
  return heldFor !== null && heldFor > MAX_HOLD_MS
}

// Remove an abandoned lock while holding exclusive reclamation rights. Returns
// true if the lock was cleared. Never throws for ordinary contention.
function reclaim(dir, now = Date.now) {
  const lockPath = path.join(dir, LOCK_NAME)
  const breakerPath = path.join(dir, BREAKER_NAME)
  const token = mintToken()

  try {
    fs.mkdirSync(breakerPath)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const age = directoryAge(breakerPath, now())
    if (age !== null && age > BREAKER_STALE_MS) {
      fs.rmSync(breakerPath, { recursive: true, force: true })
    }
    return false
  }

  try {
    fs.writeFileSync(path.join(breakerPath, 'owner'), `${token} ${process.pid} ${now()}\n`)
    // Sound because nothing else can alter `.lock` while we hold the breaker.
    if (isAbandoned(lockPath, now())) {
      fs.rmSync(lockPath, { recursive: true, force: true })
      return true
    }
    return false
  } finally {
    const holder = readOwner(breakerPath)
    if (!holder || holder.token === token) {
      fs.rmSync(breakerPath, { recursive: true, force: true })
    }
  }
}

function acquire(dir, options = {}) {
  const now = options.now || Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lockPath = path.join(dir, LOCK_NAME)
  const deadline = now() + timeoutMs
  const token = mintToken()

  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      fs.writeFileSync(path.join(lockPath, 'owner'), `${token} ${process.pid} ${now()}\n`)
      return { lockPath, token }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      // Checked before reclaiming, so repeated successful reclamations cannot
      // extend the wait past the caller's timeout.
      if (now() > deadline) {
        throw new Error(`Timed out waiting for the Bubo store lock at ${lockPath}`)
      }

      if (isAbandoned(lockPath, now())) {
        try {
          reclaim(dir, now)
        } catch (reclaimError) {
          // A permission fault will never succeed; do not retry it in a loop.
          throw new Error(
            `Cannot reclaim an abandoned Bubo store lock at ${lockPath}: ${reclaimError.code || reclaimError.message}`
          )
        }
      }

      // Synchronous sleep: the store's callers are synchronous.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}

// Only remove the lock if it is still ours. If a reclaimer cleared it while we
// worked and somebody else took it, deleting it would admit a second writer.
function release(held) {
  if (!held) return
  const owner = readOwner(held.lockPath)
  if (owner && owner.token === held.token) {
    fs.rmSync(held.lockPath, { recursive: true, force: true })
  }
}

function withLock(dir, fn, options = {}) {
  const held = acquire(dir, options)
  try {
    return fn()
  } finally {
    release(held)
  }
}

module.exports = {
  BREAKER_NAME,
  BREAKER_STALE_MS,
  LOCK_NAME,
  MAX_HOLD_MS,
  OWNERLESS_STALE_MS,
  acquire,
  isAbandoned,
  isProcessAlive,
  mintToken,
  readOwner,
  reclaim,
  release,
  withLock
}
