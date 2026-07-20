const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync } = require('node:child_process')

const { parseArgs } = require('../scripts/cli')
const { makeProjectRoot } = require('./helpers')

test('parseArgs treats an empty-string value as a value, not a boolean flag', () => {
  // The /bubo slash command expands to `... status --project ""` when
  // $CLAUDE_PROJECT_DIR is empty; project must stay a string so resolveProjectRoot
  // does not receive `true`.
  const { positionals, options } = parseArgs(['status', '--project', ''])
  assert.deepEqual(positionals, ['status'])
  assert.equal(options.project, '')
})

test('status with an empty --project falls back to cwd instead of crashing', () => {
  const root = makeProjectRoot('bubo-empty-project-')
  execSync(`git -C "${root}" init -q`)
  const cli = path.join(path.resolve(__dirname, '..'), 'scripts/cli.js')

  // Mirrors the slash command with an empty env var, run from the project dir.
  const result = spawnSync('node', [cli, 'status', '--project', ''], { cwd: root, encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /enabled/i)
  assert.equal(result.stderr, '')
})

test('review command prints compact inline note and writes project-scoped log', () => {
  const root = makeProjectRoot('bubo-cli-')
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
  const root = makeProjectRoot('bubo-cli-review-')
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
  const root = makeProjectRoot('bubo-record-')
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
  const root = makeProjectRoot('bubo-repeat-')
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
  const root = makeProjectRoot('bubo-no-finding-')
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
  const root = makeProjectRoot('bubo-session-')
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

test('no command at all defaults to session status (bare /bubo on any host)', () => {
  const root = makeProjectRoot('bubo-bare-default-')
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  // Bare `/bubo` expands with an empty $ARGUMENTS on both hosts, so the CLI
  // receives only --project. That must behave like `status`, not crash.
  const result = spawnSync('node', [cli, '--project', root], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Bubo session is enabled/)
  assert.equal(result.stderr, '')
})

test('bare start/stop/status map to session controls (as the /bubo slash command expands them)', () => {
  const root = makeProjectRoot('bubo-bare-controls-')
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')
  const run = (cmd) => spawnSync('node', [cli, cmd, '--project', root], { encoding: 'utf8' })

  const stop = run('stop')
  const statusOff = run('status')
  const start = run('start')
  const statusOn = run('status')

  for (const r of [stop, statusOff, start, statusOn]) assert.equal(r.status, 0)
  assert.match(stop.stdout, /disabled/i)
  assert.match(statusOff.stdout, /disabled/i)
  assert.match(start.stdout, /enabled/i)
  assert.match(statusOn.stdout, /enabled/i)
})

test('implement hyphen alias promotes review by ID', () => {
  const root = makeProjectRoot('bubo-implement-alias-')
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
  const root = makeProjectRoot('bubo-implement-last-')
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
  const root = makeProjectRoot('bubo-consider-')
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
  const root = makeProjectRoot('bubo-consider-alias-')
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

test('install-claude scaffolds hooks and a slash command into the project', () => {
  const root = makeProjectRoot('bubo-cli-install-')
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  const result = spawnSync('node', [cli, 'install-claude', '--project', root], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Installed Bubo for Claude Code/)
  assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')))
  assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'bubo.md')))
})

test('install sets up the detected host(s) in one command', () => {
  const root = makeProjectRoot('bubo-cli-install1-')
  const codexHome = makeProjectRoot('bubo-cli-codexhome-')
  const repoRoot = path.resolve(__dirname, '..')
  const cli = path.join(repoRoot, 'scripts/cli.js')

  // CODEX_HOME keeps the test from touching the developer's real ~/.codex.
  const result = spawnSync('node', [cli, 'install', '--project', root], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome }
  })

  assert.equal(result.status, 0)
  // Claude side is scaffolded into the project...
  assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')))
  assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'bubo.md')))
  // ...and the Codex side gets a per-user /bubo custom prompt plus the wrapper alias.
  assert.match(result.stdout, /Claude Code/)
  assert.match(result.stdout, /Codex/)
  assert.match(result.stdout, /bubo-codex/)
  assert.ok(fs.existsSync(path.join(codexHome, 'prompts', 'bubo.md')))
})

test('install survives an unwritable CODEX_HOME and still completes the Claude side', () => {
  const root = makeProjectRoot('bubo-cli-install-ro-')
  const codexHome = makeProjectRoot('bubo-cli-codexro-')
  fs.chmodSync(codexHome, 0o500) // exists but not writable

  const result = spawnSync('node', [path.join(path.resolve(__dirname, '..'), 'scripts/cli.js'), 'install', '--project', root], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome }
  })

  fs.chmodSync(codexHome, 0o700) // restore so tmp cleanup works

  assert.equal(result.status, 0)
  assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'bubo.md')))
  assert.match(result.stdout, /could not install the \/bubo custom prompt/)
  assert.match(result.stdout, /install-codex/)
})

test('claude-hook entrypoint injects a passive note from a UserPromptSubmit event', () => {
  const root = makeProjectRoot('bubo-hook-e2e-')
  const repoRoot = path.resolve(__dirname, '..')
  const hook = path.join(repoRoot, 'scripts/claude-hook.js')

  const event = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd: root,
    prompt: 'continue'
  })

  // No diff in this throwaway dir, so seed evidence through the tool-output path
  // by driving a PostToolUse failure event instead.
  const failEvent = JSON.stringify({
    hook_event_name: 'PostToolUse',
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_output: 'FAIL: AssertionError: expected 1 received 0',
    tool_exit_code: 1
  })

  const result = spawnSync('node', [hook], { encoding: 'utf8', input: failEvent })
  assert.equal(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(payload.hookSpecificOutput.additionalContext, /Bubo Says \[1\]:/)
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))

  // A benign event produces no output and a clean exit.
  const benign = spawnSync('node', [hook], { encoding: 'utf8', input: event })
  assert.equal(benign.status, 0)
})

test('consider last resolves the most recent review in the current project without promoting it', () => {
  const root = makeProjectRoot('bubo-consider-last-')
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
