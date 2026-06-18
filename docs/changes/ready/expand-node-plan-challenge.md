---
title: "Empower expand to challenge the plan's implementation — dagrunner self-change plan"
related: "ready; touches node prompts → run smoke:live before done"
created: 2026-06-18
status: ready
---

# Empower `expand` to challenge the plan's implementation

## Context (read first)
`payload/commands/expand.md` today only **elaborates**: "read the feature plan… write a concise
implementation guide… under 200 words." It does no critical evaluation of the plan's proposed
*implementation*. Observed in a real run: a feature-task plan authored from a git issue (which itself
specified a solution path) **invented its own implementation that diverged from the issue**, and
`expand` silently elaborated it — the divergence wasn't caught until much later.

Crucially, the channel for catching this **already exists**: `expand → Gate 1` (human reviews
`guide.md`, can reject with feedback). The gap is that `expand` surfaces nothing to challenge — it
only elaborates, so the human has nothing to react to at Gate 1.

## Rationale
`expand` should be the **safety net for plan quality**: critically evaluate the proposed
implementation against the requirement (and the linked source issue, if present), and **push back**
when the plan over-specifies, diverges from the issue, or is incomplete — rather than blindly
elaborating. The requirement belongs in the plan; detailed implementation is `expand`'s job, and when
the plan over-prescribes implementation, `expand` challenges it. The push-back is **advisory** (it
surfaces at Gate 1), not a hard block.

## The change (directional)

| File / module | Type | Change (directional) | Why |
|---|---|---|---|
| `payload/commands/expand.md` | MODIFY | add a critical-evaluation step: assess the plan's proposed implementation vs the requirement and the **linked source issue** (if present); when it over-specifies, diverges, or is incomplete, surface a **"Concerns / plan challenges"** section in `guide.md` — while still producing a usable guide. Relax the 200-word cap when concerns warrant it. | empower expand to push back through the existing Gate 1 channel |
| docs (master doc / a feature-task authoring note) | MODIFY | note that feature-task plans should faithfully capture the requirement + acceptance (incl. the source issue's solution path) and keep implementation **directional**, leaving detail to `expand` | reduce over-prescription at the source |

**Things to get right**
- **Use Gate 1, don't invent a gate.** `expand` writes concerns into `guide.md`; the human reviews and
  can reject→feedback at the existing Gate 1. No new node/gate.
- **Elaborate AND challenge** — `expand` still produces a usable implementation guide; the challenge is
  an advisory section, not a refusal or hard stop.
- **Consult the source issue if the plan links one** — to check the plan faithfully captured the
  requirement / any prescribed solution path. Confirm how the issue is referenced/reachable from
  `plan.md`; if it isn't reachable, challenge based on the requirement as stated.
- **Don't cry wolf** — a clean, well-scoped plan should yield no spurious challenges.
- **Node-prompt change → run `smoke:live`** before done; `smoke:mock` can't judge prompt quality.

## Validation (prove it — evidence, not assertion)
- `smoke:live`: a run with an over-specified / diverging plan → `guide.md` carries a concerns section;
  a clean plan → no spurious challenges. Human-reviewed.
- The guide still elaborates a usable implementation (doesn't just refuse/block).
- `verify-baseline` (`smoke:mock`) green — the prompt change doesn't break wiring.

## Done criteria (delta-specific)
- `expand.md` critically evaluates and surfaces plan challenges in `guide.md` for Gate 1; still
  produces a usable guide.
- `smoke:live` shows it challenges a bad plan and doesn't over-flag a good one.
- Authoring guidance noted in docs; master doc / `architecture-spec` reconciled.

## Out of scope
- A new gate/node for plan-challenge (use Gate 1).
- Auto-rejecting/blocking on disagreement (advisory only).
- Building a formal feature-task plan template (separate, if wanted).
