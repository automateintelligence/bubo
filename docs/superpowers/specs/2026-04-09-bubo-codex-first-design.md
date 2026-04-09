# Bubo Codex-First Design

## Summary

Bubo is a per-project, always-on review monitor that produces short, inline code review notes inspired by the `/buddy` review behavior, without the character UI, snark, or autonomous action.

The first implementation target is Codex. Claude support follows later through a separate adapter layered on the same review core.

## Goals

- Surface high-signal review observations inline in the conversation before the user asks for them.
- Preserve each review note in a per-project log under `./.bubo/`.
- Keep Bubo notes visible to the agent while making them non-actionable by default.
- Allow explicit promotion of a logged review note into a task via a stable review ID.
- Reuse the same core review prompt, trigger model, and storage across Codex and Claude adapters.

## Non-Goals

- No ASCII companion or character rendering.
- No roleplay, snark, or personality-driven UI.
- No automatic implementation of review notes.
- No attempt to replace full code review or static analysis.
- No global cross-project review log.

## Product Constraints

- Bubo output must be very short.
- Output should be generated as three internal fields:
  - `problem`
  - `evidence`
  - `solution`
- Inline rendering should omit labels and read as compact prose.
- Generic turn-based review should use a roughly 30 second cooldown.
- The system must support serendipitous review on normal turns, not only hard failure signals.
- The review store must be project-scoped and shared across Codex and Claude.

## User Experience

### Passive Review

When Bubo fires, it injects a synthetic inline note into the conversation in this form:

`Code Review [213]: placeholder alert_id=0 can collide under concurrent speculative bursts. the diff introduces a fixed sentinel before VLM resolution. allocate a unique temporary client-side ID and reconcile after VLM returns.`

This note is:

- visible in conversation context
- persisted in `./.bubo/reviews.jsonl`
- intentionally non-actionable unless the user explicitly promotes it

### Explicit Commands

Canonical command surface:

- `bubo-review-code`
- `bubo-implement-<id>`

Examples:

- `bubo-review-code`
- `bubo-implement-213`

Semantics:

- `bubo-review-code` forces a review run immediately and bypasses the generic cooldown.
- `bubo-implement-213` resolves review `213`, converts it into an explicit work instruction, and marks the review as promoted in the log.

## Architecture

The system is split into a shared review core and a host-specific adapter.

### Shared Core

The shared core owns:

- trigger evaluation
- cooldown and dedup policy
- evidence packet assembly
- review generation prompt
- review ID assignment
- review log persistence
- promotion semantics

### Codex Adapter

The Codex adapter owns:

- reading recent conversation context
- reading recent tool output
- reading current project diff and changed file summary
- invoking the shared core when a trigger fires
- injecting the rendered note inline as a synthetic review annotation
- translating `bubo-review-code` and `bubo-implement-<id>` into core operations

### Future Claude Adapter

The Claude adapter should reuse the same shared core and `.bubo` layout, but integrate with Claude hook surfaces and transcript injection separately.

## Context Model

Bubo should review a bounded evidence packet instead of the entire session.

Each review request should include:

- `reason`
- `cwd`
- `timestamp`
- `recent_turns`
- `tool_output_excerpt`
- `changed_files`
- `diff_excerpt`
- `recent_reviews`

### Recent Turns

Use the most recent bounded window of conversation turns, separated by role:

- recent `user` messages
- recent `assistant` messages

Target behavior:

- enough context to understand the current implementation thread
- not enough context to drift into broad speculative advice

### Tool Output Excerpt

Use only recent high-signal output:

- failing test output
- exception traces
- fatal or error output
- diff-like output

Clamp tool-output payload size aggressively.

### Workspace Snapshot

Include:

- changed files
- compact diff summary
- top changed hunks when `large-diff` fires

## Trigger Model

### Supported Reasons

- `turn`
- `test-fail`
- `error`
- `large-diff`
- `manual`

The old buddy reasons `hatch` and `pet` are intentionally excluded.

### Generic Turn Trigger

The `turn` trigger remains enabled because it enables useful serendipitous review.

Policy:

- only fire when enough fresh context exists
- respect a 30 second cooldown
- suppress low-signal repetition

### Hard-Signal Triggers

These can bypass or shorten cooldown:

- `test-fail`
- `error`
- `large-diff`
- `manual`

### Trigger Detection

Initial heuristics should mirror buddy-like logic:

