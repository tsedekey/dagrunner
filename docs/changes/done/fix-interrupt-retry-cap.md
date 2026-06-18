---
title: "Interrupt-retry cap + deterministic resume test — dagrunner self-change plan"
related: "unblocks the overnight queue; must land BEFORE unit-test-backfill-2b"
created: 2026-06-18
status: approved
---

# Interrupt-retry cap + deterministic resume test

## Context (read first)

On resume, `run-engine.ts` (~L265–287, in `runtime/`) resets **every** process-interrupted node
(reconciled `running → failed` with error `"process interrupted — reconciled on resume"`) back to
`pending` and retries it — **unconditionally**. So a genuinely-failing node can retry forever and the
run never settles to a real `failed`.

Separately, smoke step-8 asserts an interrupted node ends `failed`, but the engine retries it, and the
retry fires a **real SDK call racing a 60s timeout** → the assertion is non-deterministic
(`done` / `running` / `failed` depending on latency). This flaky test **halted the overnight queue on
plan 2a even though 2a was green** (committed `d799364`; the builder's own verify passed, the queue's
independent verify failed — same test, opposite luck).

Decision (Eddie): **keep retry-on-resume** — a transient interrupt shouldn't permanently fail a
resumable run — **but add a cap** so a genuine failure eventually settles to `failed`.

## Root cause / rationale

Two coupled gaps: (1) unbounded interrupt-retry can't tell a transient interrupt from a genuine
failure; (2) the integration test asserts a racy end-state. A retry **cap** fixes the semantics; moving
the behaviour assertion to a **deterministic mock-executor test** fixes the flakiness — and the gate
must be deterministic or it can halt sound builds (as it just did).

## The change (directional)

| File / module                                                    | Type               | Change (directional)                                                                                                                                                                                                       | Why                                                |
| ---------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/core/state.ts` — `NodeState`                                | MODIFY             | add optional `interruptRetries?: number` (missing ⇒ 0)                                                                                                                                                                     | per-node count of interrupt-driven retries         |
| `src/runtime/run-engine.ts` — reset-to-pending block (~L265–287) | MODIFY             | before resetting an interrupted node: if `(ns.interruptRetries ?? 0) < MAX_INTERRUPT_RETRIES` → reset to `pending`, increment the count, log `retry n/CAP`; else **leave it `failed`**, log `exceeded retry cap → failing` | bound retries; genuine failures settle to `failed` |
| `src/runtime/run-engine.ts` (or a constants home)                | ADD                | `MAX_INTERRUPT_RETRIES` constant — **propose 2** (3 attempts total); tunable                                                                                                                                               | the cap value                                      |
| new tier-1 test (mock executor)                                  | ADD                | under cap: interrupted node → reset to `pending` → (mock) completes; at cap: interrupted node stays `failed` → run ends `failed`                                                                                           | deterministic coverage of BOTH branches            |
| `test/smoke/smoke.ts` — step-8                                   | MODIFY             | remove the racy real-SDK `running→failed` assertion; either drop it (now unit-covered) or assert a stable property (resume proceeds, no crash)                                                                             | de-flake the gate                                  |
| `src/core/state.test.ts`                                         | MODIFY (extend 2a) | round-trip `interruptRetries`; missing ⇒ 0                                                                                                                                                                                 | cover the new field                                |

**Things to get right**

- **Dedicated counter.** Use `interruptRetries`, NOT the existing `iteration` (that's _gate_ iterations —
  conflating them corrupts gate semantics).
- **Cap applies only to interrupt-retries** (`error === "process interrupted — reconciled on resume"`),
  never to ordinary node failures (gates own those).
- **Backward compat:** old `state.json` lacks the field → treat as 0. No migration (matches the
  clean-break norm); `readState` already tolerates optional fields.
- **At-cap path must terminate:** when the cap is hit the node stays `failed`; confirm `dag`/reconcile
  treats a failed-required node as terminal so the run settles to `failed` — no infinite loop.
- **Determinism is the point.** The new behaviour test MUST use the **mock executor** — no real SDK, no
  timeout race. The gate has to be deterministic.
- **Build this test-first** (write the failing cap test, then implement) — it's deterministic engine
  logic, the exact TDD layer, and a good rehearsal for the standing rule we're about to add.

## Validation (prove it — evidence, not assertion)

- New tier-1 test green, both branches; **teeth check** — set `MAX_INTERRUPT_RETRIES` to 0 and confirm
  the at-cap test still holds (node stays `failed` immediately); raise it and confirm the retry path.
- **Flakiness gone:** run `npm run smoke` 3× → stable pass each time.
- `npm run verify-baseline` exits 0, run **2–3×** to confirm it's now deterministic (flakiness was the
  whole failure mode).
- `state.test.ts` covers the new field (round-trip + missing-⇒-0).

## Done criteria (delta-specific)

- `interruptRetries` added; reset-to-pending capped by `MAX_INTERRUPT_RETRIES`; at-cap nodes settle to
  `failed` and the run ends `failed`.
- Deterministic tier-1 test covers retry-under-cap and fail-at-cap; smoke step-8 de-flaked.
- `verify-baseline` green and **stable across repeated runs**.
- Master doc / `architecture-spec` reconciled (resume-retry semantics + the cap documented); the cap
  value logged in `DECISIONS.md`.

## Out of scope

- Making the cap configurable via CLI/config (a constant suffices now; note as future).
- Retry policy for non-interrupt failures (gates own those).
- Plan 2b — next in the queue, after this lands.
