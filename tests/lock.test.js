const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { makeProjectRoot } = require('./helpers')
const lock = require('../scripts/lib/lock')
const { createReview, ensureProjectState, readReviews } = require('../scripts/lib/store')

const DEAD_PID = 4194304 // above the usual pid_max, so it cannot be running

function buboDir(root) {
  return path.join(root, '.bubo')
}

function plantLock(root, owner) {
  const lockPath = path.join(buboDir(root), lock.LOCK_NAME)
  fs.mkdirSync(lockPath, { recursive: true })
  if (owner !== null) fs.writeFileSync(path.join(lockPath, 'owner'), `${owner}\n`)
  return lockPath
}

test('a lock owned by a live process is not abandoned', () => {
  const root = makeProjectRoot('bubo-lock-live-')
  ensureProjectState(root)
  const lockPath = plantLock(root, `tok ${process.pid} ${Date.now()}`)
  assert.equal(lock.isAbandoned(lockPath), false)
})

test('a lock owned by a dead process is abandoned', () => {
  const root = makeProjectRoot('bubo-lock-dead-')
  ensureProjectState(root)
  const lockPath = plantLock(root, `tok ${DEAD_PID} ${Date.now()}`)
  assert.equal(lock.isAbandoned(lockPath), true)
})

// pids get recycled. A live pid that has supposedly held the lock for longer
// than any real operation is far more likely an unrelated process that inherited
// the number, and must not wedge the store until it happens to exit.
test('a live pid holding far longer than any real operation is abandoned', () => {
  const root = makeProjectRoot('bubo-lock-pidreuse-')
  ensureProjectState(root)
  const ancient = Date.now() - (lock.MAX_HOLD_MS + 60000)
  const lockPath = plantLock(root, `tok ${process.pid} ${ancient}`)
  assert.equal(lock.isAbandoned(lockPath), true)
})

test('an ownerless lock is abandoned only once it has aged', () => {
  const root = makeProjectRoot('bubo-lock-ownerless-')
  ensureProjectState(root)
  const lockPath = plantLock(root, null)

  assert.equal(lock.isAbandoned(lockPath), false, 'a brand new ownerless lock may still be mid-creation')

  const old = new Date(Date.now() - (lock.OWNERLESS_STALE_MS + 5000))
  fs.utimesSync(lockPath, old, old)
  assert.equal(lock.isAbandoned(lockPath), true)
})

// The blocking finding: two contenders that both observed the same dead lock
// could each remove whatever occupied the path afterwards, including a lock a
// third process had legitimately acquired in between. Reclamation under an
// exclusive breaker makes the second reclaimer re-check and stand down.
test('a second reclaimer does not evict the successor that replaced a dead lock', () => {
  const root = makeProjectRoot('bubo-lock-two-breakers-')
  ensureProjectState(root)
  const dir = buboDir(root)
  plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  // Reclaimer A clears the dead lock, then a live holder takes it.
  assert.equal(lock.reclaim(dir), true)
  const successor = lock.acquire(dir, { timeoutMs: 1000 })

  // Reclaimer B, still believing the lock is the dead one it saw earlier.
  const evicted = lock.reclaim(dir)

  assert.equal(evicted, false, 'B must not evict a live successor')
  assert.ok(fs.existsSync(successor.lockPath), 'the successor still holds the lock')
  assert.equal(lock.readOwner(successor.lockPath).token, successor.token)
  lock.release(successor)
})

test('reclamation leaves no breaker behind', () => {
  const root = makeProjectRoot('bubo-lock-breaker-clean-')
  ensureProjectState(root)
  const dir = buboDir(root)
  plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  lock.reclaim(dir)
  assert.equal(fs.existsSync(path.join(dir, lock.BREAKER_NAME)), false)
})

test('a live holder is waited on, then the caller times out', () => {
  const root = makeProjectRoot('bubo-lock-timeout-')
  ensureProjectState(root)
  plantLock(root, `tok ${process.pid} ${Date.now()}`)

  const started = Date.now()
  assert.throws(
    () => lock.acquire(buboDir(root), { timeoutMs: 300 }),
    /Timed out waiting for the Bubo store lock/i
  )
  assert.ok(Date.now() - started < 5000, 'gave up promptly rather than spinning')
})

