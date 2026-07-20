const { readReviews, rewriteReviews } = require('./store')

function resolveReviewId(root, id) {
  if (id === 'last') {
    const reviews = readReviews(root)
    const review = reviews.at(-1)

    if (!review) {
      throw new Error('No reviews found for this project')
    }

    return review.id
  }

  return Number(id)
}

function describeCandidate(review) {
  const rendered = String(review.rendered || '').slice(0, 60)
  return `  ${review.timestamp || 'unknown time'}  ${rendered}`
}

// Stores written before ids were derived from reviews.jsonl can hold several
// records under one id. Taking the first match silently returns the oldest,
// which is how a long-since-shipped note gets handed back as current work.
// Refuse instead, and show enough for the user to identify the one they meant.
function findReview(root, id) {
  const reviews = readReviews(root)
  const resolvedId = resolveReviewId(root, id)
  const matches = reviews.filter((item) => item.id === resolvedId)

  if (!matches.length) {
    throw new Error(`Review ${id} not found`)
  }

  if (matches.length > 1) {
    throw new Error(
      `Review ${resolvedId} is ambiguous: ${matches.length} records share this id.\n` +
      matches.map(describeCandidate).join('\n') + '\n' +
      '  Reassign unique ids with tools/repair-bubo-ids.js, then retry.'
    )
  }

  return { review: matches[0], reviews }
}

function buildConsiderationPrompt(review) {
  return [
    `Use $receiving-code-review before deciding whether to implement Bubo review ${review.id}.`,
    `Consider Bubo review ${review.id}.`,
    `Problem: ${review.problem}`,
    `Evidence: ${review.evidence}`,
    `Solution: ${review.solution}`,
    'Restate the requirement in your own words.',
    'Verify it against the codebase.',
    'Decide whether to implement, push back, or ask for clarification.',
    'Do not implement anything yet.'
  ].join('\n')
}

function promoteReview(root, id) {
  const { review, reviews } = findReview(root, id)

  review.status = 'promoted'
  review.taskPrompt = `Implement Bubo review ${review.id}.\nProblem: ${review.problem}\nEvidence: ${review.evidence}\nSolution: ${review.solution}`
  rewriteReviews(root, reviews)
  return review
}

function considerReview(root, id) {
  const { review } = findReview(root, id)

  return {
    ...review,
    taskPrompt: buildConsiderationPrompt(review)
  }
}

module.exports = { buildConsiderationPrompt, considerReview, promoteReview, resolveReviewId }
