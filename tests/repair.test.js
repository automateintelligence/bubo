const test = require('node:test')
const assert = require('node:assert/strict')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyRepair, planRepair, repairStore, resolveStore } = require('../tools/repair-bubo-ids')
const { makeProjectRoot } = require('./helpers')

function record(id, timestamp, rendered) {
  return JSON.stringify({ id, timestamp, status: 'new', rendered })
}

// The shape observed in securitysight: one id owning several records written
// weeks apart, after the counter rewound past ids that were already taken.
const DUPLICATED = [
  record(12, '2026-06-30T06:20:50.989Z', 'stale deploy-backend note'),
  record(13, '2026-07-01T00:00:00.000Z', 'unique note'),
  record(12, '2026-07-08T23:48:51.497Z', 'zoomable image note'),
  record(12, '2026-07-20T04:21:30.208Z', 'labels note')
].join('\n') + '\n'

test('the earliest record in a duplicated group keeps its id', () => {
  const { reassignments } = planRepair(DUPLICATED)

  assert.equal(reassignments.length, 2)
  // 2026-06-30 is oldest, so it is the one that keeps id 12.
  const keptIds = reassignments.map((r) => r.entry.review.rendered)
  assert.ok(!keptIds.includes('stale deploy-backend note'))
})

test('reassigned ids are allocated above the store high-water mark, oldest first', () => {
  const { reassignments } = planRepair(DUPLICATED)

  assert.deepEqual(
    reassignments.map((r) => [r.entry.review.rendered, r.to]),
    [['zoomable image note', 14], ['labels note', 15]]
  )
})

test('repair makes every id unique without losing or reordering records', () => {
  const { content } = applyRepair(DUPLICATED)
  const lines = content.split('\n').filter(Boolean)
  const reviews = lines.map((line) => JSON.parse(line))

  assert.equal(reviews.length, 4, 'no record may be dropped')
  assert.equal(new Set(reviews.map((r) => r.id)).size, 4, 'every id must be unique')
  // File order preserved, so the append-only history still reads chronologically.
  assert.deepEqual(reviews.map((r) => r.rendered), [
    'stale deploy-backend note',
    'unique note',
    'zoomable image note',
    'labels note'
  ])
  // Everything except the id is carried through untouched.
  assert.equal(reviews[3].timestamp, '2026-07-20T04:21:30.208Z')
  assert.equal(reviews[3].status, 'new')
})

test('a store with unique ids is left byte-identical', () => {
  const clean = [
    record(1, '2026-07-01T00:00:00.000Z', 'one'),
    record(2, '2026-07-02T00:00:00.000Z', 'two')
  ].join('\n') + '\n'

  const { content, plan } = applyRepair(clean)
  assert.equal(plan.reassignments.length, 0)
  assert.equal(content, clean)
})

test('unparseable lines are preserved in place rather than dropped', () => {
  const withDamage = [
    record(1, '2026-07-01T00:00:00.000Z', 'one'),
    '{"id": 1, "timestamp": truncated',
    record(1, '2026-07-02T00:00:00.000Z', 'two')
  ].join('\n') + '\n'

  const { content, plan } = applyRepair(withDamage)
  const lines = content.split('\n').filter(Boolean)

  assert.equal(plan.damaged.length, 1)
  assert.equal(lines.length, 3, 'the damaged line must survive')
  assert.equal(lines[1], '{"id": 1, "timestamp": truncated')
  assert.equal(JSON.parse(lines[2]).id, 2, 'parseable duplicate still gets a fresh id')
})

test('an empty store is handled without error', () => {
  const { content, plan } = applyRepair('')
  assert.equal(content, '')
  assert.equal(plan.reassignments.length, 0)
})

// --- Review findings: repair correctness and safety ---

// The old lookup was Array.find(), which returns the FIRST record in file order.
// Choosing the keeper by timestamp moved the id to a different note whenever a
// store's file order and timestamp order disagreed.
test('the keeper is the first record in file order, not the oldest timestamp', () => {
  const reversed = [
    record(7, '2026-07-20T00:00:00.000Z', 'first-in-file'),
    record(7, '2026-06-01T00:00:00.000Z', 'second-in-file')
  ].join('\n') + '\n'

  const { content } = applyRepair(reversed)
  const reviews = content.split('\n').filter(Boolean).map((line) => JSON.parse(line))

  assert.equal(reviews[0].rendered, 'first-in-file')
  assert.equal(reviews[0].id, 7, 'the record legacy lookup resolved to must keep the id')
  assert.notEqual(reviews[1].id, 7)
})

test('lines that parse to non-objects are damaged, not records', () => {
  const weird = [
    record(1, '2026-07-01T00:00:00.000Z', 'ok'),
    'null',
    '42',
    '"a string"',
    record(1, '2026-07-02T00:00:00.000Z', 'dup')
  ].join('\n') + '\n'

  const { content, plan } = applyRepair(weird)
  const lines = content.split('\n').filter(Boolean)

  assert.equal(plan.damaged.length, 3, 'null, number and string are not reviews')
  assert.equal(lines.length, 5, 'every line survives')
  assert.equal(lines[1], 'null')
})

