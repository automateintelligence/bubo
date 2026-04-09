const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('review command prints compact inline note and writes project-scoped log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-cli-'))
  const repoRoot = path.resolve(__dirname, '..')
  const result = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'review-code',
    '--reason', 'manual',
    '--project', root,
    '--diff-text', 'const draft = { alert_id: 0 }'
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Code Review \[\d+\]:/)
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))
})

test('record-review persists a structured passive note and prints the rendered line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-record-'))
  const repoRoot = path.resolve(__dirname, '..')
  const result = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'record-review',
    '--project', root,
    '--reason', 'turn',
    '--problem', 'a fixed sentinel id can collide under concurrency',
    '--evidence', 'the diff assigns alert_id = 0 before the async resolver returns',
    '--solution', 'use a unique temporary id and reconcile after resolution'
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Code Review \[\d+\]:/)

  const reviewsPath = path.join(root, '.bubo', 'reviews.jsonl')
  const lines = fs.readFileSync(reviewsPath, 'utf8').trim().split('\n')
  const review = JSON.parse(lines.at(-1))

  assert.equal(review.reason, 'turn')
  assert.match(review.problem, /sentinel id can collide/i)
  assert.match(review.evidence, /alert_id = 0/i)
  assert.match(review.solution, /unique temporary id/i)
})
