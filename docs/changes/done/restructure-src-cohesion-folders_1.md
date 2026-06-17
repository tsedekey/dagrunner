---
title: "Restructure src/ into cohesion folders (relocate-only) — dagrunner self-change plan"
related: "none (core hardening, step 1 of 2: restructure then test)"
created: 2026-06-17
status: approved
---

# Restructure `src/` into cohesion folders (relocate-only)

## Context (read first)

`src/` is 16 flat `.ts` files. Group them into 5 shallow (one-level) folders by
**cohesion-of-change**, ahead of the unit-test backfill and future feature work. This is the
foundation-locking step before tinkering — so it is a **pure relocation, no decomposition**, kept
end-to-end-coverable by the existing smoke test.

The sharp edge: `dagrunnerRoot` is computed at **three sites** — `cli.ts:89`,
`run-engine.ts:146`, `run-engine.ts:701` — via `new URL("../", import.meta.url)`. That path is
resolved against the **compiled `dist/` location**, not the source. tsconfig (`rootDir: ./src` ->
`outDir: ./dist`, `include: src/**/*.ts`) preserves folder structure, so a file moved into
`src/runtime/` runs from `dist/runtime/` and needs one extra `../` to climb back to repo root.

## Root cause / rationale

Flat `src/` doesn't signal what changes together, and that matters more once we accrete features.
Cohesion-of-change folders make the "never break this" core legible and give unit tests + TDD a
stable home. Relocate-only keeps behavior identical, so smoke + typecheck are a valid safety net for
the move.

## The change (directional)

**Taxonomy (relocate only):**

| Folder          | Files                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| `src/core/`     | `dag.ts`, `state.ts`, `lock.ts`, `types.ts` (+ `dag.test.ts` beside `dag.ts`) |
| `src/workflow/` | `workflow.ts`, `feature-workflow.ts`                                          |
| `src/runtime/`  | `run-engine.ts`, `sdk-runner.ts`, `mock-executor.ts`, `launcher.ts`           |
| `src/config/`   | `xdg.ts`, `settings-seed.ts`                                                  |
| `src/cli/`      | `cli.ts`, `preflight.ts`, `report.ts`                                         |

**Plus the path/entry-point fixes:**

| File / module                                                                              | Type                | Change (directional)                                                                 | Why                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `cli.ts:89`, `run-engine.ts:146`, `run-engine.ts:701` — `new URL("../", import.meta.url)`  | MODIFY              | `../` -> `../../` (all three move one level deeper; count from the `dist/` location) | else `dagrunnerRoot` resolves to `dist/`, payload/`.claude` seed paths miss, guard fires |
| `package.json` `bin.dagrun` (`./dist/cli.js`) and the `dagrun` script (`tsx ./src/cli.ts`) | MODIFY              | repoint to the new path (`./dist/cli/cli.js`, `./src/cli/cli.ts`)                    | the binary + run-from-source entry must follow the move                                  |
| all inter-module relative imports across the 16 files                                      | MODIFY (mechanical) | re-path to new homes                                                                 | must compile                                                                             |
| `tsconfig.json`, `npm test` glob (`src/**/*.test.ts`)                                      | NONE                | both already handle subfolders                                                       | —                                                                                        |

**Folded-in sub-task (independent of the move): delete the deprecated `verify-seed` stub.**
`payload/commands/verify-seed.md` is a dead redirect stub — it is NOT a node in the workflow graph
(was removed in Phase 2b, replaced by `/verify`). Delete it and sweep its live references:

| File / module                                                             | Type   | Change                                        | Why                                             |
| ------------------------------------------------------------------------- | ------ | --------------------------------------------- | ----------------------------------------------- |
| `payload/commands/verify-seed.md`                                         | DELETE | remove the deprecated stub                    | not wired into the graph; replaced by `/verify` |
| `payload/commands/verify.md`, `.claude/skills/architecture-spec/SKILL.md` | MODIFY | remove/repoint live mentions of `verify-seed` | keep live command body + design doc accurate    |
| `DECISIONS.md`, `docs/changes/*.md`                                       | LEAVE  | historical changelog / plan records           | not drift — they're the record                  |

**Things to get right**

- **`../` -> `../../` is relative to `dist/`, not source.** A file moved into a one-level folder runs
  from `dist/<folder>/` and needs one more `../`. All three `dagrunnerRoot` sites move one level
  deeper, so all become `../../`. If the builder places any file at a different depth, count levels
  from the `dist/` root and adjust per-file.
- **`bin` path.** `package.json` `bin.dagrun` -> `./dist/cli/cli.js`, and the `dagrun` npm script's
  `tsx` path -> `./src/cli/cli.ts`, or the installed/linked binary and `npm run dagrun` break.
- **Relocate only - do NOT decompose.** The large mixed-concern files (`run-engine` ~28K, `cli`
  ~22K, `preflight` ~17K) move whole. No signature or behavior changes - that's what keeps smoke a
  valid net. Decomposition is a separate, test-first job for later.
- **Sweep ALL imports - risk class for the builder.** Every relative import between the 16 modules
  changes. `tsc --noEmit` (typecheck) is the fail-loud net: a missed import won't compile. Don't
  hand-enumerate; let typecheck drive it to zero.
- Confirm there is no _other_ `import.meta.url` / `__dirname` usage beyond the three found (quick grep
  before finalizing).
- **The `verify-seed` delete is behavior-neutral** — the stub isn't in the graph and nothing invokes
  it, so deleting it doesn't change runtime and keeps smoke a valid net for this plan. Don't touch the
  changelog/historical plan-doc mentions; only the live body in `verify.md` + the design doc.

## Validation (prove it - evidence, not assertion)

- **`npm run verify-baseline` exits 0** - typecheck catches every re-pathed import; smoke runs the
  full pipeline and, because it seeds a worktree, exercises the `../../` `dagrunnerRoot` fix live.
- **`dagrun preflight`** runs without error (exercises the `cli.ts:89` `dagrunnerRoot` site).
- **Seeded run:** a smoke/live run copies `payload/` + `.claude/hooks` into the worktree with the
  "bundled commands not found" guard **not** firing - proves `dagrunnerRoot` still resolves to repo
  root after the move.
- **`dagrun` launches** (binary or `npm run dagrun`) - proves the `bin`/script repoint.
- `src/` now contains only the 5 folders (no stray flat `.ts`).
- **`verify-seed` gone:** `payload/commands/verify-seed.md` deleted; `grep -rI 'verify-seed'` returns
  only changelog/historical-plan mentions — none in live command bodies or the design doc.

## Done criteria (delta-specific)

- All 16 files relocated to the agreed taxonomy; `dag.test.ts` co-located with `core/dag.ts`; nothing
  decomposed.
- Deprecated `verify-seed.md` deleted and live references swept.
- Three `dagrunnerRoot` sites re-depthed; `bin` + `dagrun` script repointed.
- `verify-baseline` green; a seeded run resolves payload from repo root (guard silent).
- README repo-layout section + master doc (and charter, if it names file paths) reconciled in the
  same commit.

## Out of scope

- Decomposing any large file - separate, test-first, later.
- Adding unit tests - the **next** iteration (step 2 of the hardening).
- The node rename and the reflect re-architecture.
