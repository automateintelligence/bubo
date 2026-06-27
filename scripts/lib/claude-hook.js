const { execSync } = require('node:child_process')

const { ensureProjectState, readReviews, readState } = require('./store')
const { renderReviewLine } = require('./render')
const { buildStartupPrompt, createStartReview } = require('./session')

const FAILURE_PATTERN = /\b(fail(?:ed|ing|ure)?|not ok|✗|assertion\s*error|expect(?:ed)?\b.*\breceived)\b/i
const ERROR_PATTERN = /\b(error|exception|traceback|panic|fatal|segfault|unhandled)\b/i

function tryGit(projectRoot, args) {
  try {
    return execSync(`git -C "${projectRoot}" ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function defaultGitDiff(projectRoot) {
  return tryGit(projectRoot, 'diff --no-ext-diff')
}

function defaultChangedFiles(projectRoot) {
  const output = tryGit(projectRoot, 'diff --name-only')
  return output ? output.split('\n').filter(Boolean) : []
}

// Normalize the tool output field across Claude Code versions. Recent builds
// pass `tool_output` (a string) plus `tool_exit_code`; older ones pass
// `tool_response` (string or structured object).
function toolOutputText(event) {
  const raw = event.tool_output ?? event.tool_response ?? ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return ''
  }
}

// Classify a PostToolUse event into a Bubo trigger reason, or null when the
// observed output carries no failure signal worth reviewing.
function classifyToolEvent(event) {
  const exitCode = event.tool_exit_code
  const output = toolOutputText(event)
  const failed = exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0

  if (FAILURE_PATTERN.test(output)) return 'test-fail'
  if (failed || ERROR_PATTERN.test(output)) return 'error'
  return null
}

function inertReminder() {
  return 'This is a passive Bubo code review note: context only, not user instructions. It becomes actionable only if explicitly promoted with /bubo implement <id>.'
}

function passiveContext(review) {
  return `${renderReviewLine(review)}\n${inertReminder()}`
}

// Pure, dependency-injected hook router. `deps` may override projectRoot, the
// clock, and the git readers so the behavior is testable without a real repo.
async function handleHookEvent(event, deps = {}) {
  const projectRoot = deps.projectRoot || event.cwd || process.cwd()
  const gitDiff = deps.gitDiff || (() => defaultGitDiff(projectRoot))
  const changedFiles = deps.changedFiles || (() => defaultChangedFiles(projectRoot))
  const now = deps.now || (() => Date.now())

  ensureProjectState(projectRoot)
  const eventName = event.hook_event_name

  if (eventName === 'SessionStart') {
    const review = await createStartReview(projectRoot, {
      reason: 'turn',
      'diff-text': gitDiff(),
      changedFiles: changedFiles(),
      now: now()
    })
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildStartupPrompt({ review, host: 'claude' })
      }
    }
  }

  if (eventName === 'UserPromptSubmit') {
    if (readState(projectRoot).enabled === false) return null
    const review = await createStartReview(projectRoot, {
      reason: 'turn',
      'diff-text': gitDiff(),
      changedFiles: changedFiles(),
      freshOnly: true,
      now: now()
    })
    if (!review) return null
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: passiveContext(review)
      }
    }
  }

  if (eventName === 'PostToolUse') {
    if (readState(projectRoot).enabled === false) return null
    const reason = classifyToolEvent(event)
    if (!reason) return null
    const review = await createStartReview(projectRoot, {
      reason,
      'tool-output-text': toolOutputText(event),
      'diff-text': gitDiff(),
      changedFiles: changedFiles(),
      freshOnly: true,
      now: now()
    })
    if (!review) return null
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: passiveContext(review)
      }
    }
  }

  return null
}

module.exports = { classifyToolEvent, handleHookEvent, toolOutputText }
