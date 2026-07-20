const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { spawn } = require('node:child_process')

const {
  ensureProjectState,
  appendReview,
  createReview,
  readReviews,
  readState,
  withLock
} = require('../scripts/lib/store')

function makePayload(label) {
  return {
    reason: 'manual',
    rendered: label,
    problem: 'p',
    evidence: 'e',
    solution: 's',
    context: {}
  }
}

test('store creates .bubo and appends project-scoped reviews', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-store-'))
  ensureProjectState(root)
  appendReview(root, { id: 1, rendered: 'first review', status: 'new' })
  const reviews = readReviews(root)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].rendered, 'first review')
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))
})

test('store defaults Bubo session state to enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-state-'))
  ensureProjectState(root)
  const state = readState(root)
  assert.equal(state.enabled, true)
})

// The store is the only durable record of which ids are taken. state.json is
// rewritten constantly and has been observed to rewind; reviews.jsonl is
// append-only and never resets, so ids must be derived from it.
test('review ids keep climbing after state.json is reset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-id-reset-'))
  createReview(root, makePayload('one'))
  createReview(root, makePayload('two'))
  const third = createReview(root, makePayload('three'))
  assert.equal(third.id, 3)

  // Simulate the observed failure: state.json rewound to a fresh default while
  // reviews.jsonl kept every record.
  fs.writeFileSync(
    path.join(root, '.bubo', 'state.json'),
    JSON.stringify({ nextId: 1, lastTriggerAt: {}, dedup: [], enabled: true }, null, 2)
  )

  const fourth = createReview(root, makePayload('four'))
  assert.equal(fourth.id, 4)
  assert.equal(new Set(readReviews(root).map((r) => r.id)).size, 4)
})

// Monotonic issuance must survive a promote, which is the only operation that
// rewrites reviews.jsonl in place. If it dropped or reordered a record the max
// could fall and a later note could reuse a number already handed out.
test('ids stay strictly increasing across a promotion', () => {
  const { promoteReview } = require('../scripts/lib/promote')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-id-monotonic-'))

  const first = createReview(root, makePayload('one'))
  const second = createReview(root, makePayload('two'))
  const third = createReview(root, makePayload('three'))

  // Promote a middle record, then keep creating.
  promoteReview(root, second.id)

  const fourth = createReview(root, makePayload('four'))
  const fifth = createReview(root, makePayload('five'))

  const issued = [first, second, third, fourth, fifth].map((r) => r.id)
  assert.deepEqual(issued, [1, 2, 3, 4, 5], 'every id strictly greater than the last')

  // Promotion must not have dropped a record or rewound the high-water mark.
  const stored = readReviews(root)
  assert.equal(stored.length, 5)
  assert.equal(Math.max(...stored.map((r) => r.id)), 5)
  assert.equal(stored.find((r) => r.id === second.id).status, 'promoted')
})

test('review ids keep climbing after state.json is corrupted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-id-corrupt-'))
  createReview(root, makePayload('one'))
  createReview(root, makePayload('two'))

  // A truncated write — what an interrupted writeFileSync leaves behind.
  fs.writeFileSync(path.join(root, '.bubo', 'state.json'), '{"nextId": 3, "dedup": [')

  const third = createReview(root, makePayload('three'))
  assert.equal(third.id, 3)
  assert.equal(new Set(readReviews(root).map((r) => r.id)).size, 3)
})

test('a corrupt state.json is reported, not silently treated as a fresh start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-state-corrupt-'))
  ensureProjectState(root)
  fs.writeFileSync(path.join(root, '.bubo', 'state.json'), '{"enabled": fal')

  assert.throws(() => readState(root), /corrupt/i)
})

test('a missing state.json is still an ordinary fresh start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-state-missing-'))
  ensureProjectState(root)
  fs.rmSync(path.join(root, '.bubo', 'state.json'))

  assert.equal(readState(root).enabled, true)
})

