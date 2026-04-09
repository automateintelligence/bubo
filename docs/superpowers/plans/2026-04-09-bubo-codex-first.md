# Bubo Codex-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Codex-first Bubo review engine that logs short structured code review notes per project under `./.bubo/`, emits compact rendered review text, and supports explicit promotion of a logged review into actionable work.

**Architecture:** Implement a small shared core in Node.js with project-scoped storage, trigger evaluation, heuristic-or-command-backed review generation, and promotion semantics. Add a Codex-oriented CLI adapter plus convenience wrapper scripts for manual review and promotion, leaving true host inline injection as a later integration layer.

**Tech Stack:** Node.js 20, CommonJS modules, built-in `node:test`, JSONL storage, shell wrappers.

---

### Task 1: Scaffold Bubo Core Layout

**Files:**
- Create: `scripts/cli.js`
- Create: `scripts/lib/project.js`
- Create: `scripts/lib/store.js`
- Create: `scripts/lib/render.js`
- Create: `scripts/bubo-review-code`
- Create: `scripts/bubo-implement`
- Test: `tests/store.test.js`

- [ ] **Step 1: Write the failing storage test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureProjectState, appendReview, readReviews } = require('../scripts/lib/store')

test('store creates .bubo and appends project-scoped reviews', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-store-'))
  ensureProjectState(root)
  appendReview(root, { id: 1, rendered: 'first review', status: 'new' })
  const reviews = readReviews(root)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].rendered, 'first review')
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL with module-not-found or missing export errors for the Bubo storage module.

- [ ] **Step 3: Write minimal storage and project helpers**

```js
// scripts/lib/project.js
const fs = require('node:fs')
const path = require('node:path')

function resolveProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(start)
    current = parent
  }
}

module.exports = { resolveProjectRoot }
```

```js
// scripts/lib/store.js
const fs = require('node:fs')
const path = require('node:path')

function buboDir(root) {
  return path.join(root, '.bubo')
}

function ensureProjectState(root) {
  const dir = buboDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, 'state.json')
  const configPath = path.join(dir, 'config.json')
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({ nextId: 1, lastTriggerAt: {}, dedup: [] }, null, 2) + '\n')
  }
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      cooldowns: { turnMs: 30000, signalMs: 5000 },
      dedupWindow: 5,
      largeDiffThreshold: 80,
      provider: { kind: 'heuristic' }
    }, null, 2) + '\n')
  }
}

function appendReview(root, review) {
  ensureProjectState(root)
  fs.appendFileSync(path.join(buboDir(root), 'reviews.jsonl'), JSON.stringify(review) + '\n')
}

function readReviews(root) {
  const file = path.join(buboDir(root), 'reviews.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

module.exports = { ensureProjectState, appendReview, readReviews, buboDir }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/store.test.js`
Expected: PASS with one passing test and `.bubo/reviews.jsonl` created in the temp project.

### Task 2: Add Review Rendering and Structured Review Contract

**Files:**
- Create: `scripts/lib/review.js`
- Modify: `scripts/lib/render.js`
- Test: `tests/review.test.js`

- [ ] **Step 1: Write the failing review-shape test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')

const { renderReviewLine, normalizeReview } = require('../scripts/lib/render')

