const test = require('node:test')
const assert = require('node:assert/strict')

const { generateReview } = require('../scripts/lib/generate')

const HEURISTIC = { provider: { kind: 'heuristic' } }

function review(diffExcerpt, extra = {}) {
  return generateReview({
    reason: 'turn',
    diffExcerpt,
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: [],
    ...extra
  }, HEURISTIC)
}

const CASES = [
  { label: 'hardcoded secret', diff: '+ const apiKey = "sk_live_ab12cd34ef56gh78ij90"', match: /secret|credential|key/i },
  { label: 'aws access key', diff: '+ AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"', match: /secret|credential|key/i },
  { label: 'eval on input', diff: '+ const result = eval(userInput)', match: /eval|execut/i },
  { label: 'dynamic sql', diff: '+ db.query("SELECT * FROM users WHERE id = " + id)', match: /sql|inject|parameter/i },
  { label: 'insecure randomness', diff: '+ const token = Math.random().toString(36)', match: /random|predictable|csprng/i },
  { label: 'dangerous shell', diff: '+\trm -rf node_modules dist', match: /rm -rf|destructive|irreversible/i },
  { label: 'focused test', diff: '+ describe.only("auth", () => {})', match: /focus|only|suite/i },
  { label: 'left-in debugger', diff: '+   debugger', match: /debug|breakpoint|left in/i },
  { label: 'lint suppression', diff: '+ x = y  # type: ignore', match: /suppress|silenc|checker|lint/i },
  { label: 'as any escape hatch', diff: '+ const u = payload as any', match: /any|type|escape|boundary/i },
  { label: 'fixme marker', diff: '+ // FIXME: handle the null case', match: /fixme|unfinished|debt/i }
]

for (const item of CASES) {
  test(`generator flags ${item.label}`, async () => {
    const result = await review(item.diff)
    assert.ok(result, `expected a review for ${item.label}`)
    const haystack = `${result.problem} ${result.evidence} ${result.solution} ${result.rendered}`
    assert.match(haystack, item.match)
  })
}

test('generator scans only added lines, ignoring removed code', async () => {
  // The secret is on a removed (-) line, so it must not trigger a finding.
  const result = await review('- const apiKey = "sk_live_ab12cd34ef56gh78ij90"\n+ const apiKey = readKey()')
  assert.equal(result, null)
})

test('generator prioritizes a security finding over a hygiene finding', async () => {
  const result = await review('+ const apiKey = "sk_live_ab12cd34ef56gh78ij90"\n+ // FIXME: rotate this')
  assert.match(`${result.problem} ${result.rendered}`, /secret|credential|key/i)
})

test('generator emits a sentinel-id collision review from diff evidence', async () => {
  const review = await generateReview({
    reason: 'large-diff',
    diffExcerpt: 'const draft = { alert_id: 0, status: "pending" }',
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['alerts.ts']
  }, { provider: { kind: 'heuristic' } })

  assert.match(review.problem, /collide|collision/i)
  assert.match(review.evidence, /alert_id: 0|fixed sentinel/i)
  assert.match(review.solution, /unique temporary|reconcile/i)
  assert.equal(review.rendered, 'sentinel id. race bait. mint a temp id first')
})

test('generator stays silent when it has no concrete improvement to suggest', async () => {
  const review = await generateReview({
    reason: 'manual',
    diffExcerpt: 'const value = 1',
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['value.ts']
  }, { provider: { kind: 'heuristic' } })

  assert.equal(review, null)
})

test('generator emits a concrete large-diff review when changed lines cross threshold', async () => {
  const diffExcerpt = Array.from({ length: 81 }, (_, index) => `+ line ${index + 1}`).join('\n')
  const review = await generateReview({
    reason: 'large-diff',
    diffExcerpt,
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['alpha.ts', 'beta.ts']
  }, { provider: { kind: 'heuristic' }, largeDiffThreshold: 80 })

  assert.match(review.problem, /regression risk|wide change set|blast radius/i)
  assert.match(review.evidence, /81 changed lines/i)
  assert.match(review.solution, /verify|review|hot/i)
  assert.match(review.rendered, /big diff|wide diff/i)
})
