const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReview, readReviews, readConfig } = require('../scripts/lib/store')
const {
  buildStartupPrompt,
  createStartReview,
  dueForReflection,
  markReflection,
  reflectionNudge
} = require('../scripts/lib/session')

function makeReview(root) {
  return createReview(root, {
    reason: 'manual',
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts.',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution.',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns.',
    rendered: 'sentinel id. race bait. mint a temp id first',
    context: {}
  })
}

test('shared startup prompt carries the inert review contract for any host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-'))
  const review = makeReview(root)
  const prompt = buildStartupPrompt({ review, host: 'codex' })

  assert.match(prompt, /Bubo Says \[1\]:/)
  assert.match(prompt, /not user instructions/i)
  assert.match(prompt, /Bubo Live Review Skill/i)
  assert.match(prompt, /record-review/i)
  assert.match(prompt, /active by default/i)
  assert.match(prompt, /\bbubo review\b/i)
  assert.match(prompt, /\bbubo stop\b/i)
  assert.match(prompt, /\bbubo start\b/i)
  assert.match(prompt, /\bbubo status\b/i)
  assert.match(prompt, new RegExp(`bubo consider ${review.id}`))
  assert.match(prompt, new RegExp(`bubo implement ${review.id}`))
})

test('codex host suppresses slash-prefixed bubo commands', () => {
  const prompt = buildStartupPrompt({ review: null, host: 'codex' })
  assert.doesNotMatch(prompt, /(^|[\s`'"])\/bubo(?:\s|-(?=\d)|\b)/im)
})

test('claude host advertises native slash commands', () => {
  const prompt = buildStartupPrompt({ review: null, host: 'claude' })
  assert.match(prompt, /\/bubo\b/)
  assert.match(prompt, /slash command/i)
})

test('startup review allocates a fresh id per allowed manual trigger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-start-'))

  const first = await createStartReview(root, { reason: 'manual', 'diff-text': 'const draft = { alert_id: 0 }' })
  const second = await createStartReview(root, { reason: 'manual', 'diff-text': 'const draft = { alert_id: 0 }' })

  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.equal(readReviews(root).length, 2)
})

test('startup review stays silent when no concrete improvement is found', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-silent-'))
  const review = await createStartReview(root, { reason: 'manual', 'diff-text': 'const value = 1' })

  assert.equal(review, null)
  assert.equal(readReviews(root).length, 0)
})

test('the working diff is read lazily — never when the cooldown blocks the turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-lazy-'))
  let reads = 0
  const getDiff = () => { reads += 1; return 'const draft = { alert_id: 0 }' }
  const now = 5_000_000

  const first = await createStartReview(root, { reason: 'turn', getDiff, now, freshOnly: true })
  const second = await createStartReview(root, { reason: 'turn', getDiff, now, freshOnly: true })

  assert.ok(first)
  assert.equal(second, null) // blocked by the freshly-stamped turn cooldown
  assert.equal(reads, 1) // the diff was not read on the blocked turn
})

test('dedup suppresses a note whose problem matches a recent one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-dedup-'))
  const diff = 'const draft = { alert_id: 0 }'
  const turnMs = readConfig(root).cooldowns.turnMs

  const first = await createStartReview(root, { reason: 'turn', 'diff-text': diff, now: 5_000_000 })
  const second = await createStartReview(root, { reason: 'turn', 'diff-text': diff, now: 5_000_000 + turnMs + 1 })

  assert.ok(first)
  assert.equal(second, null)
  assert.equal(readReviews(root).length, 1)
})

test('reflection cadence does not fire immediately — the first check starts the clock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-reflect-'))
  const reflectMs = readConfig(root).cooldowns.reflectMs
  const start = 9_000_000

  // A brand-new project must not pipe up on the first prompt.
  assert.equal(dueForReflection(root, start), false)
  assert.equal(dueForReflection(root, start + 1000), false)
  // It becomes due one full window after the clock started.
  assert.equal(dueForReflection(root, start + reflectMs + 1), true)
  markReflection(root, start + reflectMs + 1)
  assert.equal(dueForReflection(root, start + reflectMs + 2000), false)
})

test('reflection cadence stays silent while Bubo is disabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-reflect-off-'))
  const { readState, writeState } = require('../scripts/lib/store')
  const state = readState(root)
  state.enabled = false
  writeState(root, state)

  assert.equal(dueForReflection(root, 9_000_000), false)
})

test('reflection nudge invites an open-ended model review and record-review', () => {
  const nudge = reflectionNudge()
  assert.match(nudge, /open-ended|open ended/i)
  assert.match(nudge, /record-review/)
})
