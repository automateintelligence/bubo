const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureProjectState, appendReview, readReviews, readState } = require('../scripts/lib/store')

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
