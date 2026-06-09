---
name: crev-patterns
description: The patterns dagrunner borrows from camunda/crev (a thin Go CLI wrapping headless Claude Code to review Camunda PRs) — the strongest internal precedent for the thin-binary + Claude-Code-primitives philosophy. Load in Phase 1 (research) and whenever a block touches the Stop-hook gate, home layout, budget cap, caching, or the phase-2 incremental design.
---

# crev — borrowable patterns for dagrunner

crev ("Camunda Review") is a thin Go CLI (~500 LoC) that wraps headless Claude Code to review Camunda
PRs. Author: Eamonn Moloney. It is the strongest internal precedent for dagrunner's philosophy. The
`crev-researcher` subagent should read `camunda/crev` (`docs/plan.md`, `AGENTS.md`, entrypoint, hook
scripts) and confirm/refresh the specifics below before they are relied on.

## What to BORROW (proven, copy the pattern)

1. **Thin binary, fat config.** crev's rule: the CLI orchestrates `gh`, `git`, and `claude -p`;
   everything else (agents, tools, prompts) is iterable config. → dagrunner keeps the binary thin;
   the DAG core is ~25 lines; node prompts are slash commands, reviewers are config.

2. **Stop-hook deterministic gate + schema validation.** crev wires a Stop hook that validates the
   coordinator's JSON output against a schema (ajv) and BLOCKS on failure via
   `{"decision":"block","reason":...}`, plus a PostToolUse hook that checks every cited `(file,line)`
   resolves at HEAD. → This is the EXACT model for dagrunner's `synthesize-and-fix` convergence loop
   and the `classify` schema Stop hook. Lift the block mechanism directly.

3. **`--since <prior-run-id>` incremental re-review.** Feeds prior findings forward so they aren't
   re-filed. → dagrunner phase-2 ci-babysit mirrors this ("re-run on new commits, only new findings").
   NOTE it, do not build it in v1.

4. **Content-addressed caching.** Key = (PR head SHAs, agent prompts, rubric, schema, model); re-run
   with identical inputs skips Claude entirely. → informs dagrunner's resume-skips-already-clean-nodes
   and `~/.cache/dagrunner/`.

5. **`--max-budget-usd` cost cap.** Native Claude Code runtime feature; works even on subscription
   auth. → dagrunner adopts per-run (Theme 9), plus optional per-node `maxBudget`.

6. **XDG home layout + loud resolution.** `~/.local/bin/crev`, `~/.local/share/crev/`,
   `~/.cache/crev/`, a `CREV_HOME` override, and a documented resolution order that fails loudly with
   no silent cwd fallback. → dagrunner uses `~/.local/share/dagrunner/`, `~/.cache/dagrunner/`,
   `~/.local/bin/dagrun`, `DAGRUNNER_HOME` override, same loud discipline.

7. **Resumable, Ctrl+C-safe checkpoints.** crev's indexer checkpoints per batch. → same
   checkpoint-and-resume discipline behind dagrunner's checkpoint-and-exit gates.

8. **Test structure.** Schema-validation tests for the JSON contracts; the cited-line-resolves check.
   → mirror for `classify.json` and synthesized findings; don't invent a new validation harness.

## Where dagrunner DIVERGES (do not copy)

- **Language:** crev is Go (single static binary); dagrunner is TS (typed Agent SDK, zero new
  language). Both keep the binary thin — the divergence is justified, not a contradiction.
- **Parallel specialists:** crev dispatches specialists as SUBAGENTS WITHIN ONE session via a
  coordinator (it's single-shot, no human gate between steps). dagrunner's reviewers are FIRST-CLASS
  DAG NODES because it has conditional gating, per-node resume, and checkpoint-at-gate — none of which
  survive inside one Claude session. crev confirms subagents-for-fan-out; its flat shape is exactly
  what dagrunner CANNOT use for the gated pipeline.
- **Mutation:** crev is review-ONLY by design (no auto-fix, no auto-PR, no webhooks, no editor
  integration). dagrunner's whole purpose is expand→implement→verify→PR. That is WHY dagrunner needs
  conversation-led gates and worktree isolation crev never needed. crev is a strong template for the
  phase-2 review-triage workflow, a partial template (via `--since`) for ci-babysit, and explicitly
  NOT a template for the mutating feature-pipeline core.

## Borrow/diverge cheat sheet

| Dimension | crev | dagrunner | Verdict |
|---|---|---|---|
| Binary weight | thin (~500 LoC) | thin | borrow |
| Language | Go | TS | diverge (justified) |
| Parallel specialists | subagents in one session | first-class DAG nodes | diverge |
| Deterministic gate | Stop hook + ajv schema | Stop hook convergence/schema | borrow mechanism |
| Re-run on new commits | `--since <run-id>` | phase-2 ci-babysit | borrow (phase 2) |
| Cost cap | `--max-budget-usd` | per-run + per-node | borrow |
| Home layout | XDG + CREV_HOME | XDG + DAGRUNNER_HOME | borrow |
| Mutation | review-only | write-and-gate | diverge (reason to exist) |
