const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('plugin manifest names the plugin and declares no dependencies', () => {
  const manifest = readJson(path.join(REPO_ROOT, '.claude-plugin', 'plugin.json'))

  assert.equal(manifest.name, 'bubo')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(manifest.description)
  // Bubo installs standalone: never pulled in by (or pulling in) other plugins.
  assert.equal(manifest.dependencies, undefined)
})

test('plugin hooks.json registers the four passive-review events via CLAUDE_PLUGIN_ROOT', () => {
  const { hooks } = readJson(path.join(REPO_ROOT, 'hooks', 'hooks.json'))

  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']) {
    assert.ok(Array.isArray(hooks[event]), `${event} hook registered`)
    const command = hooks[event][0].hooks[0].command
    assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/)
    assert.match(command, /claude-hook\.js/)
  }

  assert.equal(hooks.PostToolUse[0].matcher, 'Bash')
  assert.equal(hooks.PostToolUseFailure[0].matcher, 'Bash')
})

test('plugin /bubo command mirrors the per-project command via CLAUDE_PLUGIN_ROOT', () => {
  const command = fs.readFileSync(path.join(REPO_ROOT, 'commands', 'bubo.md'), 'utf8')

  assert.match(command, /description:/)
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cli\.js/)
  assert.match(command, /\$ARGUMENTS/)
  // Same empty-env fallback the per-project command uses.
  assert.match(command, /\$\{CLAUDE_PROJECT_DIR:-\$PWD\}/)
})

test('plugin ships the live-review skill where Claude Code auto-discovers it', () => {
  const skillPath = path.join(REPO_ROOT, 'skills', 'bubo-live-review', 'SKILL.md')
  assert.ok(fs.existsSync(skillPath))
  assert.match(fs.readFileSync(skillPath, 'utf8'), /^---\nname: bubo-live-review/m)
})
