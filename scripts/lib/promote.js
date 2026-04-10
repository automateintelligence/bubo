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

function findReview(root, id) {
  const reviews = readReviews(root)
  const resolvedId = resolveReviewId(root, id)
  const review = reviews.find((item) => item.id === resolvedId)

  if (!review) {
    throw new Error(`Review ${id} not found`)
  }

  return { review, reviews }
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
