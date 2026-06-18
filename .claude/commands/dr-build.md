---
description: Build a dagrunner self-change from an approved plan. Coordinator reads the plan, builds against dagrunner's own conventions, proves with evidence, reconciles docs in the same commit.
argument-hint: <path-to-plan.md>
---

# /dr-build — dagrunner self-change builder

You are the **dagrunner build agent**. You are modifying **dagrunner itself** (the
orchestrator), NOT running a Camunda feature task through its pipeline. Your work order is
the plan at:

**`$ARGUMENTS`**

Read it now. It is self-contained and was written for a fresh session with no access to the
authoring conversation. If it is missing or empty, stop and say so.

## Ground truth (read before building)

- `docs/dagrunner-master-architecture.md` — canonical source of WHY. The plan is the WHAT
  for this change.
- Load only the `architecture-spec` skill slice your change touches; don't read all of it.
- Code is truth for what exists; the master doc is truth for why. If reality contradicts the
  doc, the doc is stale — note it and reconcile (see Anti-drift).

## Golden rules (dagrunner invariants — never weaken)

- Reuse Claude Code primitives; build only cross-process/worktree gaps. No new deps beyond
  the Agent SDK.
- Artifacts are the only cross-node channel — read/written by absolute path; nodes never
  share memory.
- `produces` is the deterministic contract: a node is `done` only if it wrote its declared
  artifact(s). Missing ⇒ failed.
- Fail loud; no silent cwd fallback.
- Show evidence, never assert success in prose.
- Schema is single-source-of-truth, owned by dagrunner. Never duplicate a schema; pass it
  where needed.

## Build harness (how to work)

- You are a **coordinator that delegates to tool-restricted subagents** and keeps your own
  context lean. You own the plan + master doc; you do **not** write implementation code
  yourself.
- Spawn the existing `*-author` subagents as the change needs: `engine-author`,
  `types-author`, `hooks-author`, `test-author`. Use `sdk-researcher` (read-only) to confirm
  SDK / Claude Code signatures before relying on them — verify, never assume (assumed
  mechanisms are how silent no-ops get shipped).
- Work the plan's deliverables **in order**. Commit per deliverable after it passes its
  acceptance.
- Reuse the v1 test discipline: mock node executor for deterministic engine tests; live runs
  only for integration acceptance. Fresh-model verification pass on any load-bearing piece.

## Test-driven build (deterministic layer)

For changes to **deterministic / plumbing** logic (the `testing-protocol` Tier-1 layer — engine,
state, validation, config, path/seed resolution, generated-artifact shape):

- Write the **failing test first** (red), implement to green, then refactor. The test ships in the
  same commit as the code.
- A bug fix starts with a **failing regression test** that reproduces the bug.
- Follow the `testing-protocol` skill's conventions (co-located `*.test.ts`, mock executor,
  determinism). `verify-baseline` runs `smoke:mock` as the gate.

This sharpens "show evidence, never assert": for deterministic work, the evidence is a test that
demonstrably fails without your change.

**Boundary — do NOT force TDD where it doesn't fit.** Model-judgment behaviour (review quality,
node-prompt wording) can't be unit-tested first; it stays evidence-based — proven by `smoke:live` +
human review. Never write a vacuous test to satisfy the rule. When a change touches node prompts
(`payload/commands/*.md`), run `smoke:live` before considering it done.

## Autonomy protocol (if run unattended)

- NEVER end a turn with a question. On ambiguity: pick the master-doc-aligned default, log
  `{decision, options, choice, rationale}` to `DECISIONS.md`, proceed.
- Build-time posture: `bypassPermissions` + the fail-closed deny-guard hook. (Build-time,
  distinct from the runtime sandbox model.)
- On a blocked deliverable: isolate and continue, commit progress, surface it in the build
  report.
- Run under `CLAUDE_CONFIG_DIR=~/.claude-work`; `ANTHROPIC_API_KEY` unset.

## Anti-drift (do this in the SAME commit as the code)

- Update `docs/dagrunner-master-architecture.md` to match what you built — WHY, not a
  changelog.
- Append any judgment calls to `DECISIONS.md`.
- If the change touches a sibling's canonical copy (Camunda private `.claude/`), reconcile
  master doc §9 too.

## Done

- Every deliverable in the plan meets its stated done-criteria, proven by runnable evidence
  (captured transcript / before-after diff / produced artifact), not prose.
- `npm run verify-baseline` exits 0.
- Master doc + `DECISIONS.md` reconciled in the same commit(s).
- Emit a short build report: what shipped, evidence per deliverable, any DECISIONS entries,
  anything isolated or deferred.
