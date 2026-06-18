---
title: "Reflect re-architecture: pure capture, delete auto-apply — dagrunner self-change plan"
related: "the big one; first feature under the TDD rule; touches every node prompt → run smoke:live before done"
created: 2026-06-18
status: ready
---

# Reflect re-architecture — pure capture, delete auto-apply

## Context (read first)
Today reflection is a **capture → auto-apply pipeline**: the `reflect` node *synthesises* two
proposal flavors (Camunda knowledge for `DEVHARNESS_SRC`; dagrunner improvements), Gate 4 approves,
and `apply-reflection` *auto-applies* the approved proposals under **4 hard guardrails** (path
allowlist, private-only/never-`git add`, exact-approved-diffs, snapshot-before-apply) with
`dagrun revert-reflection` to undo. See `payload/commands/reflect.md`, `apply-reflection.md`,
`feature-workflow.ts` (the `reflect`/`apply-reflection` nodes + Gate 4), and master-doc §147.

This is complex and bakes judgment into the runtime. **Decision:** make reflection **pure,
distributed capture** and move synthesis **off-graph**. Each node (and, via a companion Camunda
change, both siblings, and the human) appends raw tips/gotchas to a **durable** log that **outlives
the run** (survives run-dir cleanup / deletion). Periodically, a human + architect harvest reads the
log and routes by kind (knowledge → `DEVHARNESS_SRC`; harness → a dagrunner plan). No auto-apply.

Precedent to reuse: the `store/` dir already exists (XDG data, created at setup, checked by
preflight), and a durable-JSONL-in-store append pattern already exists (`apply-reflection` writes
`store/proposals/proposals.jsonl`). The new sink is a cleaner sibling written by a distributed
primitive instead of a gated batch.

## Rationale
Auto-apply carries real risk and complexity (4 guardrails + backup/revert) for modest benefit, and a
synthesis *node* puts judgment on the critical path. Pure capture is simple, durable, and puts
synthesis where judgment belongs — the human+architect harvest. Capture must live in `store/`, not
`runs/<id>/`, precisely so a node's note isn't lost when the run is cleaned up or deleted.

## The change (directional)

| File / module | Type | Change (directional) | Why |
|---|---|---|---|
| `src/...` append module + `src/cli/cli.ts` | CREATE | `dagrun reflect-append` — append one JSONL entry to `store/reflection-log.jsonl`. Entry: `{ ts, source, run_id?, kind, body }`. Creates `store/` + file if absent; one JSON object per line | the single durable write path ("code coordinates") |
| every `payload/commands/*.md` node prompt | MODIFY | add a **closing, fail-soft** step: append tips/gotchas via `dagrun reflect-append` after `produces` are written | distributed capture |
| `feature-workflow.ts` — `reflect` + `apply-reflection` nodes | DELETE | remove both node objects; `pr` becomes terminal | end at pr |
| `payload/commands/reflect.md`, `apply-reflection.md` | DELETE | the synthesizer + the auto-applier | gone |
| `apply-reflection` machinery | DELETE | 4 guardrails, `CLAUDE.local.md` write path, settings-seed `additionalDirectories`, backup/`manifest.json`, `dagrun revert-reflection` (cli `cmdRevertReflection` + usage + case), old `store/proposals/proposals.jsonl` write path | excise auto-apply |
| docs: master-doc (§147, §9, Phase-2b row), charter (reflection remit), `STATUS.md`; `DECISIONS.md` | MODIFY | reflect the new model | anti-drift |

**Things to get right**
- **TDD — first feature under the rule.** `reflect-append` (+ the append module) is deterministic →
  **failing test first**: creates file/dir if absent, appends valid one-line JSONL, schema fields
  present, append is additive (doesn't clobber), fail-soft on a bad call. Teeth-check.
- **Durability:** sink is `store/reflection-log.jsonl` (XDG store), **not** `runs/<id>/` — outlives
  run deletion. `run_id` is an *optional* field for traceability, not the storage scope.
- **Capture is best-effort, never blocks shipping.** A failed append must NOT fail the node (mirrors
  Gate 4's old "never blocks shipping" posture). Node prompts call it last, fail-soft.
- **Clean removal — risk class for the builder:** sweep ALL `reflect`/`apply-reflection` refs.
  `tsc` catches code; **grep** for prompt/doc/hook refs (report.ts display, preflight, any
  `stop-*` hook branch, DECISIONS). Don't trust the obvious list.
- **kind taxonomy:** `camunda-knowledge | dagrunner-harness` (matches the old Flavor-1/2 split + the
  harvest routing).
- **Touches every node prompt → run `smoke:live`** before done; `smoke:mock` can't judge the prompts.
- **Charter is in Project knowledge** → Eddie re-adds the updated copy after the edit.

## Validation (prove it — evidence, not assertion)
- `reflect-append` unit tests green (create-if-absent, additive append, schema, fail-soft); teeth-check
  (break a branch → red).
- `smoke:mock` green after node removal — pipeline ends at `pr`, wiring intact.
- `smoke:live`: a full run → `store/reflection-log.jsonl` holds entries from **multiple** nodes,
  each tagged `source` + `run_id` + `kind`; an induced append failure does NOT fail the run.
- `dagrun revert-reflection` is gone; `apply-reflection` node gone; `grep -rI "apply-reflection"` →
  zero in live code/prompts/active docs; `tsc` clean.

## Done criteria (delta-specific)
- `dagrun reflect-append` built + unit-tested; nodes append (fail-soft, last step).
- Auto-apply subsystem fully removed; `pr` terminal.
- `smoke:live` shows multi-node capture into the durable store.
- Master doc + charter + STATUS + DECISIONS reconciled; charter re-added to Project knowledge.

## Out of scope
- **Sibling capture** (ci-babysit, pr-triage calling `dagrun reflect-append`) — a **companion Camunda
  private `.claude/` change**, separate plan/repo.
- **The harvest itself** — a periodic human + architect process, not code.
- `dagrun reflect-export` / dump helpers — defer unless trivially free.
- **Mechanically** migrating `store/proposals/proposals.jsonl` into the new log (different content
  model — old = synthesized proposals, new = raw signal). NOT abandoned: the file held two Flavor-2
  entries, **both already independently resolved** (pr body.md path discipline; format-hook narrowed
  to frontend) — verified during grounding. So the file is **drained**; once `apply-reflection`'s
  write path is removed here, delete the (now dead, fully-harvested) runtime file as cleanup.
