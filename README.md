# Bubo

Bubo is a Codex-first review monitor inspired by Claude `/buddy` review behavior, without the character UI.

Current slice:

- project-scoped review storage in `./.bubo/`
- short rendered review notes
- explicit promotion by review ID
- Codex-oriented CLI adapter
- Codex skill for live passive Bubo review behavior during a session

Primary commands:

- `./scripts/bubo-review-code`
- `./scripts/bubo-implement <id>`
- `./scripts/bubo-codex`

Run tests with:

```bash
node --test tests/*.test.js
```

Install the Codex skill locally:

```bash
ls -la ~/.codex/skills/bubo-live-review
```

Start Codex with the Bubo skill activated for the session:

```bash
./scripts/bubo-codex --project "$PWD" -- --no-alt-screen
```

Force a fresh startup review into the launch context:

```bash
./scripts/bubo-codex --project "$PWD" --reason manual --diff-text 'const draft = { alert_id: 0 }' -- --no-alt-screen
```

What the skill does:

- emits passive inline `Code Review [id]: ...` notes during the session when trigger conditions apply
- logs those notes into `./.bubo/reviews.jsonl`
- keeps them non-actionable unless you explicitly promote one with `bubo-implement <id>`
