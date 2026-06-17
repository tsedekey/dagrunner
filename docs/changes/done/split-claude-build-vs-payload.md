---
title: "Split .claude/ into build-harness vs runtime payload — dagrunner self-change plan"
related: "none (context-hygiene refactor)"
created: 2026-06-17
status: approved
---

# Split `.claude/` into build-harness vs runtime payload

## Context (read first)

dagrunner's `.claude/` serves two unrelated audiences from one namespace:

- A Claude Code session **building dagrunner** auto-loads everything under `.claude/`.
- At **runtime**, `run-engine.ts` bundles and copies the _entire_ `.claude/{commands,agents,hooks}`
  into each Camunda worktree. Source paths `srcCommands` / `srcAgents` / `srcHooks` are rooted at
  `dagrunnerRoot/.claude/` via `new URL("../", import.meta.url)`, at **two seed sites**: initial
  seed (~L146–171) and re-seed on resume (~L700–711).

Consequences of the conflation, both directions:

1. Runtime payload — 10 pipeline commands + 7 `reviewer-*` agents — pollutes a _builder's_ context.
2. The 6 build author/researcher agents get shipped into _every Camunda worktree_, where they're
   useless.
3. Adding `/dr-build` to `.claude/commands` would leak it into worktrees the same way.

## Root cause / rationale

One namespace, two audiences. Fix = physical separation:

- `.claude/` = **build-only**, auto-loaded for sessions editing dagrunner, never seeded.
- `payload/` = **runtime-only**, seeded into worktrees, never auto-loaded.

**Hooks are genuinely shared** (the build `settings.json` _and_ the runtime seed both reference
`$CLAUDE_PROJECT_DIR/.claude/hooks/` — `deny-guard`, `stop-verifier`, `stop-schema`, `session-*`),
so they stay in `.claude/hooks/`. Skills are already build-only and were never seeded — leave them.

## The change (directional)

| File / module                                                                                                                                      | Type                       | Change (directional)                                                                                                                         | Why                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `payload/commands/`, `payload/agents/`                                                                                                             | CREATE                     | new runtime-only namespace                                                                                                                   | the seeded half                                                                                       |
| `.claude/commands/*` (10 pipeline nodes: implement, review, fix, expand-guide, verify-guide, verify-seed, pr, reflect, classify, apply-reflection) | MOVE → `payload/commands/` | relocate runtime payload                                                                                                                     | stop polluting builder context                                                                        |
| `.claude/agents/reviewer-*` (7)                                                                                                                    | MOVE → `payload/agents/`   | relocate runtime reviewers                                                                                                                   | stop polluting builder context                                                                        |
| `.claude/agents/` (engine-, types-, hooks-, test-author, sdk-researcher, crev-researcher)                                                          | KEEP                       | build-harness stays                                                                                                                          | used by `/dr-build`                                                                                   |
| `.claude/hooks/`, `.claude/skills/`, `.claude/settings.json`                                                                                       | KEEP                       | unchanged                                                                                                                                    | shared / build-only                                                                                   |
| `src/run-engine.ts` — `srcCommands`, `srcAgents` at **both** seed sites (~L151, ~L703)                                                             | MODIFY                     | repoint to `payload/commands`, `payload/agents`; leave `srcHooks` = `.claude/hooks`                                                          | seed source follows the move                                                                          |
| `src/preflight.ts` — `getAgentContext()` (~L267, L273)                                                                                             | MODIFY                     | repoint the dagrunner-side `commands`/`agents` listing from `.claude/` → `payload/`; leave the `DEVHARNESS_SRC` side + skills line untouched | keep the preflight "what the node will see" report accurate (else it reports zero dagrunner commands) |
| `CLAUDE.md`                                                                                                                                        | MODIFY                     | drop one-shot-build framing; keep invariants; repoint dead `HANDOFF.md` ref                                                                  | maintenance-era always-on context                                                                     |

**Things to get right**

- **Three sites across two files, not one.** `run-engine.ts` initial seed _and_ resume re-seed,
  plus `preflight.ts` `getAgentContext()`. Miss the resume site → `dagrun resume` silently reverts
  to old paths. Miss the preflight site → no crash, but the preflight report shows dagrunner
  contributing zero commands/agents (a silent reporting lie).
- **Destination stays the worktree's `.claude/{commands,agents}`.** Only the _source_ moves. The
  runtime worktree layout must be byte-for-byte the same; the seeded `settings.json` and subagent
  name-resolution expect `.claude/agents` + `.claude/commands` _in the worktree_.
- Keep the `existsSync` guards + their "package installation may be broken" messages, repointed —
  fail-loud preserved.
- `reviewer-*` are referenced **by name** inside `payload/commands/review.md`
  (`reviewer-correctness`, etc.). Name resolution still works because both land together in the
  worktree's `.claude/` — no path edits inside `review.md`.
- `dr-build` (a later change) belongs in `.claude/commands/`; confirm it is NOT seeded (it won't be,
  since `srcCommands` → `payload/`).
- **Packaging (note, likely out of scope):** `dagrun` runs from source today (`tsx ./src/cli.ts`)
  so `payload/` at repo root resolves exactly as `.claude/` does now. But `package.json`
  `files: ["dist"]` means neither `.claude/` nor `payload/` is published — a _pre-existing_ gap the
  move inherits, not one it creates. Optional forward-fix: add `payload/` (and `.claude/`) to
  `files`. Log the decision either way.

## Validation (prove it — evidence, not assertion)

- **Deterministic:** a unit test asserting run-engine's resolved seed sources are
  `payload/commands` + `payload/agents` + `.claude/hooks`, and that the guard throws when `payload/`
  is absent.
- **Integration (seeded worktree):** run a node (smoke/mock or live) → list the worktree's
  `.claude/`:
  - `worktree/.claude/agents/` contains the **7 reviewers** and **none of the 6 authors**.
  - `worktree/.claude/commands/` contains the **10 pipeline nodes**.
    Capture before/after.
- **Build-context check:** in dagrunner's repo, `ls .claude/agents` = only the 6 authors/researchers;
  `ls .claude/commands` = no pipeline nodes. (This is the pollution actually gone.)
- **Resume path:** a `dagrun resume` re-seeds from `payload/` (exercises the second site).
- **Preflight report:** `dagrun preflight` lists dagrunner contributing the 10 pipeline commands +
  7 reviewers (sourced from `payload/`), not zero (exercises the third site).
- `npm run verify-baseline` exits 0 (smoke seeds a worktree → exercises the repointed paths live).

## Done criteria (delta-specific)

- `payload/{commands,agents}/` hold exactly the runtime assets; `.claude/{commands,agents}` hold
  exactly the build assets.
- Both run-engine seed sites repointed; guards still fail loud when `payload/` is missing.
- Seeded worktree `.claude/` is unchanged from today's runtime view (reviewers + pipeline commands
  present), proven by a listing.
- Build session no longer sees runtime payload, proven by a listing.
- `CLAUDE.md` trimmed to invariants; dead `HANDOFF.md` reference removed/repointed.
- Packaging decision logged (add `payload/` to `files`, or explicitly defer).

## Out of scope

- Moving hooks (shared) or skills (already build-only).
- Adding the `/dr-build` command itself — separate change; this only guarantees its future home
  isn't seeded.
- The siblings' canonical copies in Camunda's private `.claude/` (different repo).
- Any change to the runtime worktree `.claude/` layout — must stay identical.
