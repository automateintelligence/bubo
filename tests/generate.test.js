const test = require('node:test')
const assert = require('node:assert/strict')

const { generateReview } = require('../scripts/lib/generate')

test('generator emits a sentinel-id collision review from diff evidence', async () => {
  const review = await generateReview({
    reason: 'large-diff',
    diffExcerpt: 'const draft = { alert_id: 0, status: "pending" }',
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['alerts.ts']
  }, { provider: { kind: 'heuristic' } })

  assert.match(review.problem, /collide|collision/i)
  assert.match(review.evidence, /alert_id: 0|fixed sentinel/i)
  assert.match(review.solution, /unique temporary|reconcile/i)
})
