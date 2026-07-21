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

test('a published lock is complete the instant it is visible', () => {
  const root = makeProjectRoot('bubo-lock-atomic-')
  ensureProjectState(root)
  const held = lock.acquire(buboDir(root), { timeoutMs: 1000 })

  // No window exists in which the directory is present without its owner: it is
  // built under a private name and renamed into place in one step.
  const owner = lock.readOwner(held.lockPath)
  assert.ok(owner, 'owner is present as soon as the lock is')
  assert.equal(owner.pid, process.pid)
  assert.equal(owner.token, held.token)
  assert.ok(Number.isFinite(owner.acquiredAt))
  lock.release(held)
  assert.equal(fs.existsSync(held.lockPath), false)
})

test('no staging directory survives a successful acquire', () => {
  const root = makeProjectRoot('bubo-lock-staging-')
  ensureProjectState(root)
  const held = lock.acquire(buboDir(root), { timeoutMs: 1000 })
  lock.release(held)

  const residue = fs.readdirSync(buboDir(root)).filter((n) => n.includes('staging'))
  assert.deepEqual(residue, [])
})

test('a contended lock leaves no staging residue either', () => {
  const root = makeProjectRoot('bubo-lock-staging-contended-')
  ensureProjectState(root)
  plantLock(root, `tok ${process.pid} ${Date.now()}`)

  assert.throws(() => lock.acquire(buboDir(root), { timeoutMs: 200 }), /Timed out/i)
  const residue = fs.readdirSync(buboDir(root)).filter((n) => n.includes('staging'))
  assert.deepEqual(residue, [])
})

// The whole point of the design: an abandoned lock is NEVER reclaimed
// automatically, because every automatic scheme raced and admitted two writers.
test('an abandoned lock is not reclaimed automatically', () => {
  const root = makeProjectRoot('bubo-lock-noreclaim-')
  ensureProjectState(root)
  const lockPath = plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  assert.throws(() => lock.acquire(buboDir(root), { timeoutMs: 200 }), /Timed out/i)
  assert.ok(fs.existsSync(lockPath), 'the stale lock is left in place, not silently removed')
})

test('the timeout error says who holds it and how to clear it', () => {
  const root = makeProjectRoot('bubo-lock-message-')
  ensureProjectState(root)
  plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  assert.throws(() => lock.acquire(buboDir(root), { timeoutMs: 150 }), (error) => {
    assert.match(error.message, new RegExp(String(DEAD_PID)), 'names the owning pid')
    assert.match(error.message, /no longer running/i, 'says whether it is alive')
    assert.match(error.message, /bubo unlock/, 'says how to recover')
    return true
  })
})

test('a live holder is reported as running', () => {
  const root = makeProjectRoot('bubo-lock-livemsg-')
  ensureProjectState(root)
  plantLock(root, `tok ${process.pid} ${Date.now()}`)

  assert.match(lock.describeHolder(path.join(buboDir(root), lock.LOCK_NAME)), /running/)
  assert.doesNotMatch(lock.describeHolder(path.join(buboDir(root), lock.LOCK_NAME)), /no longer/)
})

// A holder is never evicted for taking too long. Earlier designs bounded holds
// to guard against pid reuse and evicted confirmed-live holders as a result.
test('a live holder is never evicted, however long it has held', () => {
  const root = makeProjectRoot('bubo-lock-longhold-')
  ensureProjectState(root)
  const ancient = Date.now() - 86400000 // a day
  const lockPath = plantLock(root, `tok ${process.pid} ${ancient}`)

  assert.throws(() => lock.acquire(buboDir(root), { timeoutMs: 200 }), /Timed out/i)
  assert.ok(fs.existsSync(lockPath))
  assert.equal(lock.readOwner(lockPath).pid, process.pid)
})

