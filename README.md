# Bubo

Bubo is a passive code review companion for Codex **and Claude Code** sessions. The idea is simple: while you work, Bubo occasionally mutters one short, pointed observation about something likely to break, drift, or confuse. The note is context only. It does not become work until you explicitly promote it.

Both hosts run on the same shared core and the same project-scoped `.bubo/` store. Only the integration surface differs: Codex gets the skill injected into its startup prompt by a launcher wrapper, while Claude Code uses native hooks and a native `/bubo` slash command.

He is also, by design, a character. Bubo is an ancient golden war-owl: precise, patient, mildly amused by avoidable chaos, and prone to clipped verdicts like he already watched this bug ruin Argos once. Just as he once helped Perseus, he is now here to guide you. 

If you only need the practical version: Bubo stores project-scoped review notes in `.bubo/`, can generate and persist compact findings from diffs or tool output, and can inject a live-review skill into Codex startup so those notes appear naturally during a session.

## Requirements

Bubo has two layers:

- The CLI layer runs on Node.js and can be used directly from this repo.
- The interactive live-review workflow runs on a host:
  - **Codex** plus oh-my-codex (OMX). The `bubo-codex` launcher injects the repo-local `bubo-live-review` skill into the Codex session at startup.
  - **Claude Code**. `bubo install-claude` registers project hooks (SessionStart, UserPromptSubmit, PostToolUse) that inject passive notes automatically, plus a native `/bubo` slash command. No launcher wrapper is required, though `bubo-claude` is provided for parity.

In practice, if you want the full experience, assume you need:

- Node.js
- One host: the Codex CLI (with OMX) and/or Claude Code

There is no `package.json` install flow in this repo. The entrypoints are the checked-in scripts under [`scripts/`](./scripts).

## Installation

Clone the repo somewhere stable.  Recommend user home, because Bubo works with Codex and Claude.

```bash
git clone <your-remote> ~/bubo
cd ~/bubo
```

No npm install step is required for the current repo layout.

If you want a convenient shell entrypoint for Codex sessions with Bubo enabled, add this to `~/.zshrc` or `~/.bashrc`:

```bash
codex-bubo() {
  ~/bubo/scripts/bubo-codex --no-alt-screen "$@"
}
```

Reload your shell:

```bash
source ~/.zshrc
```

That wrapper keeps `--no-alt-screen` on by default. Any more dangerous Codex flags remain explicit and opt-in.

## Usage

### Launch Codex with Bubo

Recommended:

```bash
codex-bubo
```

Or call the wrapper directly:

```bash
./scripts/bubo-codex
```

If you want to forward explicit Codex flags, pass them through normally:

```bash
codex-bubo --dangerously-bypass-approvals-and-sandbox
```

You can also force a fresh startup review into the launch context:

```bash
codex-bubo --reason manual --diff-text 'const draft = { alert_id: 0 }'
```
### One-command install

From inside the project you want Bubo to watch:

```bash
node scripts/cli.js install --project "$(pwd)"
```

This detects which hosts you have, scaffolds the Claude Code integration into the project, and prints the Codex shell-alias snippet. Use it if you just want Bubo running with no further reading.

### Launch Claude Code with Bubo

Claude Code integrates through native hooks rather than a startup prompt. `bubo install` (above) does this for you, or you can target Claude explicitly:

```bash
node scripts/cli.js install-claude --project "$(pwd)"
```

This writes:

- `.claude/settings.json` — `SessionStart`, `UserPromptSubmit`, and `PostToolUse` hooks that call `scripts/claude-hook.js`. The hook reads the event JSON on stdin and, when a review fires, injects the passive note into the session via `hookSpecificOutput.additionalContext`. It stays silent and exits cleanly when nothing fires, so it never disrupts the session.
- `.claude/commands/bubo.md` — a native `/bubo` slash command. `/bubo review`, `/bubo consider <id>`, `/bubo implement <id>`, `/bubo start`, `/bubo stop`, and `/bubo status` all work.

The install is idempotent and merges into any existing `.claude/settings.json` without clobbering unrelated hooks.

Trigger mapping on Claude Code:

- `SessionStart` injects the live-review skill and the latest stored note as context.
- `UserPromptSubmit` runs a passive `turn` review against the working diff (subject to cooldown and the per-project enable flag), surfacing at most one fresh note per turn.
- `PostToolUse` (Bash) classifies failing output into a `test-fail` or `error` review so Bubo speaks up exactly when something just broke.
- On a slow cadence, `UserPromptSubmit` also injects an open-ended model-review nudge (Path B) so Bubo periodically reviews with judgment, not just patterns.

A convenience launcher is also available if you prefer to start sessions through a wrapper:

```bash
./scripts/bubo-claude
```

### Control Bubo inside a Codex session

