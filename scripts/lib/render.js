function normalizeSentence(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function normalizeReview(input) {
  const review = {
    id: input.id,
    problem: normalizeSentence(input.problem),
    evidence: normalizeSentence(input.evidence),
    solution: normalizeSentence(input.solution)
  }

  review.rendered = `${review.problem} ${review.evidence} ${review.solution}`
    .replace(/\s+/g, ' ')
    .trim()

  return review
}

function renderReviewLine(review) {
  return `Code Review [${review.id}]: ${review.rendered}`
}

module.exports = { normalizeReview, renderReviewLine }