test('equal timestamps order by numeric index, not string collation', () => {
  const same = '2026-07-01T00:00:00.000Z'
  const lines = [record(1, same, 'idx0')]
  for (let i = 1; i <= 11; i += 1) lines.push(record(1, same, `idx${i}`))

  const plan = planRepair(lines.join('\n') + '\n')
  const order = plan.reassignments.map((r) => r.entry.index)
  const ascending = [...order].sort((a, b) => a - b)
  assert.deepEqual(order, ascending, 'index 10 must not sort before index 2')
})

test('repair refuses to follow a symlinked store', () => {
  const dir = makeProjectRoot('bubo-repair-symlink-')
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  const real = path.join(dir, 'elsewhere.jsonl')
  fs.writeFileSync(real, DUPLICATED)
  fs.symlinkSync(real, path.join(bubo, 'reviews.jsonl'))

  const store = resolveStore(dir)
  assert.throws(() => repairStore(store, true), /symlink/i)
})

test('repair waits on a held store lock instead of racing it', () => {
  const dir = makeProjectRoot('bubo-repair-lock-')
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  fs.writeFileSync(path.join(bubo, 'reviews.jsonl'), DUPLICATED)
  // A live session holds the lock, and it is fresh, so it is not stale.
  fs.mkdirSync(path.join(bubo, '.lock'))
  fs.writeFileSync(path.join(bubo, '.lock', 'owner'), 'someone-else\n')

  const store = resolveStore(dir)
  assert.throws(() => repairStore(store, true, { lockTimeoutMs: 200 }), /Timed out waiting for the Bubo store lock/i)
})

// --- Second review round: repair safety and fidelity ---

// pruneState mutated state.json while holding the REVIEW lock, but session and
// cooldown writers take no lock at all, so a concurrent bubo start/stop could be
// silently overwritten. Allocation ignores nextId entirely, so the safe fix is
// to stop touching state.json at all.
test('repair does not modify state.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-repair-state-'))
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  fs.writeFileSync(path.join(bubo, 'reviews.jsonl'), DUPLICATED)
  const statePath = path.join(bubo, 'state.json')
  const original = JSON.stringify({ nextId: 274, enabled: false, dedup: [] }, null, 2) + '\n'
  fs.writeFileSync(statePath, original)

  repairStore(resolveStore(dir), true)

  assert.equal(fs.readFileSync(statePath, 'utf8'), original, 'state.json must be left alone')
  const leftovers = fs.readdirSync(bubo).filter((n) => n.startsWith('state.json.'))
  assert.deepEqual(leftovers, [], 'no state temp files may be created')
})

// A record whose id is not a usable positive integer can never be addressed by
// `implement <id>`, so repair has to give it a real one.
test('records with unusable ids are reassigned so they become reachable', () => {
  const odd = [
    JSON.stringify({ id: 1, timestamp: '2026-07-01T00:00:00.000Z', rendered: 'fine' }),
    JSON.stringify({ id: 'seven', timestamp: '2026-07-02T00:00:00.000Z', rendered: 'string id' }),
    JSON.stringify({ timestamp: '2026-07-03T00:00:00.000Z', rendered: 'missing id' }),
    JSON.stringify({ id: 0, timestamp: '2026-07-04T00:00:00.000Z', rendered: 'zero id' }),
    JSON.stringify({ id: -3, timestamp: '2026-07-05T00:00:00.000Z', rendered: 'negative id' })
  ].join('\n') + '\n'

  const { content } = applyRepair(odd)
  const reviews = content.split('\n').filter(Boolean).map((line) => JSON.parse(line))

  assert.equal(reviews.length, 5)
  reviews.forEach((review) => {
    assert.ok(Number.isSafeInteger(review.id) && review.id > 0, `unusable id: ${review.id}`)
  })
  assert.equal(new Set(reviews.map((r) => r.id)).size, 5, 'and all distinct')
})

// Repair should be a minimal edit. Reserializing every record rewrites bytes it
// was never asked to touch, and dropping blank lines mutates the file further.
test('records that keep their id keep their exact original bytes', () => {
  const spaced = '{"id":1,  "rendered":"odd  spacing",   "timestamp":"2026-07-01T00:00:00.000Z"}'
  const raw = [spaced, record(2, '2026-07-02T00:00:00.000Z', 'two')].join('\n') + '\n'

  const { content, plan } = applyRepair(raw)
  assert.equal(plan.reassignments.length, 0)
  assert.equal(content, raw, 'an unaffected store must be byte-identical')
})

test('blank lines are preserved rather than silently dropped', () => {
  const raw = [
    record(1, '2026-07-01T00:00:00.000Z', 'one'),
    '',
    record(1, '2026-07-02T00:00:00.000Z', 'dup')
  ].join('\n') + '\n'

  const { content } = applyRepair(raw)
  assert.equal(content.split('\n').length, raw.split('\n').length, 'line count preserved')
})

// Math.max(...ids) blows the argument limit on a large store.
test('a large store does not exceed the argument limit', () => {
  const many = Array.from({ length: 150000 }, (_, i) =>
    record(i + 1, `2026-07-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`, `n${i}`)
  ).join('\n') + '\n'

  assert.doesNotThrow(() => planRepair(many))
})