- `test-fail`: detected from recent tool output matching failure patterns
- `error`: detected from exception, traceback, panic, fatal, or non-zero error patterns
- `large-diff`: detected from diff-like output or a changed-line threshold
- `turn`: periodic opportunity review when other gates allow it

## Cooldown and Dedup

### Cooldown

Default cooldowns:

- `turn`: 30 seconds
- `test-fail`: reduced cooldown or bypass
- `error`: reduced cooldown or bypass
- `large-diff`: reduced cooldown or bypass
- `manual`: no cooldown

### Dedup

Suppress near-duplicate notes using:

- recent `problem` similarity
- overlapping changed file set
- same trigger reason inside the cooldown window

Dedup should reduce repetition without hiding materially new observations.

## Review Generation Contract

The review generator should return structured output:

```json
{
  "problem": "string",
  "evidence": "string",
  "solution": "string",
  "rendered": "string"
}
```

Generation rules:

- exactly one observation per review
- concrete and evidence-backed
- no labels in `rendered`
- very short output
- no speculation beyond visible evidence
- no direct commands to the user
- no assumption that the suggestion will be implemented

### Rendered Output

The rendered string should read as compact prose:

- sentence 1: problem
- sentence 2: evidence
- sentence 3: solution

The adapter prefixes the visible note with the review ID:

- `Code Review [213]: <rendered>`

## Review Store

Project state lives in `./.bubo/`.

### Files

- `./.bubo/reviews.jsonl`
- `./.bubo/state.json`
- `./.bubo/config.json`

Optional later:

- `./.bubo/reviews.md`

### reviews.jsonl Entry Shape

Each entry should include:

- `id`
- `timestamp`
- `reason`
- `problem`
- `evidence`
- `solution`
- `rendered`
- `status`
- `context`

Status values:

- `new`
- `promoted`
- `dismissed`
- `implemented`

### state.json

State should include only operational metadata:

- next review ID
- last trigger times by reason
- dedup fingerprints

## Promotion Semantics

Inline Bubo notes are inert by default.

Only explicit commands promote them into user intent.

### Manual Review

`bubo-review-code`

Behavior:

- force a new review immediately
- write the review to log
- inject the note inline

### Promotion

`bubo-implement-<id>`

Behavior:

- resolve the review entry by ID
- validate that the ID exists in the current project log
- create an explicit task envelope for the agent
- mark the entry as `promoted`

The promotion envelope should preserve the original fields:

- problem
- evidence
- solution

This prevents lossy conversion from note to task.

## Safety Model

The agent must distinguish between:

- user-authored intent
- synthetic Bubo review annotations

Rules:

- Bubo annotations are visible but non-authoritative
- the agent must not treat them as if the user requested action
- the agent may reference them when relevant
- the agent may ignore them when clearly wrong or stale
- only explicit promotion commands create actionable intent

## Codex-First Implementation Plan

### Phase 1

Build the shared core plus Codex adapter:

- `.bubo` store
- trigger evaluator
- bounded context builder
- review generation contract
- inline synthetic note injection
- `bubo-review-code`
- `bubo-implement-<id>`

### Phase 2

Tune trigger quality and logging ergonomics:

- better dedup
- configurable thresholds
- optional markdown mirror
- review listing and dismissal helpers

### Phase 3

Build the Claude adapter:

- hook-based integration
- same `.bubo` store
- same review generator contract
- same promotion semantics

## Testing Strategy

### Unit Tests

- trigger classification
- cooldown logic
- dedup logic
- ID allocation
- command parsing
- promotion semantics
- rendered output formatting

### Integration Tests

- `turn` trigger produces review under expected conditions
- `test-fail` trigger uses recent failing tool output
- `large-diff` trigger clamps evidence size
- promoted reviews become explicit actionable tasks
- passive reviews remain non-actionable

### Regression Tests

- duplicate reviews are suppressed
- wrong or empty review payloads fail safely
- corrupted `.bubo` state can be recovered without data loss

## Risks

- Inline synthetic review notes may still be over-interpreted by the host unless adapter boundaries are explicit.
- Generic `turn` review can become noisy if cooldown and dedup are too weak.
- Review quality will degrade if evidence packets are too small or too broad.
- Host-specific transcript plumbing may diverge unless the shared core contract remains strict.

## Decisions Made

- Codex adapter ships first.
- Claude adapter ships later on the same core.
- Storage is project-scoped under `./.bubo/`.
- Generic `turn` trigger is retained.
- Review notes are short and unlabeled in the conversation.
- Internal schema remains structured as `problem`, `evidence`, and `solution`.
- Review IDs are stable and used for promotion.

