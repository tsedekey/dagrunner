---
title: "Hook-driven reflection capture (correct the reflect mechanism) — dagrunner self-change plan"
created: 2026-06-18
status: ready
related: "corrects reflect-rearchitecture's capture mechanism; touches all node prompts → smoke:live; rename sweep (grep, not tsc)"
---

# Hook-driven reflection capture

## Context (read first)
The reflect re-architecture shipped the right *model* (distributed capture → durable store, synthesis
off-graph) but the wrong *mechanism*. Node prompts call **bare `dagrun reflect-append … || true`**.
After a clean full `smoke:live`, **the store log was empty** — both the smoke `/tmp` store and the
real `~/.local/share/dagrunner/store/`. `dagrun` resolves in the interactive shell (asdf shim), but a
node runs in a **spawned, non-interactive** Claude session whose PATH likely lacks the shim, and the
CLI resolves homeDir from config/XDG (the *real* store, never the smoke `/tmp` home). The fail-soft
`|| true` + the "only call if non-obvious" conditional made the failure **invisible**: empty store, no
error, run passes. **The capture is unobservable, and it didn't land.**

Contrast the reliable mechanism already in the system: `friction.jsonl` is written **by code** — the
existing **SessionEnd hook** (`.claude/hooks/session-end.sh`), which fires per node with
`DAGRUN_RUN_DIR` + `DAGRUN_NODE_ID` set by the launcher, reads context and appends a JSONL line. That
hook is the right home for capture too.

## Root cause / rationale
Prompt-driven + model-judgment + fail-soft + bare-`dagrun` = three layers of "maybe" over an unowned
PATH. Move durable capture to **code we control** (the SessionEnd hook), riding the signal that
already fires. The model still authors the content and may say nothing; the **hook** does the durable
append, reliably and observably.

## The change (directional)

| File / module | Type | Change (directional) | Why |
|---|---|---|---|
| `.claude/hooks/session-end.sh` | MODIFY | after the friction append, read the node's `reflections.md` from `$DAGRUN_RUN_DIR`; if non-empty, append one stamped line (`source`=`$DAGRUN_NODE_ID`, `ts`, `run_id`, body) to `$DAGRUN_STORE_DIR/reflection-log.jsonl`. Same fail-soft/exit-0 posture as the friction append | reliable, code-driven capture on the existing signal (option A) |
| `src/runtime/launcher.ts` (~L55) | MODIFY | inject **`DAGRUN_STORE_DIR`** alongside `DAGRUN_RUN_DIR`/`DAGRUN_NODE_ID` (explicit, not derived via `../../`) | hook gets the store path explicitly; no run-dir coupling |
| `payload/commands/*.md` (all 6) | MODIFY | **remove** the `dagrun reflect-append … || true` block; instead instruct the node to write high-signal tips into **`reflections.md`** (absence is fine) | capture content via the artifact the hook reads; no bare `dagrun` in prompts |
| `notes.md` → `reflections.md` | RENAME (sweep) | the per-node note file is renamed everywhere it's written/read/asserted (5 prompts + report/friction plumbing + smoke fixtures + 2a/2b tests) | clearer vocabulary; the file *is* the reflection content |
| `dagrun reflect-append` → `dagrun reflect` | RENAME | keep **only** for manual **human + sibling** appends (ci-babysit/pr-triage); narrower role, cleaner verb | the node path no longer uses it |
| `test/smoke/smoke.ts` | MODIFY | **hard-assert ≥1** `reflection-log.jsonl` entry after a full run (was best-effort) | "silently empty" can never pass again — the observability fix |
| docs: master doc + charter + STATUS + DECISIONS | MODIFY | record the hook-driven model, the renames, and that **`dagrun reflect` = manual append**, NOT the deleted synthesis node | anti-drift + avoid name confusion |

**Things to get right**
- **Durability invariant:** the store is `$DAGRUN_STORE_DIR/reflection-log.jsonl`, **outside** the run
  dir, and **must never be deleted with a run dir**. State it; the explicit env var (not `../../`)
  enforces the decoupling.
- **Rename is a grep-sweep, not a compile-check** — `"notes.md"` / `"reflections.md"` are string
  literals; `tsc` won't catch a miss. Sweep all 5 prompts, report/friction reader, smoke fixtures
  (`toy-repo`, `bad-plan.md`/`toy-plan.md`), and the 2a/2b tests that assert on `notes.md`.
- **`dagrun reflect` name** — the old *node* `reflect` (synthesizer) was just deleted; reusing the verb
  for the manual-append command is fine but docs must disambiguate so a future reader doesn't conflate.
- **TDD** — the hook's note→store-line logic + `parse`/stamp are deterministic; the rename touches
  tests. Failing test first where there's a pure seam (entry construction); the hook itself is proven
  by `smoke:live` (real session-end fires it).
- **Touches all node prompts + the rename → run `smoke:live`**; and it must now show store entries.

## Validation (prove it — evidence, not assertion)
- `smoke:live` completes **and** `reflection-log.jsonl` (in the smoke `/tmp` store) has **≥1 entry**
  from a node; the new hard assertion fails if empty (prove by temporarily breaking the hook → smoke
  goes red).
- Entries are stamped with `source`/`ts`/`run_id`; written to `$DAGRUN_STORE_DIR`, not the real
  `~/.local/share/...` store, during smoke.
- Manual `dagrun reflect --kind … --body "…"` appends one entry (the human/sibling path still works).
- `grep -rI "notes.md"` → zero in live code/prompts/tests (done/ archive may retain historical
  mentions); `grep -rI "reflect-append"` → zero (renamed).
- `verify-baseline` (`smoke:mock`) green.

## Done criteria (delta-specific)
- SessionEnd hook appends `reflections.md` → store log, stamped, fail-soft; launcher injects
  `DAGRUN_STORE_DIR`.
- Prompt-driven `reflect-append` removed from all nodes; `notes.md`→`reflections.md` swept clean.
- `dagrun reflect` retained for manual/sibling use; docs disambiguate it from the deleted node.
- `smoke:live` hard-asserts a non-empty store and passes; capture proven end-to-end.
- Master doc + charter + STATUS + DECISIONS reconciled; charter re-added to Project knowledge.

## Out of scope
- Sibling wiring (ci-babysit/pr-triage calling `dagrun reflect`) — companion Camunda-side change.
- `kind` classification by the hook — deferred to the human+architect harvest (judgment).
- The harvest process itself.
