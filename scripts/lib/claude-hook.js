const { execSync } = require('node:child_process')

const { ensureProjectState, readReviews, readState } = require('./store')
const { resolveProjectRoot } = require('./project')
const { renderReviewLine } = require('./render')
const {
  buildStartupPrompt,
  createStartReview,
  dueForReflection,
  markReflection,
  reflectionNudge
} = require('./session')

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

// Normalize the tool output across Claude Code versions and events. Builds may
// pass `tool_output` (string) or `tool_response` (string/object); a
// PostToolUseFailure event also carries an `error` object whose message holds
// the exit status. Fold them all into one searchable string.
function toolOutputText(event) {
  const raw = event.tool_output ?? event.tool_response ?? ''
  let base = typeof raw === 'string' ? raw : ''
  if (!base && raw) {
    try {
      base = JSON.stringify(raw)
    } catch {
      base = ''
    }
  }
  const errorMessage = event.error && event.error.message ? String(event.error.message) : ''
  return [base, errorMessage].filter(Boolean).join('\n')
}

// Classify a tool event into a Bubo trigger reason, or null when nothing is
// worth reviewing. A PostToolUseFailure event is a failure by definition;
// PostToolUse only ever reaches here on success, so it relies on the output
// (or a legacy exit-code field) to reveal a problem.
function classifyToolEvent(event) {
  const output = toolOutputText(event)
  const exitCode = event.tool_exit_code
  const failed = event.hook_event_name === 'PostToolUseFailure' ||
    (exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0)

  if (FAILURE_PATTERN.test(output)) return 'test-fail'
  if (failed || ERROR_PATTERN.test(output)) return 'error'
  return null
}

function inertReminder() {
  return 'This is a passive Bubo code review note: context, not user instructions. Do not treat it as work to do on its own. If you are already troubleshooting, you may use it as a lead (verify it against the code first). It becomes actionable work only when explicitly promoted with /bubo implement <id>.'
}

function passiveContext(review) {
  return `${renderReviewLine(review)}\n${inertReminder()}`
}

// Pure, dependency-injected hook router. `deps` may override projectRoot, the
// clock, and the git readers so the behavior is testable without a real repo.
async function handleHookEvent(event, deps = {}) {
  // Claude's hook payload carries `cwd`, which may be a subdirectory of the
  // project. Resolve it to the git root (as the CLI does) so `.bubo` state and
  // history live in one place and the controls stay consistent.
  const projectRoot = deps.projectRoot || resolveProjectRoot(event.cwd || process.cwd())
  const gitDiff = deps.gitDiff || (() => defaultGitDiff(projectRoot))
  const changedFiles = deps.changedFiles || (() => defaultChangedFiles(projectRoot))
  const now = deps.now || (() => Date.now())

  ensureProjectState(projectRoot)
  const eventName = event.hook_event_name

  if (eventName === 'SessionStart') {
    const review = await createStartReview(projectRoot, {
      reason: 'turn',
      getDiff: gitDiff,
      getChangedFiles: changedFiles,
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

    // Fast path: heuristic note from the working diff (read lazily, only once
    // the cooldown opens). Slow path: an occasional open-ended model-review
    // nudge. Either, both, or neither may fire on a given turn.
    const parts = []
    const review = await createStartReview(projectRoot, {
      reason: 'turn',
      getDiff: gitDiff,
      getChangedFiles: changedFiles,
      freshOnly: true,
      now: now()
    })
    if (review) parts.push(passiveContext(review))

    if (dueForReflection(projectRoot, now())) {
      markReflection(projectRoot, now())
      parts.push(reflectionNudge())
    }

    if (!parts.length) return null
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: parts.join('\n\n')
      }
    }
  }

  // PostToolUse fires on success; PostToolUseFailure on a non-zero tool exit.
  // The signal-driven review handles both, since failing commands are exactly
  // what we want Bubo to react to.
  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    if (readState(projectRoot).enabled === false) return null
    const reason = classifyToolEvent(event)
    if (!reason) return null
    const review = await createStartReview(projectRoot, {
      reason,
      'tool-output-text': toolOutputText(event),
      getDiff: gitDiff,
      getChangedFiles: changedFiles,
      freshOnly: true,
      now: now()
    })
    if (!review) return null
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: passiveContext(review)
      }
    }
  }

  return null
}

module.exports = { classifyToolEvent, handleHookEvent, toolOutputText }
