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
