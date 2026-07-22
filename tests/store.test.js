const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { spawn } = require('node:child_process')
const { makeProjectRoot } = require('./helpers')

const {
  ensureProjectState,
  appendReview,
  createReview,
  readReviews,
  readState,
  rewriteReviews,
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
  const root = makeProjectRoot('bubo-store-')
  ensureProjectState(root)
  appendReview(root, { id: 1, rendered: 'first review', status: 'new' })
  const reviews = readReviews(root)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].rendered, 'first review')
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))
})

test('store defaults Bubo session state to enabled', () => {
  const root = makeProjectRoot('bubo-state-')
  ensureProjectState(root)
  const state = readState(root)
  assert.equal(state.enabled, true)
})

// The store is the only durable record of which ids are taken. state.json is
// rewritten constantly and has been observed to rewind; reviews.jsonl is
// append-only and never resets, so ids must be derived from it.
test('review ids keep climbing after state.json is reset', () => {
  const root = makeProjectRoot('bubo-id-reset-')
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
  const root = makeProjectRoot('bubo-id-monotonic-')

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
  const root = makeProjectRoot('bubo-id-corrupt-')
  createReview(root, makePayload('one'))
  createReview(root, makePayload('two'))

  // A truncated write — what an interrupted writeFileSync leaves behind.
  fs.writeFileSync(path.join(root, '.bubo', 'state.json'), '{"nextId": 3, "dedup": [')

  const third = createReview(root, makePayload('three'))
  assert.equal(third.id, 3)
  assert.equal(new Set(readReviews(root).map((r) => r.id)).size, 3)
})

test('a corrupt state.json is reported, not silently treated as a fresh start', () => {
  const root = makeProjectRoot('bubo-state-corrupt-')
  ensureProjectState(root)
  fs.writeFileSync(path.join(root, '.bubo', 'state.json'), '{"enabled": fal')

  assert.throws(() => readState(root), /corrupt/i)
})

test('a missing state.json is still an ordinary fresh start', () => {
  const root = makeProjectRoot('bubo-state-missing-')
  ensureProjectState(root)
  fs.rmSync(path.join(root, '.bubo', 'state.json'))

  assert.equal(readState(root).enabled, true)
})

