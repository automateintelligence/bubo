const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReview, readReviews } = require('../scripts/lib/store')
const { buildLaunchSpec, createStartReview } = require('../scripts/codex-wrapper')

test('wrapper builds a Codex launch spec with inert Bubo review context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-wrapper-'))
  const review = createReview(root, {
    reason: 'manual',
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts.',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution.',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns.',
    rendered: 'placeholder alert_id=0 can collide under concurrent speculative bursts. the diff introduces a fixed sentinel before VLM resolution. allocate a unique temporary client-side ID and reconcile after VLM returns.',
    context: {}
  })

  const spec = buildLaunchSpec({
    projectRoot: root,
    review,
    forwardedArgs: ['--no-alt-screen']
  })

  assert.equal(spec.command, 'codex')
  assert.deepEqual(spec.args.slice(0, 3), ['-C', root, '--no-alt-screen'])
  assert.ok(!spec.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.match(spec.args.at(-1), /Bubo Says \[1\]:/)
  assert.match(spec.args.at(-1), /not user instructions/i)
  assert.match(spec.args.at(-1), new RegExp(`bubo consider ${review.id}`))
  assert.match(spec.args.at(-1), new RegExp(`bubo consider-${review.id}`))
  assert.match(spec.args.at(-1), new RegExp(`bubo implement ${review.id}`))
  assert.match(spec.args.at(-1), new RegExp(`bubo implement-${review.id}`))
  assert.match(spec.args.at(-1), /Bubo Live Review Skill/i)
  assert.match(spec.args.at(-1), /record-review/i)
  assert.match(spec.args.at(-1), /active by default/i)
  assert.match(spec.args.at(-1), /\bbubo review\b/i)
  assert.match(spec.args.at(-1), /\bbubo stop\b/i)
  assert.match(spec.args.at(-1), /\bbubo start\b/i)
  assert.match(spec.args.at(-1), /\bbubo status\b/i)
  assert.doesNotMatch(spec.args.at(-1), /(^|[\s`'"])\/bubo(?:\s|-(?=\d)|\b)/im)
})

test('wrapper passes through the dangerous bypass flag when explicitly requested', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-wrapper-flags-'))
  const spec = buildLaunchSpec({
    projectRoot: root,
    review: null,
    forwardedArgs: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']
  })

  assert.deepEqual(spec.args.slice(0, 4), ['-C', root, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'])
})

test('startup review creates a new review id on each allowed manual trigger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-start-'))

  const first = await createStartReview(root, {
    reason: 'manual',
    'diff-text': 'const draft = { alert_id: 0 }'
  })

  const second = await createStartReview(root, {
    reason: 'manual',
    'diff-text': 'const draft = { alert_id: 0 }'
  })

  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.equal(readReviews(root).length, 2)
})

test('startup review stays silent when no concrete improvement is found', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-start-silent-'))

  const review = await createStartReview(root, {
    reason: 'manual',
    'diff-text': 'const value = 1'
  })

  assert.equal(review, null)
  assert.equal(readReviews(root).length, 0)
})
