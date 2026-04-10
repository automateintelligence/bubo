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
  assert.equal(review.rendered, 'sentinel id. race bait. mint a temp id first')
})

test('generator stays silent when it has no concrete improvement to suggest', async () => {
  const review = await generateReview({
    reason: 'manual',
    diffExcerpt: 'const value = 1',
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['value.ts']
  }, { provider: { kind: 'heuristic' } })

  assert.equal(review, null)
})

test('generator emits a concrete large-diff review when changed lines cross threshold', async () => {
  const diffExcerpt = Array.from({ length: 81 }, (_, index) => `+ line ${index + 1}`).join('\n')
  const review = await generateReview({
    reason: 'large-diff',
    diffExcerpt,
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['alpha.ts', 'beta.ts']
  }, { provider: { kind: 'heuristic' }, largeDiffThreshold: 80 })

  assert.match(review.problem, /regression risk|wide change set|blast radius/i)
  assert.match(review.evidence, /81 changed lines/i)
  assert.match(review.solution, /verify|review|hot/i)
  assert.match(review.rendered, /big diff|wide diff/i)
})
