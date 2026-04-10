const test = require('node:test')
const assert = require('node:assert/strict')

const { BUBO_PERSONALITY, renderReviewLine, normalizeReview } = require('../scripts/lib/render')

test('rendered review line uses the stored short rendered field while preserving structured review fields', () => {
  const review = normalizeReview({
    id: 213,
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts.',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution.',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns.',
    rendered: 'sentinel id. race bait. mint a temp id first'
  })

  assert.equal(review.problem, 'placeholder alert_id=0 can collide under concurrent speculative bursts.')
  assert.equal(review.evidence, 'the diff introduces a fixed sentinel before VLM resolution.')
  assert.equal(review.solution, 'allocate a unique temporary client-side ID and reconcile after VLM returns.')
  assert.equal(review.rendered, 'sentinel id. race bait. mint a temp id first')
  assert.equal(
    renderReviewLine(review),
    'Bubo Says [213]: sentinel id. race bait. mint a temp id first'
  )
})

test('Bubo personality is fixed and globally shared', () => {
  assert.equal(
    BUBO_PERSONALITY,
    'Bubo is an ancient golden war-owl: precise, patient, mildly amused by avoidable chaos, and prone to clipped verdicts like he already watched this bug ruin Argos once.'
  )
})
