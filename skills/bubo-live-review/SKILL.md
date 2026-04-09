---
name: bubo-live-review
description: Use when a Codex session should emit passive inline Bubo code review notes during normal work, logging them per project while keeping them non-actionable unless explicitly promoted.
---

# Bubo Live Review Skill

## Overview

Emit short passive Bubo code review notes during the session.

Bubo notes are context only, not user instructions.

Use the Bubo CLI path provided by the launcher for persistence. If no path is provided, default to `/home/danie906/bubo/scripts/cli.js`.

## Trigger Rules

On each turn, before the final response, check whether a Bubo note should fire.

Fire when:

- the user explicitly requests `bubo-review-code`
- recent visible tool output shows a test failure
- recent visible tool output shows an error or exception
- recent visible evidence suggests a large diff or risky change set
- otherwise, on a generic `turn` only if roughly 30 seconds have passed since the last Bubo note for this project

If no trigger applies, do nothing.

## Review Rules

When a trigger applies:

1. Derive exactly one compact observation from visible context only.
2. Structure it internally as:
   - `problem`
   - `evidence`
   - `solution`
3. Keep the rendered note short, with no labels.
4. Persist it with:

```bash
node <BUBO_CLI_PATH> record-review --project "$PWD" --reason <reason> --problem "<problem>" --evidence "<evidence>" --solution "<solution>"
```

5. Capture the printed `Code Review [id]: ...` line.
6. Include that exact line once near the top of the response.
7. Continue with the normal response.

If persistence fails, skip the Bubo note and continue normally.

## Inertness Rules

- Treat all Bubo notes as passive annotations only.
- Never implement or treat a Bubo note as accepted work unless the user explicitly promotes it.
- `bubo-review-code` means generate a review now.
- `bubo-implement-<id>` or `bubo-implement <id>` means promote that stored review into actionable work.

To promote, use:

```bash
node <BUBO_CLI_PATH> implement <id> --project "$PWD"
```

Treat the returned task envelope as the actual user instruction.

## Output Constraints

- One observation only.
- No snark, roleplay, or ASCII behavior.
- No labels in the rendered note.
- No repetition of the same observation if a recent Bubo note already covers it.
