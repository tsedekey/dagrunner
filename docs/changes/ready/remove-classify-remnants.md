---
title: "Remove dormant classify remnants — dagrunner self-change plan"
related: "ready; touches payload prompts (classify.md delete + reviewer edits) → run smoke:live before done"
created: 2026-06-18
status: ready
---

# Remove dormant `classify` remnants

## Context (read first)
The `classify` node was removed earlier (reviewer-selection became `review`'s internal diff-triage),
but **dormant scaffolding remains**, kept for a hypothetical future return (Phase 5/6 task-type
routing). Decision (Eddie): **remove it fully** — when task-type routing (bug / tech-debt / refactor)
is actually added, design it **fresh** from current understanding rather than reviving stale code.

Remnants found across: `src/core/types.ts` (`ClassifyOutput`), `src/workflow/workflow.ts`
(`validateClassifyOutput` + a `/classify-again` ref), `src/workflow/feature-workflow.ts`
(`CLASSIFY_SCHEMA`), `src/runtime/run-engine.ts`, `src/runtime/sdk-runner.ts`,
`payload/commands/classify.md`, **5 `payload/agents/reviewer-*.md`**, the 2a tests that cover
`validateClassifyOutput` (`workflow.test.ts`, and mentions in `dag.test.ts` / `state.test.ts` /
`feature-workflow.test.ts`), and the `stop-schema` hook (matched `DAGRUN_NODE_ID == "classify"`).
Plus forward-references in the charter + master doc.

## Rationale
Dormant code is dead weight and a drift risk (it reads as live, ages silently, and constrains future
design). A future task-type router should be designed from current understanding, not shaped by stale
scaffolding.

## The change (directional)

| File / module | Type | Change | Why |
|---|---|---|---|
| `payload/commands/classify.md` | DELETE | the dormant command | not wired |
| `src/core/types.ts` — `ClassifyOutput` | DELETE | dormant type | unused |
| `src/workflow/workflow.ts` — `validateClassifyOutput`, classify refs, `/classify-again` | DELETE | dormant validation + routing | unused |
| `src/workflow/feature-workflow.ts` — `CLASSIFY_SCHEMA` | DELETE | dormant schema | unused |
| `src/runtime/run-engine.ts`, `src/runtime/sdk-runner.ts` — classify refs | MODIFY/DELETE | remove dormant refs | unused |
| tests: `workflow.test.ts` (validateClassifyOutput), `dag.test.ts`, `state.test.ts`, `feature-workflow.test.ts` — classify refs | MODIFY/DELETE | remove tests of removed code | keep suite honest |
| `.claude/hooks/stop-schema.sh` — the `classify` match branch | MODIFY | remove the dead branch | no classify node to match |
| `payload/agents/reviewer-*.md` (5) — classify mentions | MODIFY | strip stale classify references | accuracy |
| charter (Trajectory) + master doc — "classify returns" forward-ref | MODIFY | reframe: future task-type routing **designed fresh**, not "classify returns" | reflect the decision |

**Things to get right**
- **Sweep ALL classify references — risk class for the builder.** Code refs fail `tsc` if missed
  (good), but prompts, the hook branch, fixtures, and docs need a grep sweep — don't trust the obvious
  list.
- **Remove `validateClassifyOutput` and its tests together** — the 2a backfill added those; they go
  with the code.
- **Charter is in Project knowledge** → after the charter edit, Eddie re-adds the updated copy there
  (anti-drift).
- **Touches payload prompts** (classify.md delete + reviewer-agent edits) → **run `smoke:live`** before
  done.
- Confirm nothing live depends on classify (it's dormant — `typecheck` + `smoke:mock` confirm).

## Validation (prove it — evidence, not assertion)
- `verify-baseline` (`smoke:mock`) green after removal.
- `grep -rI classify` → **zero** in live code, prompts, or active docs (changelog / historical-plan
  mentions are fine).
- `smoke:live` green — reviewer prompts changed.

## Done criteria (delta-specific)
- All classify scaffolding gone: code, schema, type, command, tests, the hook branch, reviewer
  mentions.
- Charter + master-doc forward-refs reframed to "designed fresh"; charter re-added to Project
  knowledge.
- `verify-baseline` green; `smoke:live` green.

## Out of scope
- Designing the future task-type router (plan fresh when the time comes).
- `review`'s diff-triage — that's the live replacement; it stays.
