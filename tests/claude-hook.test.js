const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { handleHookEvent, classifyToolEvent } = require('../scripts/lib/claude-hook')
const { readConfig, readReviews, readState, writeState, ensureProjectState } = require('../scripts/lib/store')

function tmpProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bubo-claude-${label}-`))
  ensureProjectState(root)
  return root
}

const SENTINEL_DIFF = 'const draft = { alert_id: 0 }'
const noDeps = (root, extra = {}) => ({ projectRoot: root, gitDiff: () => '', changedFiles: () => [], ...extra })

test('SessionStart injects the live-review skill as additionalContext for the claude host', async () => {
  const root = tmpProject('start')
  const out = await handleHookEvent(
    { hook_event_name: 'SessionStart', cwd: root, source: 'startup' },
    noDeps(root)
  )

  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(out.hookSpecificOutput.additionalContext, /Bubo Live Review Skill/i)
  assert.match(out.hookSpecificOutput.additionalContext, /\/bubo\b/)
  assert.match(out.hookSpecificOutput.additionalContext, /not user instructions/i)
})

test('UserPromptSubmit emits a fresh passive note from the working diff', async () => {
  const root = tmpProject('prompt')
  const out = await handleHookEvent(
    { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'keep going' },
    noDeps(root, { gitDiff: () => SENTINEL_DIFF })
  )

  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(out.hookSpecificOutput.additionalContext, /Bubo Says \[1\]:/)
  assert.match(out.hookSpecificOutput.additionalContext, /not user instructions/i)
  assert.match(out.hookSpecificOutput.additionalContext, /troubleshooting/i)
  assert.equal(readReviews(root).length, 1)
})

test('UserPromptSubmit stays silent while Bubo is disabled for the project', async () => {
  const root = tmpProject('disabled')
  const state = readState(root)
  state.enabled = false
  writeState(root, state)

  const out = await handleHookEvent(
    { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'keep going' },
    noDeps(root, { gitDiff: () => SENTINEL_DIFF })
  )

  assert.equal(out, null)
  assert.equal(readReviews(root).length, 0)
})

test('UserPromptSubmit does not re-inject a stale note inside the cooldown window', async () => {
  const root = tmpProject('cooldown')
  const deps = noDeps(root, { gitDiff: () => SENTINEL_DIFF, now: () => 1_000_000 })

  const first = await handleHookEvent({ hook_event_name: 'UserPromptSubmit', cwd: root }, deps)
  const second = await handleHookEvent({ hook_event_name: 'UserPromptSubmit', cwd: root }, deps)

  assert.match(first.hookSpecificOutput.additionalContext, /Bubo Says \[1\]:/)
  assert.equal(second, null)
  assert.equal(readReviews(root).length, 1)
})

test('PostToolUse reviews when a command fails, ignoring clean output', async () => {
  const failRoot = tmpProject('postfail')
  const failOut = await handleHookEvent(
    {
      hook_event_name: 'PostToolUse',
      cwd: failRoot,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_output: 'FAIL src/alerts.test.js\n  AssertionError: expected 0',
      tool_exit_code: 1
    },
    noDeps(failRoot)
  )

  assert.equal(failOut.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(failOut.hookSpecificOutput.additionalContext, /Bubo Says \[1\]:/)
  assert.equal(readReviews(failRoot).length, 1)

  const cleanRoot = tmpProject('postclean')
  const cleanOut = await handleHookEvent(
    {
      hook_event_name: 'PostToolUse',
      cwd: cleanRoot,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_output: 'All tests passed',
      tool_exit_code: 0
    },
    noDeps(cleanRoot)
  )

  assert.equal(cleanOut, null)
  assert.equal(readReviews(cleanRoot).length, 0)
})

test('classifyToolEvent maps failure signals to trigger reasons', () => {
  assert.equal(classifyToolEvent({ tool_name: 'Bash', tool_exit_code: 1, tool_output: 'FAIL: 2 tests failed' }), 'test-fail')
  assert.equal(classifyToolEvent({ tool_name: 'Bash', tool_exit_code: 1, tool_output: 'Traceback (most recent call last):' }), 'error')
  assert.equal(classifyToolEvent({ tool_name: 'Bash', tool_exit_code: 0, tool_output: 'ok' }), null)
  assert.equal(classifyToolEvent({ tool_name: 'Read', tool_response: 'file contents' }), null)
  // A PostToolUseFailure event is a failure by definition, even without a
  // recognizable pattern or an exit code field.
  assert.equal(classifyToolEvent({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_output: 'command not found',
    error: { message: 'Process exited with code 127' }
  }), 'error')
})

test('PostToolUseFailure produces a review (PostToolUse alone fires only on success)', async () => {
  const root = tmpProject('postfailevent')
  const out = await handleHookEvent({
    hook_event_name: 'PostToolUseFailure',
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_output: 'AssertionError: expected 1 received 0',
    error: { type: 'execution_error', message: 'Process exited with code 1' }
  }, noDeps(root))

  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure')
  assert.match(out.hookSpecificOutput.additionalContext, /Bubo Says \[1\]:/)
  assert.equal(readReviews(root).length, 1)
})

test('UserPromptSubmit injects an open-ended reflection nudge on the slow cadence', async () => {
  const root = tmpProject('reflect')
  const reflectMs = readConfig(root).cooldowns.reflectMs
  const start = 9_000_000

  // First prompt of a fresh project: no diff and the reflection clock is only
  // just starting, so Bubo stays quiet rather than piping up right away.
  const first = await handleHookEvent(
    { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'continue' },
    noDeps(root, { now: () => start })
  )
  assert.equal(first, null)

  // A full window later, the open-ended model-review nudge fires.
  const due = await handleHookEvent(
    { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'continue' },
    noDeps(root, { now: () => start + reflectMs + 1 })
  )
  assert.equal(due.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(due.hookSpecificOutput.additionalContext, /record-review/)
  assert.equal(readReviews(root).length, 0) // the model authors it, not the heuristic

  // It does not fire again on the very next prompt.
  const again = await handleHookEvent(
    { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'and again' },
    noDeps(root, { now: () => start + reflectMs + 2000 })
  )
  assert.equal(again, null)
})

test('hook cwd is resolved to the git root so state is shared, not split per subdirectory', async () => {
  const { execSync } = require('node:child_process')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-claude-cwd-'))
  execSync(`git -C "${repo}" init -q`)
  const sub = path.join(repo, 'packages', 'app')
  fs.mkdirSync(sub, { recursive: true })

  // A PostToolUse fired from a subdirectory must persist under the repo root,
  // not under the subdirectory. (No projectRoot dep here — exercise the real
  // resolution path.)
  const out = await handleHookEvent({
    hook_event_name: 'PostToolUse',
    cwd: sub,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_output: 'FAIL: AssertionError',
    tool_exit_code: 1
  }, { gitDiff: () => '', changedFiles: () => [] })

  assert.ok(out)
  assert.ok(fs.existsSync(path.join(repo, '.bubo', 'reviews.jsonl')))
  assert.ok(!fs.existsSync(path.join(sub, '.bubo')))
})

test('unknown hook events are ignored', async () => {
  const root = tmpProject('unknown')
  const out = await handleHookEvent({ hook_event_name: 'PreCompact', cwd: root }, noDeps(root))
  assert.equal(out, null)
})
