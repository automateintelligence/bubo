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
  assert.match(result.stdout, /Bubo Says \[\d+\]:/)
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))
})

test('review alias prints compact inline note and writes project-scoped log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-cli-review-'))
  const repoRoot = path.resolve(__dirname, '..')
  const result = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'review',
    '--reason', 'manual',
    '--project', root,
    '--diff-text', 'const draft = { alert_id: 0 }'
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Bubo Says \[\d+\]:/)
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
    '--solution', 'use a unique temporary id and reconcile after resolution',
    '--rendered', 'sentinel id. race bait. mint a temp id first'
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'Bubo Says [1]: sentinel id. race bait. mint a temp id first')

  const reviewsPath = path.join(root, '.bubo', 'reviews.jsonl')
  const lines = fs.readFileSync(reviewsPath, 'utf8').trim().split('\n')
  const review = JSON.parse(lines.at(-1))

  assert.equal(review.reason, 'turn')
  assert.match(review.problem, /sentinel id can collide/i)
  assert.match(review.evidence, /alert_id = 0/i)
  assert.match(review.solution, /unique temporary id/i)
  assert.equal(review.rendered, 'sentinel id. race bait. mint a temp id first')
})

test('review command creates a new review id on each allowed trigger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-repeat-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const first = spawnSync('node', [
    cli,
    'review-code',
    '--reason', 'manual',
    '--project', root,
    '--diff-text', 'const draft = { alert_id: 0 }'
  ], { encoding: 'utf8' })

  const second = spawnSync('node', [
    cli,
    'review-code',
    '--reason', 'manual',
    '--project', root,
    '--diff-text', 'const draft = { alert_id: 0 }'
  ], { encoding: 'utf8' })

  assert.equal(first.status, 0)
  assert.equal(second.status, 0)
  assert.match(first.stdout, /Bubo Says \[1\]:/)
  assert.match(second.stdout, /Bubo Says \[2\]:/)

  const reviewsPath = path.join(root, '.bubo', 'reviews.jsonl')
  const lines = fs.readFileSync(reviewsPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('review command stays silent when no concrete improvement is found', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-no-finding-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const result = spawnSync('node', [
    cli,
    'review',
    '--reason', 'manual',
    '--project', root,
    '--diff-text', 'const value = 1'
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'No review emitted: no concrete improvement found.')

  const reviewsPath = path.join(root, '.bubo', 'reviews.jsonl')
  assert.equal(fs.readFileSync(reviewsPath, 'utf8'), '')
})

test('session stop disables Bubo and session start re-enables it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const stop = spawnSync('node', [
    cli,
    'session',
    'stop',
    '--project', root
  ], { encoding: 'utf8' })

  const statusOff = spawnSync('node', [
    cli,
    'session',
    'status',
    '--project', root
  ], { encoding: 'utf8' })

  const start = spawnSync('node', [
    cli,
    'session',
    'start',
    '--project', root
  ], { encoding: 'utf8' })

  const statusOn = spawnSync('node', [
    cli,
    'session',
    'status',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(stop.status, 0)
  assert.equal(statusOff.status, 0)
  assert.equal(start.status, 0)
  assert.equal(statusOn.status, 0)
  assert.match(stop.stdout, /disabled/i)
  assert.match(statusOff.stdout, /disabled/i)
  assert.match(start.stdout, /enabled/i)
  assert.match(statusOn.stdout, /enabled/i)
})

test('implement hyphen alias promotes review by ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-implement-alias-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const review = spawnSync('node', [
    cli,
    'record-review',
    '--project', root,
    '--reason', 'turn',
    '--problem', 'a fixed sentinel id can collide under concurrency',
    '--evidence', 'the diff assigns alert_id = 0 before the async resolver returns',
    '--solution', 'use a unique temporary id and reconcile after resolution'
  ], { encoding: 'utf8' })

  assert.equal(review.status, 0)

  const result = spawnSync('node', [
    cli,
    'implement-1',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Implement Bubo review 1\./)
  assert.match(result.stdout, /Problem:/)
})

test('implement last promotes the most recent review in the current project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-implement-last-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  for (const suffix of ['first', 'second']) {
    const review = spawnSync('node', [
      cli,
      'record-review',
      '--project', root,
      '--reason', 'turn',
      '--problem', `problem ${suffix}`,
      '--evidence', `evidence ${suffix}`,
      '--solution', `solution ${suffix}`
    ], { encoding: 'utf8' })

    assert.equal(review.status, 0)
  }

  const result = spawnSync('node', [
    cli,
    'implement',
    'last',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Implement Bubo review 2\./)
  assert.match(result.stdout, /Problem: problem second\./)
})

test('consider command returns a receiving-code-review evaluation envelope without promoting the review', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-consider-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const review = spawnSync('node', [
    cli,
    'record-review',
    '--project', root,
    '--reason', 'turn',
    '--problem', 'a fixed sentinel id can collide under concurrency',
    '--evidence', 'the diff assigns alert_id = 0 before the async resolver returns',
    '--solution', 'use a unique temporary id and reconcile after resolution'
  ], { encoding: 'utf8' })

  assert.equal(review.status, 0)

  const result = spawnSync('node', [
    cli,
    'consider',
    '1',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /\$receiving-code-review/)
  assert.match(result.stdout, /Consider Bubo review 1\./)
  assert.match(result.stdout, /Do not implement anything yet/i)

  const reviewsPath = path.join(root, '.bubo', 'reviews.jsonl')
  const stored = JSON.parse(fs.readFileSync(reviewsPath, 'utf8').trim())
  assert.equal(stored.status, 'new')
})

test('consider hyphen alias resolves the same review by ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-consider-alias-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const review = spawnSync('node', [
    cli,
    'record-review',
    '--project', root,
    '--reason', 'turn',
    '--problem', 'a fixed sentinel id can collide under concurrency',
    '--evidence', 'the diff assigns alert_id = 0 before the async resolver returns',
    '--solution', 'use a unique temporary id and reconcile after resolution'
  ], { encoding: 'utf8' })

  assert.equal(review.status, 0)

  const result = spawnSync('node', [
    cli,
    'consider-1',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Consider Bubo review 1\./)
  assert.match(result.stdout, /\$receiving-code-review/)
})

test('consider last resolves the most recent review in the current project without promoting it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-consider-last-'))
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  for (const suffix of ['first', 'second']) {
    const review = spawnSync('node', [
      cli,
      'record-review',
      '--project', root,
      '--reason', 'turn',
      '--problem', `problem ${suffix}`,
      '--evidence', `evidence ${suffix}`,
      '--solution', `solution ${suffix}`
    ], { encoding: 'utf8' })

    assert.equal(review.status, 0)
  }

  const result = spawnSync('node', [
    cli,
    'consider',
    'last',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Consider Bubo review 2\./)
  assert.match(result.stdout, /Problem: problem second\./)
  assert.match(result.stdout, /Do not implement anything yet/i)

  const reviewsPath = path.join(root, '.bubo', 'reviews.jsonl')
  const stored = fs.readFileSync(reviewsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(stored.at(-1).status, 'new')
})
