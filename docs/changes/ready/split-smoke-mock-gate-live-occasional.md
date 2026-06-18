---
title: "Split smoke: mock-driven gate + occasional live e2e — dagrunner self-change plan"
related: "high-leverage: makes the whole build queue cheap + deterministic; sequence soon"
created: 2026-06-18
status: approved
---

# Split smoke: `smoke:mock` (gate) + `smoke:live` (occasional)

## Context (read first)

`verify-baseline = npm ci && typecheck && test && smoke`, and `smoke` runs the **full real-SDK
pipeline** (real Claude Code sessions per node; Haiku for most, Sonnet for reflect/apply-reflection;
10-minute step timeouts). It runs on **every plan**, so a queue of N plans = N live end-to-end runs —
~35 min + real tokens each, and non-deterministic (the flaky-gate class we just fixed lived here).

The lever: the **mock executor already exists** and implements the same `NodeExecutor` signature the
real runner does; on success it writes each node's declared `produces` files. And the run loop
`runDag(workflow, executor, state, …)` (`core/dag.ts`) already takes the executor as a **parameter** —
`run-engine` just hardcodes `makeSDKRunner(...)` at its call sites. So we can drive the entire gated
pipeline with the mock, **in-process, in seconds, at ~zero tokens, deterministically.**

## Rationale

Split what the gate proves from what needs a live model:

- **Wiring** (state transitions, gates, routing, artifact channel, worktree seeding, hooks,
  produces-contract, the retry cap) changes per-plan → prove it cheaply on every plan with the **mock**.
- **Prompt + integration behaviour** (do the node prompts elicit sane real-model output; real auth /
  model / `-p`) changes rarely (only when you edit prompts) → prove it with **live smoke**, occasionally.

## The change (directional)

| File / module                                                                    | Type   | Change (directional)                                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                  |
| -------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/runtime/run-engine.ts` — start (~L209), resume (~L497), `rerunNode` (~L740) | MODIFY | accept an **optional executor-factory** param, defaulting to `makeSDKRunner` (the current behaviour)                                                                                                                                                                                                                                                                                                            | a test-injectable seam; CLI path unchanged when the param is omitted |
| `test/smoke/smoke-mock.ts`                                                       | CREATE | drive the **full gated pipeline in-process** via run-engine start/resume with `createMockExecutor`: init → expand → Gate 1 reject→feedback→approve → implement → review → fix → Gate 2 → verify-election (both y and n) → verify → pr → reflect gate → apply-reflection → done. Assert the same **wiring** the live smoke does (gate pauses, artifact channel, routing, produces-contract), minus model quality | the cheap deterministic gate                                         |
| `package.json` scripts                                                           | MODIFY | `smoke:live` = current real-SDK smoke (rename `smoke`); `smoke:mock` = the new in-process test; `verify-baseline` swaps `smoke` → `smoke:mock`                                                                                                                                                                                                                                                                  | per-plan gate becomes fast + free + deterministic                    |

**Things to get right**

- **Injection is behaviour-preserving.** Default the executor param to `makeSDKRunner`; the CLI and real
  runs are byte-for-byte unchanged. The mock is supplied only by `smoke-mock.ts`.
- **`smoke:mock` runs in-process** (call run-engine start/resume directly with the mock) — NOT via the
  `runCli` subprocess, which would re-engage the real runner. That's what makes it fast/free.
- **Gates are driven by orchestration, not the executor** — the mock always returns success; the
  reject/approve/election paths are driven by the resume options the test passes.
- **Keep `smoke:live` fully intact and runnable** — we're demoting its _frequency_, not deleting it.
- **The retry-cap path stays in its own tier-1 test** — don't re-test it here; `smoke:mock` covers the
  gated happy + reject flow.
- **TDD fit:** build the injection + `smoke:mock` test-first.

## The tradeoff (name it, don't hide it)

A change that breaks **real-model behaviour but passes the mock** — essentially a bad node-prompt edit —
would slip past the per-plan gate until the next `smoke:live`. Mitigation guideline (document it):
**run `smoke:live` when a plan touches `payload/commands/*.md`, before merging, and once at the end of
a queue.** (A future `build-queue.sh` enhancement could auto-run `smoke:live` once after a clean queue,
or when prompt files changed — note as follow-up, out of scope here.)

## Validation (prove it — evidence, not assertion)

- `npm run smoke:mock` runs the full gated pipeline green **in seconds**, deterministically (run it 3× —
  identical, no real API calls, ~zero cost).
- `npm run verify-baseline` exits 0 and is now fast + deterministic (run 2–3× to confirm stability).
- `npm run smoke:live` still runs the real pipeline green (unchanged) when invoked.
- Injection teeth: omitting the executor param yields the real runner (a normal `dagrun start` still
  uses real SDK — unchanged behaviour).

## Done criteria (delta-specific)

- run-engine start/resume/rerunNode accept an optional executor factory (default = real runner).
- `smoke:mock` exists, in-process, deterministic, covers the full gated flow; `smoke:live` retained.
- `verify-baseline` uses `smoke:mock`; `smoke:live` is a separate command.
- The mock-vs-live tradeoff + the "run smoke:live when prompts change / pre-merge / queue-end"
  guideline documented in the `testing-protocol` skill + master doc; `DECISIONS.md` logs the split.

## Out of scope

- Auto-running `smoke:live` from `build-queue.sh` (follow-up dev-helper change).
- Deleting or rewriting `smoke:live`'s assertions (kept as-is).
- Changing node prompts or the real runner.
