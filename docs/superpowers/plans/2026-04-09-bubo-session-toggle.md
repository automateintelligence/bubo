# Bubo Session Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default launch bypass flags plus in-session Bubo `start`, `stop`, and `status` controls without requiring a Codex restart.

**Architecture:** Extend the existing Bubo project state with an `enabled` flag, expose it through a small `session` CLI surface, and update the wrapper prompt and skill text so Bubo stays default-on but can be paused and resumed inside a running session. Keep the change project-scoped and reuse the current `.bubo` store and Codex wrapper.

**Tech Stack:** Node.js, built-in `node:test`, existing Bubo CLI and wrapper scripts

---

### Task 1: Add store coverage for default enabled state

**Files:**
- Modify: `scripts/lib/store.js`
- Test: `tests/store.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('store defaults Bubo session state to enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-state-'))
  ensureProjectState(root)
  const state = readState(root)
  assert.equal(state.enabled, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL because `enabled` is not present in the default state object.

- [ ] **Step 3: Write minimal implementation**

```js
const DEFAULT_STATE = {
  nextId: 1,
  lastTriggerAt: {},
  dedup: [],
  enabled: true
}
```

Use `DEFAULT_STATE` in both `ensureProjectState()` and `readState()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/store.js tests/store.test.js
git commit -m "test: add default Bubo enabled state"
```

### Task 2: Add CLI session start, stop, and status commands

**Files:**
- Modify: `scripts/cli.js`
- Test: `tests/cli.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test('session stop disables Bubo and session start re-enables it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-session-'))
  const repoRoot = path.resolve(__dirname, '..')

  const stop = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'session',
    'stop',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(stop.status, 0)
  assert.match(stop.stdout, /disabled/i)

  const statusOff = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'session',
    'status',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(statusOff.status, 0)
  assert.match(statusOff.stdout, /disabled/i)

  const start = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'session',
    'start',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(start.status, 0)
  assert.match(start.stdout, /enabled/i)

  const statusOn = spawnSync('node', [
    path.join(repoRoot, 'scripts/cli.js'),
    'session',
    'status',
    '--project', root
  ], { encoding: 'utf8' })

  assert.equal(statusOn.status, 0)
  assert.match(statusOn.stdout, /enabled/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli.test.js`
Expected: FAIL with `Unknown command: session`.

- [ ] **Step 3: Write minimal implementation**

```js
function runSession(positionals, options) {
  const action = positionals[1]
  const projectRoot = resolveProjectRoot(options.project || process.cwd())
  ensureProjectState(projectRoot)
  const state = readState(projectRoot)

  if (action === 'start') {
    state.enabled = true
    writeState(projectRoot, state)
    process.stdout.write('Bubo session enabled.\n')
    return 0
  }

  if (action === 'stop') {
    state.enabled = false
    writeState(projectRoot, state)
    process.stdout.write('Bubo session disabled.\n')
    return 0
  }

  if (action === 'status') {
    process.stdout.write(`Bubo session is ${state.enabled === false ? 'disabled' : 'enabled'}.\n`)
    return 0
  }

  throw new Error('Usage: bubo session <start|stop|status>')
}
```

Dispatch it from `main()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cli.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cli.js tests/cli.test.js
git commit -m "feat: add Bubo session controls"
```

### Task 3: Add wrapper default flag and session control instructions

**Files:**
- Modify: `scripts/codex-wrapper.js`
- Modify: `skills/bubo-live-review/SKILL.md`
- Modify: `README.md`
- Test: `tests/codex-wrapper.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('wrapper injects bypass flag and documents Bubo session controls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubo-wrapper-'))
  const spec = buildLaunchSpec({
    projectRoot: root,
    review: null,
    forwardedArgs: ['--no-alt-screen']
  })

  assert.ok(spec.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.match(spec.args.at(-1), /active by default/i)
  assert.match(spec.args.at(-1), /\\/bubo stop/i)
  assert.match(spec.args.at(-1), /\\/bubo start/i)
  assert.match(spec.args.at(-1), /\\/bubo status/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codex-wrapper.test.js`
Expected: FAIL because the bypass flag and session control text are missing.

- [ ] **Step 3: Write minimal implementation**

```js
function withDefaultLaunchFlags(forwardedArgs) {
  const args = [...forwardedArgs]
  if (!args.includes('--dangerously-bypass-approvals-and-sandbox')) {
    args.unshift('--dangerously-bypass-approvals-and-sandbox')
  }
  return args
}
```

Use the normalized args in `buildLaunchSpec()` and update the startup prompt text to describe default-on Bubo plus `/bubo stop`, `/bubo start`, and `/bubo status`.

Update the skill so these phrases are treated as session-control requests through the CLI.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-wrapper.test.js`
Expected: PASS

- [ ] **Step 5: Run full verification**

Run: `node --test tests/*.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/codex-wrapper.js skills/bubo-live-review/SKILL.md README.md tests/codex-wrapper.test.js
git commit -m "feat: streamline Bubo launch and session toggles"
```
