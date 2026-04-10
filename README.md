# Bubo

Bubo is a passive code review companion for Codex sessions. The idea is simple: while you work, Bubo occasionally mutters one short, pointed observation about something likely to break, drift, or confuse. The note is context only. It does not become work until you explicitly promote it.

He is also, by design, a character. Bubo is an ancient golden war-owl: precise, patient, mildly amused by avoidable chaos, and prone to clipped verdicts like he already watched this bug ruin Argos once. That flavor is the differentiator. The implementation exists to make the voice useful instead of decorative.

If you only need the practical version: Bubo stores project-scoped review notes in `.bubo/`, can generate and persist compact findings from diffs or tool output, and can inject a live-review skill into Codex startup so those notes appear naturally during a session.

## Requirements

Bubo has two layers:

- The CLI layer runs on Node.js and can be used directly from this repo.
- The interactive live-review workflow depends on Codex plus oh-my-codex (OMX). The launcher wrapper injects the repo-local `bubo-live-review` skill into the Codex session at startup.

In practice, if you want the full experience, assume you need:

- Node.js
- Codex CLI
- oh-my-codex (OMX)

There is no `package.json` install flow in this repo. The entrypoints are the checked-in scripts under [`scripts/`](/home/danie906/bubo/scripts).

## Installation

Clone the repo somewhere stable:

```bash
git clone <your-remote> ~/bubo
cd ~/bubo
```

No npm install step is required for the current repo layout.

If you want a convenient shell entrypoint for Codex sessions with Bubo enabled, add this to `~/.zshrc`:

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

### Control Bubo inside a Codex session

When Bubo is active in-session, use plain commands in chat. Do not prefix them with `/`.

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

The current default provider is heuristic. Out of the box, Bubo knows how to notice a few specific messes, such as fixed sentinel IDs, swallowed exceptions, `@ts-ignore` suppression, large diffs, and obvious recent failures in visible tool output.

## Running Tests

```bash
node --test tests/*.test.js
```

## Below The Fold: The Owl

Bubo started as an attempt to keep the best part of passive review behavior without turning it into another noisy workflow. The reference point was the feeling of a second intelligence in the room, one that notices the crack in the beam before the roof caves in, but does not seize the keyboard or demand ceremony.

That is why Bubo is deliberately narrow. He emits one observation, not a checklist. He is passive by default, not self-authorizing. He stores the longer reasoning under the hood, but speaks in compressed verdicts. The line should feel like a warning scratched into bronze, not a Jira ticket.

The personality rules matter because they constrain the product:

- Bubo should be precise, not chatty.
- He should sound old, not cute.
- Mild amusement is fine; theatrical snark is not.
- He should feel like a witness to repeated engineering mistakes, not a mascot trying to be helpful.

If he sounds decorative, the prompt is wrong. If he sounds like a second project manager, the product is wrong.
