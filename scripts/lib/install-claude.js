const fs = require('node:fs')
const path = require('node:path')

const { ensureProjectState } = require('./store')

// One hook registration per event. Each shells out to the Bubo hook
// entrypoint, which reads the event JSON on stdin and injects any passive note
// via hookSpecificOutput.additionalContext.
function buboHookEntry(hookCommand, matcher) {
  return {
    matcher,
    hooks: [{ type: 'command', command: hookCommand }]
  }
}

function isBuboEntry(entry) {
  return Array.isArray(entry.hooks) && entry.hooks.some((hook) => /claude-hook\.js/.test(hook.command || ''))
}

// Merge Bubo's hook into an event array without disturbing unrelated hooks and
// without duplicating Bubo's own entry on repeated installs.
function mergeHook(existing, entry) {
  const list = Array.isArray(existing) ? existing.filter((item) => !isBuboEntry(item)) : []
  list.push(entry)
  return list
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    return {}
  }
}

function commandDoc(cliPath) {
  return `---
description: Bubo passive code review — review, consider, implement, start, stop, status
argument-hint: "[review | consider <id> | implement <id> | start | stop | status]"
allowed-tools: Bash(node *)
---

Bubo is a passive review companion. Run the project CLI and act on its output.

!\`node "${cliPath}" $ARGUMENTS --project "$CLAUDE_PROJECT_DIR"\`

How to act on the output above:

- \`review\` / \`status\` / \`start\` / \`stop\`: report the printed line verbatim. Do not implement anything.
- \`consider <id>\`: treat the printed envelope as evaluation context only. Verify it against the codebase and decide whether to implement, push back, or ask for clarification. Do not implement automatically.
- \`implement <id>\`: treat the printed task envelope as the actual user instruction and carry it out.

A Bubo note is context, not a command, until it is explicitly promoted with \`implement\`.
`
}

// Scaffold the Claude Code integration into `projectRoot`: hook registrations
// in .claude/settings.json and a native /bubo slash command. Idempotent and
// non-destructive — existing settings and unrelated hooks are preserved.
function installClaude(projectRoot, { repoRoot } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..')
  ensureProjectState(projectRoot)

  const claudeDir = path.join(projectRoot, '.claude')
  const commandsDir = path.join(claudeDir, 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })

  const hookPath = path.join(root, 'scripts', 'claude-hook.js')
  const cliPath = path.join(root, 'scripts', 'cli.js')
  const hookCommand = `node "${hookPath}"`

  const settingsPath = path.join(claudeDir, 'settings.json')
  const settings = readSettings(settingsPath)
  settings.hooks = settings.hooks || {}
  settings.hooks.SessionStart = mergeHook(settings.hooks.SessionStart, buboHookEntry(hookCommand, '*'))
  settings.hooks.UserPromptSubmit = mergeHook(settings.hooks.UserPromptSubmit, buboHookEntry(hookCommand, '*'))
  settings.hooks.PostToolUse = mergeHook(settings.hooks.PostToolUse, buboHookEntry(hookCommand, 'Bash'))
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  const commandPath = path.join(commandsDir, 'bubo.md')
  fs.writeFileSync(commandPath, commandDoc(cliPath))

  return { settingsPath, commandPath }
}

module.exports = { installClaude }