When Bubo is active in-session, use plain commands in chat. On Codex, do not prefix them with `/` (Codex reserves slash commands). On Claude Code, the same commands also work as native slash commands (`/bubo review`, `/bubo implement <id>`, …).

- `bubo review` or `bubo review-code` generates a review immediately
- `bubo consider <id>` or `bubo consider-<id>` evaluates a stored review before implementation
- `bubo implement <id>` or `bubo implement-<id>` promotes a stored review into actual work
- `bubo stop` disables live review for the current project session
- `bubo start` re-enables live review for the current project session
- `bubo status` reports whether Bubo is currently enabled

## How It Works

Bubo stores project-local state in `.bubo/`:

- `reviews.jsonl` contains persisted review records
- `state.json` tracks IDs, cooldowns, and whether the session is enabled
- `config.json` stores thresholds and provider configuration

Each review record can contain:

- `rendered`: the short line shown to the user
- `problem`: the concrete issue
- `evidence`: why Bubo thinks it is real
- `solution`: the proposed correction

The live-review skill keeps those notes inert by default. A Bubo note is not a task. It becomes actionable only when you explicitly promote it with `bubo implement <id>`.

### Two ways a note is generated

Bubo has two independent generators that write into the same store:

- **Heuristics (Path A, default, fast).** Pure pattern matching over the *added* lines of your diff — no model call. The curated catalog covers, in priority order: hardcoded secrets and private keys, `eval`/`exec` on dynamic input, string-built SQL (injection), `Math.random` for security values, destructive shell (`rm -rf`, force-push, pipe-to-shell), sentinel IDs, focused/skipped tests (`.only`, `.skip`, `fit`), left-in debuggers (`debugger`, `pdb.set_trace`, `pry`), checker suppression (`@ts-ignore`, `eslint-disable`, `# type: ignore`, `@SuppressWarnings`), `as any` / `as unknown as` escape hatches, empty `catch {}`, oversized diffs, `FIXME`/`XXX`/`HACK` markers, and failure signals in tool output. Scanning is scoped to added lines, so removing risky code never trips a note.
- **Model review (Path B, occasional, deeper).** On a long cooldown (default 15 minutes) Bubo asks the host model to perform one open-ended review of recent work — design risk, drift, subtle correctness — the kind of judgment regex can't express, persisted with `record-review`. This is governed by the `bubo-live-review` skill, not the heuristics.

Near-duplicate notes are suppressed: if a fresh observation matches one Bubo already made recently, it stays quiet (an explicit `bubo review` is never suppressed). The working diff is read lazily and at most once per cooldown window, so passive review adds no per-prompt git cost during an editing burst.

### Use the CLI directly

Generate a review from a diff or text excerpt:

```bash
node scripts/cli.js review-code --reason manual --diff-text 'const draft = { alert_id: 0 }'
```

The alias `review` works too:

```bash
node scripts/cli.js review --reason manual --diff-text 'const draft = { alert_id: 0 }'
```

Persist a fully structured passive note directly:

```bash
node scripts/cli.js record-review \
  --reason turn \
  --rendered 'sentinel id. race bait. mint a temp id first' \
  --problem 'a fixed sentinel id can collide under concurrency' \
  --evidence 'the diff assigns alert_id = 0 before the async resolver returns' \
  --solution 'use a unique temporary id and reconcile after resolution'
```

Review helper wrappers are also available:

- `./scripts/bubo-review-code`
- `./scripts/bubo-consider <id>`
- `./scripts/bubo-implement <id>`
- `./scripts/bubo-codex`

## Running Tests

```bash
node --test tests/*.test.js
```

## The Owl

In ***Clash of the Titans***, the god Hephaestus forged a mechanical owl from gleaming clockwork and living ruby. Athena sent this creation, Bubo, to watch over Perseus on his impossible quest. Part scout, part guardian, and wholly endearing, Bubo clicked and whirred his way through ancient dangers with a loyalty that never wavered (even when his landings left something to be desired). Bubo proved to be the smallest, strangest, most loyal companion.

This project carries that name and that spirit. Bubo is your real-time coding assistant: a tireless, watchful companion perched alongside you as you work, ready to guide you through the hard parts.

Bubo started as an attempt to keep the best part of passive review behavior without turning it into another noisy workflow. The reference point was the feeling of a second intelligence in the room, one that notices the crack in the beam before the roof caves in, but does not seize the keyboard or demand ceremony.

That is why Bubo is deliberately narrow. He emits one observation, not a checklist. He is passive by default, not self-authorizing. He stores the longer reasoning under the hood, but speaks in compressed verdicts. The line should feel like a warning scratched into bronze, not a Jira ticket.

The personality rules matter because they constrain the product:
- Bubo should be precise, not chatty.
- He should sound old, not cute.
- Mild amusement is fine; theatrical snark is not.
- He should feel like a witness to repeated engineering mistakes, not a mascot trying to be helpful.

