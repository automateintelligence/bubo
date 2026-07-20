const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { appendReview, createReview, ensureProjectState, readReviews } = require('../scripts/lib/store')
const { considerReview, promoteReview } = require('../scripts/lib/promote')

// Build the exact shape observed in the wild: one id owned by several records,
// oldest first, after a counter rewind reused numbers that were already taken.
function seedDuplicateIds(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  ensureProjectState(root)
  appendReview(root, {
    id: 12,
    timestamp: '2026-06-30T06:20:50.989Z',
    status: 'new',
    rendered: 'stale deploy-backend note',
    problem: 'old', evidence: 'old', solution: 'old'
  })
  appendReview(root, {
    id: 12,
    timestamp: '2026-07-20T04:21:30.208Z',
    status: 'new',
    rendered: 'recent labels note',
    problem: 'new', evidence: 'new', solution: 'new'
  })
  return root
}

test('promotion resolves review by ID and marks it promoted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-promote-'))
  const created = createReview(root, {
    reason: 'manual',
    rendered: 'test review',
    problem: 'p',
    evidence: 'e',
    solution: 's',
    context: {}
  })
  const promoted = promoteReview(root, created.id)

  assert.equal(promoted.id, created.id)
  assert.equal(promoted.status, 'promoted')
  assert.match(promoted.taskPrompt, /Problem:/)
  const stored = readReviews(root).find((item) => item.id === created.id)
  assert.equal(stored.status, 'promoted')
})

test('consideration resolves review by ID without promoting it and returns a receiving-code-review prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-consider-lib-'))
  const created = createReview(root, {
    reason: 'manual',
    rendered: 'test review',
    problem: 'p',
    evidence: 'e',
    solution: 's',
    context: {}
  })

  const considered = considerReview(root, created.id)

  assert.equal(considered.id, created.id)
  assert.equal(considered.status, 'new')
  assert.match(considered.taskPrompt, /\$receiving-code-review/)
  assert.match(considered.taskPrompt, /Do not implement anything yet/i)
  const stored = readReviews(root).find((item) => item.id === created.id)
  assert.equal(stored.status, 'new')
})

// Silently taking the oldest match is how a three-week-stale note gets handed
// back as if it were the note the user just read.
test('promotion refuses an ambiguous id instead of taking the oldest match', () => {
  const root = seedDuplicateIds('bubo-promote-ambiguous-')

  assert.throws(() => promoteReview(root, 12), (error) => {
    assert.match(error.message, /ambiguous/i)
    assert.match(error.message, /2/)
    // The candidates must be identifiable, or the user cannot pick one.
    assert.match(error.message, /2026-06-30/)
    assert.match(error.message, /2026-07-20/)
    return true
  })

  // Nothing may be mutated by a refused promotion.
  assert.deepEqual(readReviews(root).map((item) => item.status), ['new', 'new'])
})

test('consideration refuses an ambiguous id instead of taking the oldest match', () => {
  const root = seedDuplicateIds('bubo-consider-ambiguous-')

  assert.throws(() => considerReview(root, 12), /ambiguous/i)
})

test('an unambiguous id still resolves when other ids are duplicated', () => {
  const root = seedDuplicateIds('bubo-promote-mixed-')
  appendReview(root, {
    id: 13,
    timestamp: '2026-07-21T00:00:00.000Z',
    status: 'new',
    rendered: 'unique note',
    problem: 'p', evidence: 'e', solution: 's'
  })

  const promoted = promoteReview(root, 13)
  assert.equal(promoted.id, 13)
  assert.equal(promoted.status, 'promoted')
})
