# Bubo Session Toggle Design

## Goal

Reduce startup friction for Bubo while preserving its current default behavior.

## Requirements

- `./scripts/bubo-codex` should launch Codex with `--dangerously-bypass-approvals-and-sandbox` by default.
- Bubo should remain enabled by default when launched through the Bubo wrapper.
- `/bubo stop` should disable live Bubo review for the current project during the running session.
- `/bubo start` should re-enable live Bubo review after it has been stopped.
- `/bubo status` should report whether live Bubo review is currently enabled for the project.
- The toggle mechanism should not require restarting Codex.
- The implementation should stay within this repository and should not depend on undocumented Codex or OMX host command registration.

## Non-Goals

- Registering a true host-native slash command with Codex or OMX.
- Global Bubo enablement across unrelated projects.
- Expanding Bubo into a broader command router beyond start, stop, and status handling.

## Approach Options

### Option 1: Prompt-only convention

Teach the skill to interpret `/bubo start` and `/bubo stop` as plain in-band command text.

Pros:
- Very small change
- No extra storage work

Cons:
- Fragile if the session did not start with Bubo instructions already injected
- No durable project-side session flag to inspect

### Option 2: CLI-backed session toggle

Add explicit CLI support for toggling a Bubo enabled flag in `./.bubo/state.json`, and update the live-review skill instructions so the running agent treats `/bubo start` and `/bubo stop` as session-control phrases.

Pros:
- Works inside the current session without restart
- Keeps behavior project-scoped and inspectable
- Reuses existing Bubo storage and CLI surfaces

Cons:
- Slightly more code than a pure prompt-only convention

### Recommendation

Use Option 2.

## Detailed Design

### 1. Wrapper default flag

Update the Codex launch spec builder so `--dangerously-bypass-approvals-and-sandbox` is injected automatically unless it is already present in forwarded arguments.

This change belongs in `scripts/codex-wrapper.js`.

### 2. Session toggle state

Extend `./.bubo/state.json` with a boolean session toggle, named `enabled`, defaulting to `true` when the Bubo project state is created.

Semantics:
- `enabled: true` means the live-review skill may emit Bubo notes when its trigger rules match.
- `enabled: false` means the live-review skill should suppress review emission until it is re-enabled.

The toggle is project-scoped. It does not need a separate global store.

### 3. CLI command surface

Extend `scripts/cli.js` with a small session control surface:

- `bubo session start`
- `bubo session stop`
- `bubo session status`

These commands should:
- resolve the project root
- ensure project state exists
- update or read the `enabled` flag
- print compact confirmation text suitable for reuse in a Codex response

### 4. Skill behavior

Update `skills/bubo-live-review/SKILL.md` so the running agent interprets:

- `/bubo start` as a request to re-enable Bubo in the current project by invoking the CLI
- `/bubo stop` as a request to disable Bubo in the current project by invoking the CLI
- `/bubo status` as a request to report the current enabled state by invoking the CLI

When disabled, the skill should not emit Bubo review notes on later turns.

The command phrases are treated as Bubo control input, not as host-native slash command registration.

### 5. Startup prompt wording

Update the startup prompt built by `scripts/codex-wrapper.js` so it tells the session:

- Bubo is active by default
- `/bubo stop` disables it for this project
- `/bubo start` re-enables it
- `/bubo status` reports the current state

This keeps the command surface discoverable without needing a restart.

## Files Expected To Change

- `scripts/codex-wrapper.js`
- `scripts/cli.js`
- `scripts/lib/store.js`
- `skills/bubo-live-review/SKILL.md`
- `tests/codex-wrapper.test.js`
- `tests/cli.test.js`
- likely a new focused state test if current coverage is insufficient

## Risks

- The running agent must actually follow the updated skill instructions for in-band `/bubo start` and `/bubo stop` to work cleanly.
- If the session was not launched with Bubo instructions, the CLI toggle alone cannot make the model start honoring Bubo automatically. This design is intended for sessions started through the Bubo wrapper, with mid-session stop/start after that point.

## Acceptance Criteria

- Launching via `./scripts/bubo-codex` includes `--dangerously-bypass-approvals-and-sandbox`.
- The launch prompt states that Bubo is active by default and documents `/bubo stop` and `/bubo start`.
- Running the new CLI session stop command flips the project flag off.
- Running the new CLI session start command flips the project flag on.
- Running the new CLI session status command reports the current state accurately.
- Tests cover the new wrapper flag injection and the new session toggle behavior.