// Repeated successful reclamations used to `continue` past the deadline check,
// so a pathological store could hold a caller well beyond its stated timeout.
test('repeated reclamation cannot outlast the caller timeout', () => {
  const root = makeProjectRoot('bubo-lock-deadline-')
  ensureProjectState(root)
  const dir = buboDir(root)

  // Reclamation used to run before the deadline was consulted, so a store whose
  // lock kept being replaced could hold a caller past its stated timeout. The
  // observable invariant is the ordering: once the deadline has passed, acquire
  // gives up WITHOUT attempting to reclaim. An abandoned lock left untouched
  // after the throw is the proof.
  const lockPath = plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  const base = Date.now()
  let calls = 0
  const now = () => {
    calls += 1
    return calls === 1 ? base : base + 100000 // first call sets the deadline
  }

  assert.throws(
    () => lock.acquire(dir, { timeoutMs: 400, now }),
    /Timed out waiting for the Bubo store lock/i
  )
  assert.ok(
    fs.existsSync(lockPath),
    'an expired caller must not reclaim; the deadline is checked first'
  )
  fs.rmSync(lockPath, { recursive: true, force: true })
})

// Runtime and repair must speak one protocol. Repair holding the lock has to
// look held to the runtime, and vice versa.
test('runtime and repair agree on what a held lock looks like', () => {
  const root = makeProjectRoot('bubo-lock-protocol-')
  ensureProjectState(root)
  const dir = buboDir(root)

  const held = lock.acquire(dir, { timeoutMs: 1000 })
  const owner = lock.readOwner(held.lockPath)

  assert.equal(owner.pid, process.pid, 'owner records the pid')
  assert.ok(Number.isFinite(owner.acquiredAt), 'owner records acquisition time')
  assert.equal(lock.isAbandoned(held.lockPath), false)

  // The repair tool loads this very module, so there is one implementation.
  const repairLock = require('../tools/repair-bubo-ids')
  assert.ok(repairLock, 'repair tool loads')

  assert.throws(
    () => lock.acquire(dir, { timeoutMs: 200 }),
    /Timed out/i,
    'a second acquirer must not walk over a live holder'
  )
  lock.release(held)
})

test('concurrent writers reclaiming a dead lock still get unique ids', () => {
  const root = makeProjectRoot('bubo-lock-reclaim-race-')
  ensureProjectState(root)
  plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  const storePath = path.join(__dirname, '..', 'scripts', 'lib', 'store.js')
  const gate = path.join(root, 'go')
  const worker = `
    const fs = require('node:fs')
    const { createReview } = require(${JSON.stringify(storePath)})
    const [root, gate] = process.argv.slice(1)
    // Bounded: a worker must never outlive its parent spinning on a gate that
    // will not arrive.
    const giveUpAt = Date.now() + 30000
    while (!fs.existsSync(gate)) {
      if (Date.now() > giveUpAt) throw new Error('barrier never opened')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    }
    for (let i = 0; i < 5; i += 1) {
      createReview(root, {
        reason: 'manual', rendered: 'reclaim', problem: 'p', evidence: 'e', solution: 's', context: {}
      })
    }
  `

  const workers = Array.from({ length: 6 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', worker, root, gate], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))))
    })
  )

  return new Promise((resolve) => setTimeout(resolve, 300))
    .then(() => fs.writeFileSync(gate, ''))
    .then(() => Promise.all(workers))
    .then(() => {
      const ids = readReviews(root).map((review) => review.id)
      assert.equal(ids.length, 30, 'no writer lost its append')
      assert.equal(new Set(ids).size, 30, `ids collided: ${ids.join(', ')}`)
    })
})

test('createReview still works after reclaiming a dead lock', () => {
  const root = makeProjectRoot('bubo-lock-reclaim-simple-')
  ensureProjectState(root)
  plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  const created = createReview(root, {
    reason: 'manual', rendered: 'x', problem: 'p', evidence: 'e', solution: 's', context: {}
  })
  assert.equal(created.id, 1)
})