test('concurrent createReview calls never share an id', () => {
  const root = makeProjectRoot('bubo-id-race-')
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
    // Bounded: a worker must never outlive its parent spinning on a gate that
    // will not arrive.
    const giveUpAt = Date.now() + 30000
    while (!fs.existsSync(gate)) {
      if (Date.now() > giveUpAt) throw new Error('barrier never opened')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    }
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

// --- Review findings: concurrency and store correctness ---
// Lock semantics themselves are covered in tests/lock.test.js; these cover the
// store behaviour built on top of it.

// ensureProjectState ran outside the lock and initialized files with a
// non-exclusive existsSync/writeFileSync. Two first writers could both see "no
// file", and the second's write truncated the first's already-appended review.
// The earlier race test pre-initialized the store, which hid exactly this.
test('concurrent first use never truncates the store or duplicates id 1', () => {
  const root = makeProjectRoot('bubo-first-use-race-')
  // Deliberately do NOT call ensureProjectState — first use is the failure window.
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
// An abandoned lock is never reclaimed automatically, so the store surfaces the
// actionable error rather than silently proceeding or hanging.
test('a store held by an abandoned lock reports how to recover', () => {
  const root = makeProjectRoot('bubo-store-stale-lock-')
  ensureProjectState(root)
  const lockPath = path.join(root, '.bubo', '.lock')
  fs.mkdirSync(lockPath)
  fs.writeFileSync(path.join(lockPath, 'owner'), `tok 4194304 ${Date.now()}\n`)

  assert.throws(
    () => withLock(root, () => 'nope', { timeoutMs: 200 }),
    /bubo unlock/,
    'the error must tell the operator how to clear it'
  )
  assert.ok(fs.existsSync(lockPath), 'and must not silently remove it')
  fs.rmSync(lockPath, { recursive: true, force: true })
})

test('id allocation refuses to run past the safe integer ceiling', () => {
  const root = makeProjectRoot('bubo-id-ceiling-')
  ensureProjectState(root)
  appendReview(root, { id: Number.MAX_SAFE_INTEGER, timestamp: '2026-07-20T00:00:00Z', status: 'new', rendered: 'ceiling' })

  assert.throws(() => createReview(root, makePayload('overflow')), /safe integer|ceiling|exhausted/i)
})

// --- Second review round: lock liveness, crash safety ---

// Time alone is a bad staleness signal: a holder doing legitimate slow work is
// declared dead at the threshold and has the store taken from under it. Liveness
// of the owning process is the signal that actually means "abandoned".
test('a failed rewrite leaves the original store intact', () => {
  const root = makeProjectRoot('bubo-rewrite-atomic-')
  createReview(root, makePayload('one'))
  createReview(root, makePayload('two'))
  const before = fs.readFileSync(path.join(root, '.bubo', 'reviews.jsonl'), 'utf8')

  // Block the temp path with a directory so the staged write cannot succeed.
  const tmpGuard = path.join(root, '.bubo', 'reviews.jsonl.tmp-guard')
  fs.mkdirSync(tmpGuard)

  assert.throws(() => rewriteReviews(root, [{ id: 1, rendered: 'clobbered' }], {
    tmpPath: tmpGuard
  }))

  const after = fs.readFileSync(path.join(root, '.bubo', 'reviews.jsonl'), 'utf8')
  assert.equal(after, before, 'the canonical file must be untouched by a failed rewrite')
})

test('a successful rewrite leaves no temp residue', () => {
  const root = makeProjectRoot('bubo-rewrite-residue-')
  createReview(root, makePayload('one'))
  const reviews = readReviews(root)
  reviews[0].status = 'promoted'
  rewriteReviews(root, reviews)

  const leftovers = fs.readdirSync(path.join(root, '.bubo')).filter((n) => n.includes('tmp'))
  assert.deepEqual(leftovers, [])
  assert.equal(readReviews(root)[0].status, 'promoted')
})

// --- Context bloat: recentReviews recursion ---

const { CONTEXT_TOTAL_CAP, clampContext, summarizeRecentReview } = require('../scripts/lib/store')

test('summarizeRecentReview keeps dedup and display fields, drops context', () => {
  const full = {
    id: 5, timestamp: 't', reason: 'test-fail', problem: 'p', rendered: 'r',
    evidence: 'e', solution: 's', status: 'new',
    context: { recentReviews: [{ big: 'x'.repeat(10000) }] }
  }
  const summary = summarizeRecentReview(full)
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'problem', 'reason', 'rendered', 'timestamp'])
  assert.equal('context' in summary, false)
})

test('clampContext strips context from recentReviews, killing the recursion', () => {
  const context = {
    reason: 'test-fail',
    recentReviews: [
      { id: 1, timestamp: 't', reason: 'r', problem: 'p', rendered: 'x',
        context: { recentReviews: [{ context: { huge: 'y'.repeat(1_000_000) } }] } }
    ]
  }
  const clamped = clampContext(context)
  assert.equal('context' in clamped.recentReviews[0], false, 'nested context removed')
  assert.ok(JSON.stringify(clamped).length < 1000, 'no megabyte payload survives')
  // Dedup fields preserved.
  assert.equal(clamped.recentReviews[0].problem, 'p')
})

test('clampContext caps oversized string fields', () => {
  const clamped = clampContext({ diffExcerpt: 'z'.repeat(50000) })
  assert.ok(clamped.diffExcerpt.length < 9000)
  assert.match(clamped.diffExcerpt, /truncated|\+\d+ chars/)
})

test('clampContext leaves a small context untouched', () => {
  const small = { reason: 'turn', cwd: '/x', diffExcerpt: 'short', recentReviews: [] }
  assert.deepEqual(clampContext(small), small)
})

// The total budget must hold under adversarial shapes the per-field cap alone
// misses: many capped fields, and a primitive-string context.
test('clampContext enforces a total byte budget across many fields', () => {
  const many = {}
  for (let i = 0; i < 1000; i += 1) many[`f${i}`] = 'x'.repeat(8000)
  const clamped = clampContext(many)
  assert.ok(Buffer.byteLength(JSON.stringify(clamped)) <= CONTEXT_TOTAL_CAP,
    `still ${Buffer.byteLength(JSON.stringify(clamped))} bytes`)
})

test('clampContext bounds a non-object context', () => {
  const clamped = clampContext('Q'.repeat(2_000_000))
  assert.ok(Buffer.byteLength(JSON.stringify(clamped)) <= CONTEXT_TOTAL_CAP)
  assert.equal(clamped.truncated, true)
})

test('clampContext bounds a single pathological field', () => {
  const clamped = clampContext({ blob: { nested: 'y'.repeat(5_000_000) } })
  assert.ok(Buffer.byteLength(JSON.stringify(clamped)) <= CONTEXT_TOTAL_CAP)
})

// Top-level free-text fields are bounded too; the store must not trust a caller.
test('createReview caps oversized record text fields', () => {
  const root = makeProjectRoot('bubo-record-text-')
  const created = createReview(root, {
    reason: 'manual',
    problem: 'P'.repeat(2_000_000),
    evidence: 'e', solution: 's', rendered: 'r', context: {}
  })
  const stored = readReviews(root).find((r) => r.id === created.id)
  assert.ok(stored.problem.length < 9000, `problem was ${stored.problem.length}`)
  assert.ok(JSON.stringify(stored).length < 20000)
})

test('a review created with a fat context is stored bounded', () => {
  const root = makeProjectRoot('bubo-context-clamp-')
  // A context shaped like the real recursion: recentReviews carrying nested context.
  const fatContext = {
    reason: 'test-fail',
    toolOutputExcerpt: 'ok',
    recentReviews: [
      { id: 1, problem: 'prior', rendered: 'r',
        context: { toolOutputExcerpt: 'Q'.repeat(2_000_000) } }
    ]
  }
  createReview(root, makePayload('note'))
  const created = createReview(root, { ...makePayload('note2'), context: fatContext })

  const raw = fs.readFileSync(path.join(root, '.bubo', 'reviews.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const stored = raw.find((r) => r.id === created.id)
  assert.ok(JSON.stringify(stored).length < 20000, 'record must not carry the 2MB blob')
  assert.equal('context' in stored.context.recentReviews[0], false)
})
