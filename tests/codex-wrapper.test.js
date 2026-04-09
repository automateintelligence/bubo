const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReview } = require('../scripts/lib/store')
const { buildLaunchSpec } = require('../scripts/codex-wrapper')

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
  assert.match(spec.args.at(-1), /Code Review \[1\]:/)
  assert.match(spec.args.at(-1), /not user instructions/i)
  assert.match(spec.args.at(-1), new RegExp(`bubo-implement-${review.id}`))
})

