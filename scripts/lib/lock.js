const fs = require('node:fs')
const path = require('node:path')

// The single lock specification for the Bubo store, shared by the runtime
// (scripts/lib/store.js) and the standalone repair tool, because two
// implementations of one protocol drift apart and start evicting each other.
//
// Why there is no automatic stale-lock recovery
// ---------------------------------------------
// Three successive designs tried to reclaim abandoned locks and all three had
// the same defect, because the defect is not in the design — it is in the
// primitives. Node on POSIX offers no atomic compare-and-swap on a pathname, so
// "confirm this is the lock I inspected, then remove it" is always two syscalls
// against a *name*. Between them the name can come to refer to something else:
//
//   1. check-then-rename on `.lock`      -> evicted a live successor
//   2. the same, guarded by a breaker    -> evicted a live successor's breaker
//   3. liveness plus a max-hold bound    -> evicted confirmed-live holders
//
// So this implementation does not reclaim. It only ever publishes and removes
// its own lock, which removes the entire class:
//
//   * A lock is published atomically. The directory is built complete, owner
//     file and all, under a private name and then renamed into place. rename
//     onto an existing directory fails, so a lock is never observable in a
//     half-initialised state and there is no ownerless window for a stalled
//     acquirer to overwrite later.
//
//   * A lock is removed only by the process that holds it. Nothing races the
//     removal, because nothing else ever removes it.
//
// The cost is that a crashed session leaves its lock behind. That is a
// deliberate trade: a wedged store announces itself with an actionable error,
// whereas silent mutual exclusion failures corrupt review history. `bubo unlock`
// clears it after confirming the owner is gone.

const LOCK_NAME = '.lock'
const DEFAULT_TIMEOUT_MS = 15000

let counter = 0

function mintToken() {
  counter += 1
  return `${process.pid}-${counter}-${Math.random().toString(36).slice(2)}`
}

// Signal 0 runs the existence and permission checks without delivering
// anything. EPERM means the process exists but belongs to another user.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function lockPathFor(dir) {
  return path.join(dir, LOCK_NAME)
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

// Describe who holds the lock, for an error a human can act on.
function describeHolder(lockPath) {
  const owner = readOwner(lockPath)
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return 'held by an unidentified process'
  }
  const alive = isProcessAlive(owner.pid)
  return `held by pid ${owner.pid}${alive ? ' (running)' : ' (no longer running)'}`
}

// Build the lock complete, then move it into place in one atomic step. A
// partially built lock is never visible under the real name.
function publish(dir, token, now) {
  const staging = path.join(dir, `.lock.staging-${token}`)
  fs.mkdirSync(staging, { recursive: true })
  try {
    fs.writeFileSync(path.join(staging, 'owner'), `${token} ${process.pid} ${now()}\n`, { flag: 'wx' })
    fs.renameSync(staging, lockPathFor(dir))
    return true
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    // Someone else holds it. rename onto an existing directory reports these.
    if (['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(error.code)) return false
    throw error
  }
}

function acquire(dir, options = {}) {
  const now = options.now || Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lockPath = lockPathFor(dir)
  const deadline = now() + timeoutMs
  const token = mintToken()

  for (;;) {
    if (publish(dir, token, now)) return { lockPath, token }

    if (now() > deadline) {
      throw new Error(
        `Timed out waiting for the Bubo store lock at ${lockPath}\n` +
        `  It is ${describeHolder(lockPath)}.\n` +
        '  If that process is gone, clear it with: bubo unlock'
      )
    }

    // Synchronous sleep: the store's callers are synchronous.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

// Release has to be as atomic as acquisition. Deleting the directory's contents
// in place makes it briefly empty, and rename onto an *empty* directory succeeds
// on POSIX — so a waiting acquirer could publish straight into the lock that is
// being torn down, leaving two holders and an ENOTEMPTY on the way out.
// Renaming the whole directory away frees the name in one step instead.
function release(held) {
  if (!held) return

  const owner = readOwner(held.lockPath)
  if (owner && owner.token !== held.token) return // already someone else's

  const retiring = `${held.lockPath}.releasing-${held.token}`
  try {
    fs.renameSync(held.lockPath, retiring)
  } catch {
    return // already gone
  }
  fs.rmSync(retiring, { recursive: true, force: true })
}

function withLock(dir, fn, options = {}) {
  const held = acquire(dir, options)
  try {
    return fn()
  } finally {
    release(held)
  }
}

// Explicit, operator-driven recovery: the only way a lock is ever removed by
// anyone other than its holder. Refuses while the owning process is running,
// unless the caller insists.
function unlock(dir, options = {}) {
  const lockPath = lockPathFor(dir)
  if (!fs.existsSync(lockPath)) return { cleared: false, reason: 'no lock held' }

  const owner = readOwner(lockPath)
  if (owner && isProcessAlive(owner.pid) && !options.force) {
    return { cleared: false, reason: `pid ${owner.pid} is still running`, owner }
  }

  // Same atomicity requirement as release: free the name in one step so a
  // waiting acquirer cannot publish into a half-dismantled lock.
  const retiring = `${lockPath}.releasing-${mintToken()}`
  try {
    fs.renameSync(lockPath, retiring)
  } catch {
    return { cleared: false, reason: 'no lock held' }
  }
  fs.rmSync(retiring, { recursive: true, force: true })
  return { cleared: true, owner }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LOCK_NAME,
  acquire,
  describeHolder,
  isProcessAlive,
  mintToken,
  readOwner,
  release,
  unlock,
  withLock
}
