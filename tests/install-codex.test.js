const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { installCodexPrompt, resolveCodexHome } = require('../scripts/lib/install-codex')

const REPO_ROOT = path.resolve(__dirname, '..')

test('installCodexPrompt writes a /bubo custom prompt into CODEX_HOME/prompts', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-codex-home-'))
  const { promptPath } = installCodexPrompt({ repoRoot: REPO_ROOT, codexHome })

  assert.equal(promptPath, path.join(codexHome, 'prompts', 'bubo.md'))
  const prompt = fs.readFileSync(promptPath, 'utf8')
  assert.match(prompt, /description:/)
  assert.match(prompt, /argument-hint:/)
  // The prompt bakes in the absolute CLI path and forwards the slash args.
  assert.ok(prompt.includes(path.join(REPO_ROOT, 'scripts', 'cli.js')))
  assert.match(prompt, /\$ARGUMENTS/)
  // Codex prompts cannot pre-execute shell, so the model must run the CLI.
  assert.match(prompt, /--project "\$PWD"/)
})

test('installCodexPrompt is idempotent and keeps unrelated prompts', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-codex-idem-'))
  const promptsDir = path.join(codexHome, 'prompts')
  fs.mkdirSync(promptsDir, { recursive: true })
  fs.writeFileSync(path.join(promptsDir, 'other.md'), 'keep me')

  installCodexPrompt({ repoRoot: REPO_ROOT, codexHome })
  const { promptPath } = installCodexPrompt({ repoRoot: REPO_ROOT, codexHome })

  assert.equal(fs.readFileSync(path.join(promptsDir, 'other.md'), 'utf8'), 'keep me')
  assert.match(fs.readFileSync(promptPath, 'utf8'), /\$ARGUMENTS/)
})

test('resolveCodexHome prefers CODEX_HOME over the default ~/.codex', () => {
  assert.equal(resolveCodexHome({ CODEX_HOME: '/tmp/custom-codex' }), '/tmp/custom-codex')
  const fallback = resolveCodexHome({})
  assert.equal(fallback, path.join(os.homedir(), '.codex'))
})

test('the prompt covers the full /bubo control surface', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-codex-surface-'))
  const { promptPath } = installCodexPrompt({ repoRoot: REPO_ROOT, codexHome })
  const prompt = fs.readFileSync(promptPath, 'utf8')

  for (const word of ['review', 'consider', 'implement', 'start', 'stop', 'status']) {
    assert.match(prompt, new RegExp(`\\b${word}\\b`), `mentions ${word}`)
  }
  // Bare /bubo should default to status rather than erroring.
  assert.match(prompt, /empty|no arguments|defaults? to/i)
})
