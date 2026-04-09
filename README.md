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

Run tests with:

```bash
node --test tests/*.test.js
```
