const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { installClaude } = require('../scripts/lib/install-claude')

const REPO_ROOT = path.resolve(__dirname, '..')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('installClaude scaffolds hooks for the passive review surface', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-install-'))
  const result = installClaude(root, { repoRoot: REPO_ROOT })

  const settings = readJson(result.settingsPath)
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
    assert.ok(Array.isArray(settings.hooks[event]), `${event} hook registered`)
    const command = settings.hooks[event][0].hooks[0].command
    assert.match(command, /claude-hook\.js/)
  }

  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Bash')
})

test('installClaude writes a native /bubo slash command bound to the CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-install-cmd-'))
  const result = installClaude(root, { repoRoot: REPO_ROOT })

  const command = fs.readFileSync(result.commandPath, 'utf8')
  assert.match(result.commandPath, /\.claude\/commands\/bubo\.md$/)
  assert.match(command, /description:/)
  assert.match(command, /cli\.js/)
  assert.match(command, /\$ARGUMENTS/)
})

test('installClaude is idempotent and preserves existing settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-install-merge-'))
  const claudeDir = path.join(root, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env: { FOO: 'bar' }, hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo keep' }] }] } }, null, 2)
  )

  installClaude(root, { repoRoot: REPO_ROOT })
  const second = installClaude(root, { repoRoot: REPO_ROOT })
  const settings = readJson(second.settingsPath)

  assert.equal(settings.env.FOO, 'bar')
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo keep')
  // Running twice must not duplicate the Bubo SessionStart hook entry.
  const buboStart = settings.hooks.SessionStart.filter((entry) =>
    entry.hooks.some((hook) => /claude-hook\.js/.test(hook.command))
  )
  assert.equal(buboStart.length, 1)
})
