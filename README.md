# Bubo

Bubo is a Codex-first review monitor inspired by Claude `/buddy` review behavior, without the character UI.

Current slice:

- project-scoped review storage in `./.bubo/`
- short rendered review notes
- explicit promotion by review ID
- Codex-oriented CLI adapter

Primary commands:

- `./scripts/bubo-review-code`
- `./scripts/bubo-implement <id>`
- `./scripts/bubo-codex`

Run tests with:

```bash
node --test tests/*.test.js
```

Start Codex with passive Bubo context:

```bash
./scripts/bubo-codex --project "$PWD" -- --no-alt-screen
```

Force a fresh startup review into the launch context:

```bash
./scripts/bubo-codex --project "$PWD" --reason manual --diff-text 'const draft = { alert_id: 0 }' -- --no-alt-screen
```