test('unlock refuses while the owning process is alive', () => {
  const root = makeProjectRoot('bubo-unlock-live-')
  ensureProjectState(root)
  const lockPath = plantLock(root, `tok ${process.pid} ${Date.now()}`)

  const result = lock.unlock(buboDir(root))
  assert.equal(result.cleared, false)
  assert.match(result.reason, /still running/)
  assert.ok(fs.existsSync(lockPath))
})

test('unlock clears a lock whose owner is gone', () => {
  const root = makeProjectRoot('bubo-unlock-dead-')
  ensureProjectState(root)
  const lockPath = plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)

  assert.equal(lock.unlock(buboDir(root)).cleared, true)
  assert.equal(fs.existsSync(lockPath), false)
})

test('unlock --force overrides a live owner', () => {
  const root = makeProjectRoot('bubo-unlock-force-')
  ensureProjectState(root)
  plantLock(root, `tok ${process.pid} ${Date.now()}`)

  assert.equal(lock.unlock(buboDir(root), { force: true }).cleared, true)
})

test('unlock on an unlocked store is a no-op', () => {
  const root = makeProjectRoot('bubo-unlock-none-')
  ensureProjectState(root)
  const result = lock.unlock(buboDir(root))
  assert.equal(result.cleared, false)
  assert.equal(result.reason, 'no lock held')
})

test('after unlock, writers proceed normally', () => {
  const root = makeProjectRoot('bubo-unlock-then-write-')
  ensureProjectState(root)
  plantLock(root, `dead ${DEAD_PID} ${Date.now()}`)
  lock.unlock(buboDir(root))

  const created = createReview(root, {
    reason: 'manual', rendered: 'x', problem: 'p', evidence: 'e', solution: 's', context: {}
  })
  assert.equal(created.id, 1)
})

test('only one of two acquirers holds the lock at a time', () => {
  const root = makeProjectRoot('bubo-lock-exclusive-')
  ensureProjectState(root)
  const dir = buboDir(root)

  const first = lock.acquire(dir, { timeoutMs: 500 })
  assert.throws(() => lock.acquire(dir, { timeoutMs: 200 }), /Timed out/i)
  lock.release(first)

  const second = lock.acquire(dir, { timeoutMs: 500 })
  assert.equal(lock.readOwner(second.lockPath).token, second.token)
  lock.release(second)
})

test('releasing a lock that was force-cleared does not delete a successor', () => {
  const root = makeProjectRoot('bubo-lock-successor-')
  ensureProjectState(root)
  const dir = buboDir(root)

  const first = lock.acquire(dir, { timeoutMs: 500 })
  lock.unlock(dir, { force: true })
  const successor = lock.acquire(dir, { timeoutMs: 500 })

  lock.release(first) // stale handle
  assert.ok(fs.existsSync(successor.lockPath), 'the successor still holds the lock')
  assert.equal(lock.readOwner(successor.lockPath).token, successor.token)
  lock.release(successor)
})

test('concurrent writers never share an id', () => {
  const root = makeProjectRoot('bubo-lock-concurrent-')
  ensureProjectState(root)

  const storePath = path.join(__dirname, '..', 'scripts', 'lib', 'store.js')
  const gate = path.join(root, 'go')
  const worker = `
    const fs = require('node:fs')
    const { createReview } = require(${JSON.stringify(storePath)})
    const [root, gate] = process.argv.slice(1)
    const giveUpAt = Date.now() + 30000
    while (!fs.existsSync(gate)) {
      if (Date.now() > giveUpAt) throw new Error('barrier never opened')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    }
    for (let i = 0; i < 5; i += 1) {
      createReview(root, {
        reason: 'manual', rendered: 'c', problem: 'p', evidence: 'e', solution: 's', context: {}
      })
    }
  `

  const workers = Array.from({ length: 6 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', worker, root, gate], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      // Surface the worker's own error; "exit 1" alone is undebuggable.
      child.on('exit', (code) => (
        code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${stderr.trim()}`))
      ))
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
