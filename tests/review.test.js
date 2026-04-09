const test = require('node:test')
const assert = require('node:assert/strict')

const { renderReviewLine, normalizeReview } = require('../scripts/lib/render')

test('rendered review line omits labels but preserves problem, evidence, and solution order', () => {
  const review = normalizeReview({
    id: 213,
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts.',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution.',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns.'
  })

  assert.equal(
    renderReviewLine(review),
    'Code Review [213]: placeholder alert_id=0 can collide under concurrent speculative bursts. the diff introduces a fixed sentinel before VLM resolution. allocate a unique temporary client-side ID and reconcile after VLM returns.'
  )
})
