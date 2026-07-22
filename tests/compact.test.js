const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { compact, resolveStore } = require('../tools/compact-bubo-store')

function store(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-compact-'))
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  fs.writeFileSync(path.join(bubo, 'reviews.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { dir, reviews: path.join(bubo, 'reviews.jsonl') }
}

test('compaction drops the recursive recentReviews payload', async () => {
  const bloated = {
    id: 2, timestamp: 't', reason: 'test-fail', rendered: 'r', problem: 'p',
    context: {
      reason: 'test-fail',
      recentReviews: [
        { id: 1, problem: 'prior', rendered: 'x', context: { toolOutputExcerpt: 'Q'.repeat(2_000_000) } }
      ]
    }
  }
  const s = store([{ id: 1, timestamp: 't', rendered: 'a', context: {} }, bloated])

  const result = await compact(s.reviews)
  assert.ok(result.after < result.before, 'file shrank')
  assert.ok(result.after < 5000, `still ${result.after} bytes`)

  const records = result.content.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(records.length, 2, 'no record dropped')
  const compacted = records.find((r) => r.id === 2)
  assert.equal('context' in compacted.context.recentReviews[0], false)
  // Addressable fields preserved.
  assert.equal(compacted.id, 2)
  assert.equal(compacted.rendered, 'r')
})

test('ids, timestamps and rendered notes are preserved exactly', async () => {
  const s = store([
    { id: 7, timestamp: '2026-07-01T00:00:00Z', reason: 'turn', rendered: 'keep me', problem: 'p',
      context: { diffExcerpt: 'D'.repeat(100000) } }
  ])
  const result = await compact(s.reviews)
  const record = JSON.parse(result.content.trim())
  assert.equal(record.id, 7)
  assert.equal(record.timestamp, '2026-07-01T00:00:00Z')
  assert.equal(record.rendered, 'keep me')
  assert.ok(record.context.diffExcerpt.length < 9000, 'oversized excerpt capped')
})

test('an already-lean store is left effectively unchanged', async () => {
  const s = store([
    { id: 1, timestamp: 't', reason: 'turn', rendered: 'a', context: { diffExcerpt: 'short' } }
  ])
  const result = await compact(s.reviews)
  assert.equal(result.compacted, 0)
  const record = JSON.parse(result.content.trim())
  assert.equal(record.context.diffExcerpt, 'short')
})

test('unparseable lines survive compaction verbatim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-compact-damaged-'))
  const bubo = path.join(dir, '.bubo')
  fs.mkdirSync(bubo)
  const reviews = path.join(bubo, 'reviews.jsonl')
  fs.writeFileSync(reviews, [
    JSON.stringify({ id: 1, rendered: 'ok', context: { diffExcerpt: 'D'.repeat(100000) } }),
    '{"id": 2, broken',
    JSON.stringify({ id: 3, rendered: 'also ok', context: {} })
  ].join('\n') + '\n')

  const result = await compact(reviews)
  assert.equal(result.damaged, 1)
  const lines = result.content.split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  assert.equal(lines[1], '{"id": 2, broken')
})

test('resolveStore accepts a project dir or a .bubo dir', () => {
  const s = store([{ id: 1, rendered: 'a' }])
  assert.ok(resolveStore(s.dir))
  assert.ok(resolveStore(path.join(s.dir, '.bubo')))
  assert.equal(resolveStore(path.join(s.dir, 'nope')), null)
})
