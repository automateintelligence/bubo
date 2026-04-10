const BUBO_PERSONALITY = 'Bubo is an ancient golden war-owl: precise, patient, mildly amused by avoidable chaos, and prone to clipped verdicts like he already watched this bug ruin Argos once.'

function normalizeSentence(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function normalizeRendered(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
}

function compactFragment(value, maxWords = 6) {
  const text = String(value || '')
    .toLowerCase()
    .replace(/[^\w\s=-]/g, ' ')
    .replace(/\b(the|a|an|this|that|these|those|current|latest|new)\b/g, ' ')
    .replace(/\b(can|could|should|would|might|must|will|is|are|was|were|be|been|being)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return ''
  return text.split(' ').slice(0, maxWords).join(' ')
}

function buildRenderedFromStructured(review) {
  return [
    compactFragment(review.problem, 4),
    compactFragment(review.evidence, 5),
    compactFragment(review.solution, 6)
  ].filter(Boolean).join('. ')
}

function normalizeReview(input) {
  const review = {
    id: input.id,
    problem: normalizeSentence(input.problem),
    evidence: normalizeSentence(input.evidence),
    solution: normalizeSentence(input.solution)
  }

  review.rendered = normalizeRendered(input.rendered) || buildRenderedFromStructured(review)

  return review
}

function renderReviewLine(review) {
  return `Bubo Says [${review.id}]: ${review.rendered}`
}

module.exports = { BUBO_PERSONALITY, normalizeReview, renderReviewLine }
