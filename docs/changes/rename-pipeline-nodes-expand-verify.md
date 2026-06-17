---
title: "Rename pipeline nodes: expand-guide → expand, verify-guide → verify — dagrunner self-change plan"
related: "none (naming ergonomics)"
created: 2026-06-17
status: approved
---

# Rename pipeline nodes: `expand-guide` → `expand`, `verify-guide` → `verify`

## Context (read first)

Five of the seven feature-pipeline nodes are already single words (implement, review, fix, pr,
reflect). Two are not — `expand-guide`, `verify-guide`. Rename those two so the pipeline reads as
clean one-word steps: **expand → implement → review → fix → verify → pr → reflect**.

Node IDs are **load-bearing**, not labels. In `src/feature-workflow.ts` each node declares an `id`,
a `command` (the slash command invoked), and `dependsOn` (referencing other nodes _by id_). The run
engine keys artifact directories by node id (`runs/<run-id>/<node-id>/`), and the command file in
`payload/commands/` is named to match the slash command. **Clean break** — no migration of existing
runs' `state.json`.

## Root cause / rationale

Purely ergonomic: symmetry and recall of one-word steps. The `-guide` suffix did signal that these
two nodes emit _guide_ artifacts (implementation guide, manual-test guide) — we accept losing that
hint; the docs already spell it out.

## The change (directional)

| File / module                                                                                                                                                       | Type                              | Change (directional)                                                                    | Why                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/feature-workflow.ts` — node defs (~L126 `expand-guide`, ~L156 `verify-guide`) + the `dependsOn` refs (implement→`expand-guide` ~L133; pr→`verify-guide` ~L166) | MODIFY                            | `id` + `command` → `expand`/`/expand`, `verify`/`/verify`; update both `dependsOn` refs | the graph definition; ids/commands/deps move together |
| `payload/commands/expand-guide.md`, `verify-guide.md`                                                                                                               | RENAME → `expand.md`, `verify.md` | filename must match the slash command                                                   | invocation resolves by filename                       |
| `src/types.ts`                                                                                                                                                      | MODIFY (verify)                   | if node ids are a literal union/enum, update the two members                            | compile-time correctness                              |
| `payload/commands/{implement,review,pr,reflect,apply-reflection,verify-seed}.md`                                                                                    | MODIFY                            | update in-body cross-references to the two old names                                    | runtime prompts stay accurate                         |
| `docs/dagrunner-master-architecture.md`, the pipeline graph, `.claude/skills/architecture-spec`, author agents that name them                                       | MODIFY                            | reconcile references                                                                    | anti-drift                                            |
| `test/smoke/smoke.ts` + `toy-repo` fixture, `src/dag.test.ts`                                                                                                       | MODIFY                            | update node-id expectations                                                             | clean-break tests                                     |
| `.claude/hooks/session-start.sh` (comment ~L65)                                                                                                                     | MODIFY                            | fix the stale `classify/expand-guide/implement` comment                                 | accuracy only — no matcher change                     |

**Things to get right**

- **`id`, `command`, and `dependsOn` move together.** Renaming a node's id without the `dependsOn`
  refs to it in other nodes leaves a dangling edge — load-time graph validation should fail loud;
  don't suppress it.
- **Rename the command _files_, don't just edit their contents.** `/expand` needs `expand.md`. A
  filename mismatch makes the node invoke an unknown slash command → SDK no-op at cost 0 (the exact
  silent-failure class dagrunner exists to avoid).
- **Clean break — no migration.** Do NOT add `state.json` node-id migration. New runs only; any
  in-flight run carrying old ids won't resume. Acceptable here; `dagrun cleanup`/`clear` any stale
  runs first. (Builder: confirm there's no in-flight run worth preserving before the cutover.)
- **Sweep ALL references — risk class for the builder.** Beyond the obvious sites: `run-engine.ts`,
  `workflow.ts`, `types.ts`, `dag.test.ts`, `smoke.ts`, _every_ command body, the architecture-spec
  skill, and the toy-repo fixture. Don't trust the obvious list — a literal node-id union in
  `types.ts` will fail typecheck if missed (good, fail-loud).
- Hooks: only `"classify"` is matched functionally; these two have no hook matcher. Comment-only fix.

## Validation (prove it — evidence, not assertion)

- **`npm run verify-baseline` exits 0** — catches the union type, graph wiring, and smoke
  expectations in one shot.
- **Graph wiring:** loading the workflow yields nodes `expand` and `verify`, all `dependsOn` resolve,
  and there are no dangling `*-guide` ids (load-time validation passes).
- **Live/smoke run:** artifact dirs are `runs/<id>/expand/` and `runs/<id>/verify/` (not `-guide`),
  and both nodes actually invoke `/expand` and `/verify` and write their artifacts — i.e. they
  execute, not cost-0 no-ops.
- **Tree grep:** `grep -rI 'expand-guide\|verify-guide'` returns only intentional historical mentions
  (e.g. a `DECISIONS.md` changelog line) — zero in live code, command bodies, or active docs.

## Done criteria (delta-specific)

- `feature-workflow.ts` uses `expand`/`verify` across id + command + dependsOn; command files renamed
  to match.
- A run produces `expand/` and `verify/` artifact dirs and both nodes execute (proven, not asserted).
- No stray `*-guide` references in live code, command bodies, or active docs (changelog mentions ok).
- Master doc + pipeline graph + `DECISIONS.md` reconciled in the same commit.

## Out of scope

- The reflection re-architecture (the _other_ iteration — don't touch `reflect` / `apply-reflection`
  / `classify` here).
- Renaming any other node.
- Any migration path for old runs (clean break by decision).
