# Bubo Claude Code Adapter Design

## Summary

This is Phase 3 of the Codex-first design: a Claude Code adapter layered on the
same shared review core and the same `.bubo/` store. It adds passive,
hook-driven review injection and a native `/bubo` slash command, and it takes
advantage of capabilities that are specific to each host instead of forcing a
lowest-common-denominator integration.

## Goals

- Run Bubo on Claude Code with no change to the review core, the `.bubo/`
  layout, the trigger model, or promotion semantics.
- Inject passive notes automatically through Claude Code hooks rather than
  relying on the model to remember a skill.
- Expose Bubo as a native `/bubo` slash command, which Claude Code supports and
  Codex does not.
- Keep the Codex adapter behavior identical by extracting the shared startup and
  review-generation logic into a host-agnostic core both adapters call.

## Non-Goals

- No change to the heuristic/command review generator.
- No global cross-project store.
- No Claude-specific note format. The rendered line and the `problem` /
  `evidence` / `solution` contract are unchanged.

## Host Capability Mapping

The two hosts differ in how synthetic context reaches the model. The adapter
leans into each instead of papering over the difference.

| Capability | Codex | Claude Code |
| --- | --- | --- |
| Startup injection | Skill text in the launch prompt (`bubo-codex`) | `SessionStart` hook → `additionalContext` |
| Per-turn passive review | Skill instructs the model each turn | `UserPromptSubmit` hook → `additionalContext` |
| Signal-driven review (test-fail/error) | Skill reads visible tool output | `PostToolUse` (Bash) hook classifies exit code + output |
| Command surface | Bare `bubo review` (slash reserved) | Native `/bubo` slash command + bare phrasing |
| Dangerous-mode default | `--dangerously-bypass-approvals-and-sandbox` via wrapper | Standard Claude permission model |

## Architecture

### Shared Core (`scripts/lib/session.js`)

Extracted from the Codex wrapper so both adapters reuse it:

- `createStartReview(projectRoot, options)` — enforce the trigger gate, respect
  the per-project `enabled` flag, generate a review, persist it, and stamp the
  cooldown. A `freshOnly` option makes cooldown-blocked turns return `null`
  (instead of re-surfacing the prior note) so hook-driven turn injection never
  repeats itself.
- `buildStartupPrompt({ review, prompt, host })` — host-agnostic startup text.
  The `host` parameter selects the command-surface wording: Codex suppresses
  `/bubo`; Claude advertises the native slash command.

The Codex wrapper now delegates to this core and keeps its existing public
surface (`buildLaunchSpec`, `createStartReview`, `parseArgs`).

### Hook Handler (`scripts/lib/claude-hook.js` + `scripts/claude-hook.js`)

`handleHookEvent(event, deps)` is a pure, dependency-injected router. `deps`
overrides `projectRoot`, the clock, and the git readers for testing. It returns
the Claude hook output object or `null`.

- `SessionStart` → inject the skill + latest review as `additionalContext`.
- `UserPromptSubmit` → passive `turn` review from the working diff, fresh-only,
  gated by the `enabled` flag and cooldown.
- `PostToolUse` → classify Bash output into `test-fail` / `error` and review.
- Anything else → `null`.

`classifyToolEvent` reads `tool_output`/`tool_response` and `tool_exit_code`
defensively across Claude Code versions.

`scripts/claude-hook.js` is the thin stdin entrypoint registered in settings. It
reads the event JSON, calls the handler, prints JSON only when a note fires, and
**never** fails the host session (malformed input or errors exit 0 silently).

### Installer (`scripts/lib/install-claude.js`, `bubo install-claude`)

Scaffolds the integration into a target project, idempotently and
non-destructively:

- `.claude/settings.json` — merges the three hook registrations without
  duplicating Bubo's entry or disturbing unrelated hooks.
- `.claude/commands/bubo.md` — native `/bubo` slash command bound to the CLI via
  inline `` !`...` `` bash injection and `$ARGUMENTS`.

### Launcher (`scripts/claude-wrapper.js`, `scripts/bubo-claude`)

Optional parity with `bubo-codex`. Builds a `{ command: 'claude', cwd, args }`
spec that carries the startup context via `--append-system-prompt` (Claude takes
its working directory from the process cwd, so there is no `-C` flag).

## Safety Model

Unchanged from the core design. Every injected note carries an explicit inert
reminder, and only `implement <id>` (or `/bubo implement <id>`) creates
actionable intent. The hook handler is fail-open: a broken review must never
block the user's session.

## Testing Strategy

TDD throughout, `node:test` only:

- `tests/session.test.js` — shared startup prompt per host, fresh-id allocation,
  silent no-finding.
- `tests/claude-hook.test.js` — each hook event, the disabled toggle, cooldown
  freshness, tool classification.
- `tests/claude-wrapper.test.js` — launch spec shape and prompt passthrough.
- `tests/install-claude.test.js` — hook scaffold, slash command, idempotent
  merge that preserves existing settings.
- `tests/cli.test.js` — `install-claude` and the `claude-hook.js` entrypoint
  end-to-end.

## Follow-up: usefulness, speed, ease

A second pass tuned the three product axes the maintainer cares about, without
changing the skill prompt (Path B's wording is left as the source of truth).

### Expanded heuristic catalog (Path A)

`scripts/lib/generate.js` grew from five patterns to a curated, priority-ordered
catalog (security → correctness → hygiene): hardcoded secrets/keys,
`eval`/`exec` on dynamic input, string-built SQL, `Math.random` for security
values, destructive shell, sentinel IDs, focused/skipped tests, left-in
debuggers, checker suppression, `as any` escape hatches, empty catch, oversized
diff, and FIXME/XXX/HACK markers. Content scanning is scoped to **added** diff
lines (`reviewableSource`), so removing risky code never produces a finding.

### Reflection cadence (Path B shortcut)

A long-cooldown trigger (`reflectMs`, default 15 min) lets the model perform an
open-ended review the heuristics cannot express. `dueForReflection` /
`markReflection` live in the session core; the Claude `UserPromptSubmit` hook
emits `reflectionNudge()` as additional context when due. Path A (fast,
deterministic) is the always-on floor; Path B is the occasional deeper layer.

### Speed: lazy evidence + look-throttling

`createStartReview` now stamps the cooldown on every *look*, not only on emit,
and reads the working tree through lazy thunks (`getDiff` / `getChangedFiles`)
resolved only after the gate opens. Net effect: at most one `git diff` per
cooldown window, and none at all on a gated turn.

### Usefulness: dedup

A fresh note whose problem fingerprint matches a recent one is suppressed.
Explicit `manual` reviews are exempt — an on-demand `bubo review` always speaks.

### Ease: one-command install

`bubo install` detects the available hosts, scaffolds the Claude integration,
and prints the Codex alias. `install-claude` remains for Claude-only setup.

## Decisions Made

- Hook-based integration for Claude Code, not prompt-only.
- Heuristics (fast floor) and model review (occasional depth) are complementary
  generators, gated independently, sharing one `.bubo/` store.
- Content heuristics scan added lines only; security findings outrank hygiene.
- Cooldown throttles on look, not emit, so passive review is cheap.
- Shared core extracted so Codex and Claude cannot drift.
- `freshOnly` semantics prevent stale-note repetition on hook turns.
- Native `/bubo` slash command on Claude; bare phrasing retained for parity.
- Installer is idempotent and merge-safe.
