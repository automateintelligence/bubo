const test = require('node:test')
const assert = require('node:assert/strict')

const { applyRepair, planRepair } = require('../tools/repair-bubo-ids')

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