test('concurrent createReview calls never share an id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-id-race-'))
  ensureProjectState(root)

  const storePath = path.join(__dirname, '..', 'scripts', 'lib', 'store.js')
  const gate = path.join(root, 'go')

  // Node takes tens of milliseconds to boot, which is long enough that plainly
  // spawned workers finish one after another and never contend. Hold every
  // worker at a barrier, then have each write repeatedly so the windows overlap.
  const worker = `
    const fs = require('node:fs')
    const { createReview } = require(${JSON.stringify(storePath)})
    const [root, gate] = process.argv.slice(1)
    while (!fs.existsSync(gate)) { /* spin until released */ }
    for (let i = 0; i < 20; i += 1) {
      createReview(root, {
        reason: 'manual', rendered: 'race', problem: 'p', evidence: 'e', solution: 's', context: {}
      })
    }
  `

  const workers = Array.from({ length: 8 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', worker, root, gate], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))))
    })
  )

  // Let every worker reach the barrier, then release them together.
  return new Promise((resolve) => setTimeout(resolve, 300))
    .then(() => fs.writeFileSync(gate, ''))
    .then(() => Promise.all(workers))
    .then(() => {
      const ids = readReviews(root).map((review) => review.id)
      assert.equal(ids.length, 160)
      const collisions = ids.filter((id, i) => ids.indexOf(id) !== i)
      assert.equal(new Set(ids).size, 160, `${collisions.length} ids collided`)
    })
})

// --- Review findings: concurrency and lock correctness ---

// ensureProjectState ran outside the lock and initialized files with a
// non-exclusive existsSync/writeFileSync. Two first writers could both see "no
// file", and the second's write truncated the first's already-appended review.
// The earlier race test pre-initialized the store, which hid exactly this.
test('concurrent first use never truncates the store or duplicates id 1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-first-use-race-'))
  // Deliberately do NOT call ensureProjectState — first use is the failure window.
  const storePath = path.join(__dirname, '..', 'scripts', 'lib', 'store.js')
  const gate = path.join(root, 'go')

  const worker = `
    const fs = require('node:fs')
    const { createReview } = require(${JSON.stringify(storePath)})
    const [root, gate] = process.argv.slice(1)
    while (!fs.existsSync(gate)) {}
    createReview(root, {
      reason: 'manual', rendered: 'first-use', problem: 'p', evidence: 'e', solution: 's', context: {}
    })
  `

  const workers = Array.from({ length: 8 }, () =>
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
      assert.equal(ids.length, 8, 'no review may be truncated away')
      assert.equal(new Set(ids).size, 8, `ids collided: ${ids.join(', ')}`)
    })
})

// A crash between creating the lock and writing its owner file left a lock with
// no recorded holder. Staleness was read from the owner file, so an ownerless
// lock was never stale and every later writer timed out forever.
test('a lock with no owner record is eventually broken, not deadlocked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-ownerless-lock-'))
  ensureProjectState(root)
  const lockPath = path.join(root, '.bubo', '.lock')
  fs.mkdirSync(lockPath)
  // Backdate past the stale threshold so the test does not sit through it.
  const longAgo = new Date(Date.now() - 60000)
  fs.utimesSync(lockPath, longAgo, longAgo)

  const created = createReview(root, makePayload('after ownerless lock'))
  assert.equal(created.id, 1)
  assert.equal(readReviews(root).length, 1)
})

// Breaking a stale lock used a blind recursive delete, so a contender could
// remove a lock another contender had just legitimately acquired, and the
// original holder's release could delete its successor's lock.
test('releasing a lock does not delete a successor lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-lock-ownership-'))
  ensureProjectState(root)
  const lockPath = path.join(root, '.bubo', '.lock')

  let observed = null
  withLock(root, () => {
    // Simulate a stale-breaker taking over mid-hold: the lock we are about to
    // release is no longer ours.
    fs.rmSync(lockPath, { recursive: true, force: true })
    fs.mkdirSync(lockPath)
    fs.writeFileSync(path.join(lockPath, 'owner'), 'someone-else 0\n')
    observed = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')
  })

  assert.ok(fs.existsSync(lockPath), 'successor lock must survive our release')
  assert.equal(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8'), observed)
  fs.rmSync(lockPath, { recursive: true, force: true })
})

test('id allocation refuses to run past the safe integer ceiling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-id-ceiling-'))
  ensureProjectState(root)
  appendReview(root, { id: Number.MAX_SAFE_INTEGER, timestamp: '2026-07-20T00:00:00Z', status: 'new', rendered: 'ceiling' })

  assert.throws(() => createReview(root, makePayload('overflow')), /safe integer|ceiling|exhausted/i)
})
