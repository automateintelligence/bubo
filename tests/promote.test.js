const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReview, readReviews } = require('../scripts/lib/store')
const { promoteReview } = require('../scripts/lib/promote')

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
