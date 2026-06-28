# Bubo Claude Code Adapter Implementation Plan

**Goal:** Add a Claude Code adapter on the same shared review core and `.bubo/`
store as the Codex adapter, using Claude-native hooks and a native `/bubo` slash
command, built test-first.

**Status:** Implemented. All tasks below shipped green (`node --test tests/*.test.js`).

---

### Task 1: Extract a host-agnostic session core

- [x] Write `tests/session.test.js` for `buildStartupPrompt({ host })` and
  `createStartReview`.
- [x] Create `scripts/lib/session.js` with `createStartReview` (now honoring the
  `enabled` flag and a `freshOnly` option) and a host-parameterized
  `buildStartupPrompt`.
- [x] Refactor `scripts/codex-wrapper.js` to delegate to the core; keep its
  existing tests green.

### Task 2: Claude hook handler

- [x] Write `tests/claude-hook.test.js` covering SessionStart, UserPromptSubmit,
  PostToolUse, the disabled toggle, cooldown freshness, and tool classification.
- [x] Create `scripts/lib/claude-hook.js` (`handleHookEvent`, `classifyToolEvent`).
- [x] Create `scripts/claude-hook.js` stdin entrypoint that never breaks the host
  session.

### Task 3: Claude launcher

- [x] Write `tests/claude-wrapper.test.js` for the `claude` launch spec.
- [x] Create `scripts/claude-wrapper.js` (`buildLaunchSpec` via
  `--append-system-prompt`, cwd-based) and `scripts/bubo-claude`.

### Task 4: Installer + slash command

- [x] Write `tests/install-claude.test.js` (hook scaffold, `/bubo` command,
  idempotent merge).
- [x] Create `scripts/lib/install-claude.js` and wire `bubo install-claude` into
  the CLI.
- [x] Add CLI end-to-end coverage for `install-claude` and the hook entrypoint.

### Task 5: Docs + skill

- [x] Make `skills/bubo-live-review/SKILL.md` host-neutral and document the
  Codex vs Claude command surface.
- [x] Update `README.md` with the Claude Code install + trigger mapping.
- [x] Add the design spec under `docs/superpowers/specs/`.

### Task 6: Usefulness / speed / ease follow-up

- [x] Expand the Path A heuristic catalog (`tests/generate.test.js`,
  `scripts/lib/generate.js`); scan added diff lines only.
- [x] Add the Path B reflection cadence (`dueForReflection`, `markReflection`,
  `reflectionNudge`, `reflectMs` config) and wire it into the Claude
  `UserPromptSubmit` hook.
- [x] Make evidence reading lazy + throttle the cooldown on every look (speed).
- [x] Suppress duplicate notes, exempting explicit `manual` reviews (usefulness).
- [x] Add a one-command `bubo install` that detects hosts (ease).

### Verification

- [x] `node --test tests/*.test.js` — all tests pass (64).
- [x] `node scripts/cli.js install` smoke test scaffolds settings + command and
  prints the Codex alias.
- [x] `node scripts/claude-hook.js` smoke test injects a note from a PostToolUse
  failure event, emits the reflection nudge on a fresh project, and stays silent
  on benign input.
