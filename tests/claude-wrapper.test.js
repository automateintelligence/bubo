const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReview } = require('../scripts/lib/store')
const { buildLaunchSpec } = require('../scripts/claude-wrapper')

test('wrapper builds a Claude launch spec carrying inert Bubo context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-claude-wrap-'))
  const review = createReview(root, {
    reason: 'manual',
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts.',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution.',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns.',
    rendered: 'sentinel id. race bait. mint a temp id first',
    context: {}
  })

  const spec = buildLaunchSpec({
    projectRoot: root,
    review,
    forwardedArgs: ['--model', 'claude-opus-4-8']
  })

  assert.equal(spec.command, 'claude')
  assert.equal(spec.cwd, root)
  assert.deepEqual(spec.args.slice(0, 2), ['--model', 'claude-opus-4-8'])
  assert.ok(spec.args.includes('--append-system-prompt'))

  const systemPrompt = spec.args[spec.args.indexOf('--append-system-prompt') + 1]
  assert.match(systemPrompt, /Bubo Says \[1\]:/)
  assert.match(systemPrompt, /Bubo Live Review Skill/i)
  assert.match(systemPrompt, /not user instructions/i)
  assert.match(systemPrompt, /\/bubo\b/)
})

test('wrapper appends an explicit user prompt as the trailing positional', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-claude-wrap-prompt-'))
  const spec = buildLaunchSpec({
    projectRoot: root,
    review: null,
    forwardedArgs: [],
    prompt: 'start reviewing the auth module'
  })

  assert.equal(spec.args.at(-1), 'start reviewing the auth module')
})
