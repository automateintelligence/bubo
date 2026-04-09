const { readReviews, rewriteReviews } = require('./store')

function promoteReview(root, id) {
  const reviews = readReviews(root)
  const review = reviews.find((item) => item.id === Number(id))

  if (!review) {
    throw new Error(`Review ${id} not found`)
  }

  review.status = 'promoted'
  review.taskPrompt = `Implement Bubo review ${review.id}.\nProblem: ${review.problem}\nEvidence: ${review.evidence}\nSolution: ${review.solution}`
  rewriteReviews(root, reviews)
  return review
}

module.exports = { promoteReview }