test('rendered review line omits labels but preserves problem, evidence, and solution order', () => {
  const review = normalizeReview({
    id: 213,
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts.',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution.',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns.'
  })

  assert.equal(
    renderReviewLine(review),
    'Code Review [213]: placeholder alert_id=0 can collide under concurrent speculative bursts. the diff introduces a fixed sentinel before VLM resolution. allocate a unique temporary client-side ID and reconcile after VLM returns.'
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review.test.js`
Expected: FAIL because the renderer and review normalization do not exist yet.

- [ ] **Step 3: Write minimal review normalization and rendering**

```js
// scripts/lib/render.js
function normalizeSentence(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function normalizeReview(input) {
  const review = {
    id: input.id,
    problem: normalizeSentence(input.problem),
    evidence: normalizeSentence(input.evidence),
    solution: normalizeSentence(input.solution)
  }
  review.rendered = `${review.problem} ${review.evidence} ${review.solution}`.replace(/\s+/g, ' ').trim()
  return review
}

function renderReviewLine(review) {
  return `Code Review [${review.id}]: ${review.rendered}`
}

module.exports = { normalizeReview, renderReviewLine }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/review.test.js`
Expected: PASS and rendered output contains no `Problem:`, `Evidence:`, or `Solution:` labels.

### Task 3: Implement Trigger Policy and Dedup

**Files:**
- Create: `scripts/lib/trigger.js`
- Modify: `scripts/lib/store.js`
- Test: `tests/trigger.test.js`

- [ ] **Step 1: Write the failing trigger-policy test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')

const { shouldTriggerReview } = require('../scripts/lib/trigger')

test('turn reviews respect cooldown while manual reviews bypass it', () => {
  const now = 50000
  const state = { lastTriggerAt: { turn: 40000 } }
  const config = { cooldowns: { turnMs: 30000, signalMs: 5000 } }

  assert.equal(shouldTriggerReview({ reason: 'turn', now, state, config }).allowed, false)
  assert.equal(shouldTriggerReview({ reason: 'manual', now, state, config }).allowed, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/trigger.test.js`
Expected: FAIL because the trigger module does not exist yet.

- [ ] **Step 3: Write minimal trigger policy**

```js
// scripts/lib/trigger.js
function cooldownFor(reason, config) {
  if (reason === 'turn') return config.cooldowns.turnMs
  if (reason === 'manual') return 0
  return config.cooldowns.signalMs
}

function shouldTriggerReview({ reason, now, state, config }) {
  const last = state.lastTriggerAt?.[reason] || 0
  const cooldown = cooldownFor(reason, config)
  if (cooldown === 0) return { allowed: true, reason }
  return { allowed: now - last >= cooldown, reason }
}

module.exports = { shouldTriggerReview }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/trigger.test.js`
Expected: PASS showing `turn` is blocked inside cooldown and `manual` is allowed.

### Task 4: Implement Heuristic Review Generation

**Files:**
- Create: `scripts/lib/generate.js`
- Test: `tests/generate.test.js`

- [ ] **Step 1: Write the failing heuristic-generation test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')

const { generateReview } = require('../scripts/lib/generate')

test('generator emits a sentinel-id collision review from diff evidence', async () => {
  const review = await generateReview({
    reason: 'large-diff',
    diffExcerpt: 'const draft = { alert_id: 0, status: \"pending\" }',
    toolOutputExcerpt: '',
    recentTurns: [],
    changedFiles: ['alerts.ts']
  }, { provider: { kind: 'heuristic' } })

  assert.match(review.problem, /collide|collision/i)
  assert.match(review.evidence, /alert_id: 0|fixed sentinel/i)
  assert.match(review.solution, /unique temporary|reconcile/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/generate.test.js`
Expected: FAIL because the generator does not exist yet.

- [ ] **Step 3: Write minimal heuristic generator**

```js
// scripts/lib/generate.js
const { normalizeReview } = require('./render')

function sentinelIdReview(packet) {
  const source = `${packet.diffExcerpt}\n${packet.toolOutputExcerpt}`
  if (!/alert_id\s*[:=]\s*0\b/.test(source)) return null
  return normalizeReview({
    problem: 'placeholder alert_id=0 can collide under concurrent speculative bursts',
    evidence: 'the diff introduces a fixed sentinel before VLM resolution',
    solution: 'allocate a unique temporary client-side ID and reconcile after VLM returns'
  })
}

function genericFailureReview(packet) {
  const source = `${packet.toolOutputExcerpt}`.trim()
  if (!source) return null
  return normalizeReview({
    problem: 'the current change set is already failing under observed execution',
    evidence: source.split('\n').find(Boolean) || 'recent tool output contains a failure signal',
    solution: 'fix the first failing assertion or exception before layering on more edits'
  })
}

async function generateReview(packet, config) {
  const sentinel = sentinelIdReview(packet)
  if (sentinel) return sentinel
  const failure = genericFailureReview(packet)
  if (failure) return failure
  return normalizeReview({
    problem: 'the latest change set may be harder to validate than it looks',
    evidence: packet.changedFiles.length ? `recent changes touch ${packet.changedFiles.join(', ')}` : 'recent conversation indicates active implementation work',
    solution: 'run a focused verification pass on the highest-risk changed path before continuing'
  })
}

module.exports = { generateReview }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/generate.test.js`
Expected: PASS and the generated review contains the expected sentinel-collision observation.

### Task 5: Implement Review IDs and Promotion by ID

**Files:**
- Modify: `scripts/lib/store.js`
- Create: `scripts/lib/promote.js`
- Test: `tests/promote.test.js`

- [ ] **Step 1: Write the failing promotion test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReview, readReviews } = require('../scripts/lib/store')
const { promoteReview } = require('../scripts/lib/promote')

test('promotion resolves review by ID and marks it promoted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-promote-'))
  const created = createReview(root, { reason: 'manual', rendered: 'test review', problem: 'p', evidence: 'e', solution: 's', context: {} })
  const promoted = promoteReview(root, created.id)

  assert.equal(promoted.id, created.id)
  assert.equal(promoted.status, 'promoted')
  assert.match(promoted.taskPrompt, /problem/i)
  const stored = readReviews(root).find((item) => item.id === created.id)
  assert.equal(stored.status, 'promoted')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/promote.test.js`
Expected: FAIL because ID allocation and promotion are not implemented.

- [ ] **Step 3: Write minimal promotion logic**

```js
// scripts/lib/promote.js
const { readReviews, rewriteReviews } = require('./store')

function promoteReview(root, id) {
  const reviews = readReviews(root)
  const review = reviews.find((item) => item.id === Number(id))
  if (!review) {
    throw new Error(`Review ${id} not found`)
  }
  review.status = 'promoted'
  review.taskPrompt = `Implement Bubo review ${review.id}.\nProblem: ${review.problem}\nEvidence: ${review.evidence}\nSolution: ${review.solution}`
  rewriteReviews(root, reviews)
  return review
}

module.exports = { promoteReview }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/promote.test.js`
Expected: PASS and the promoted review persists with status `promoted`.

### Task 6: Implement Codex-Oriented CLI Adapter and Wrappers

**Files:**
- Modify: `scripts/cli.js`
- Modify: `scripts/bubo-review-code`
- Modify: `scripts/bubo-implement`
- Test: `tests/cli.test.js`

- [ ] **Step 1: Write the failing CLI test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('review command prints compact inline note and writes project-scoped log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-cli-'))
  const result = spawnSync('node', [
    path.join(process.cwd(), 'scripts/cli.js'),
    'review-code',
    '--reason', 'manual',
    '--project', root,
    '--diff-text', 'const draft = { alert_id: 0 }'
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Code Review \[\d+\]:/)
  assert.ok(fs.existsSync(path.join(root, '.bubo', 'reviews.jsonl')))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli.test.js`
Expected: FAIL because the CLI adapter is not implemented yet.

- [ ] **Step 3: Write minimal CLI adapter**

```js
// scripts/cli.js
const { resolveProjectRoot } = require('./lib/project')
const { createReview, readConfig } = require('./lib/store')
const { generateReview } = require('./lib/generate')
const { renderReviewLine } = require('./lib/render')
const { shouldTriggerReview } = require('./lib/trigger')
const { promoteReview } = require('./lib/promote')

async function main(argv) {
  const [command, ...rest] = argv
  if (command === 'review-code') {
    // parse --reason, --project, --diff-text, --tool-output-text
    // build packet, enforce cooldown, create review, print rendered line
    return
  }
  if (command === 'implement') {
    // parse ID, promote review, print task prompt
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
```

- [ ] **Step 4: Add wrapper scripts**

```bash
#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/bubo/cli.js" review-code "$@"
```

```bash
#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/bubo/cli.js" implement "$@"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/cli.test.js`
Expected: PASS and `scripts/bubo-review-code` is now usable as a project command wrapper.

### Task 7: Verify the Whole Slice

**Files:**
- Test: `tests/store.test.js`
- Test: `tests/review.test.js`
- Test: `tests/trigger.test.js`
- Test: `tests/generate.test.js`
- Test: `tests/promote.test.js`
- Test: `tests/cli.test.js`

- [ ] **Step 1: Run all Bubo tests**

Run: `node --test tests/*.test.js`
Expected: All tests pass with zero failures.

- [ ] **Step 2: Run a manual review smoke test**

Run: `./scripts/bubo-review-code --reason manual --project "$(pwd)" --diff-text 'const draft = { alert_id: 0 }'`
Expected: prints a compact `Code Review [id]: ...` line and appends a matching entry to `./.bubo/reviews.jsonl`.

- [ ] **Step 3: Run a promotion smoke test**

Run: `./scripts/bubo-implement 1`
Expected: prints a task envelope for review `1` or a clear not-found error if the project log has a different starting ID.

- [ ] **Step 4: Document current limitation**

State explicitly in the implementation notes and final report:

- true inline host injection inside Codex is not part of this slice because no native Codex hook surface is available in the current environment
- the implemented CLI adapter is the promotion-ready bridge for a later host integration layer
