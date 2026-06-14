# dagrunner Phase 2a — Validation Fixture (fake polyglot repo + companion-format plan)

Purpose: a deterministic, throwaway target for verifying the Phase 2a review + fix nodes, the runtime permission/sandbox model, and the TS **and** Java format hooks — WITHOUT running against real Camunda. Planted flaws guarantee the reviewers produce findings, so the full review -> findings -> fix -> gate path is exercised and CHECKABLE. Real-Camunda integration is a separate end-of-phase step (de-scoped M2-6 subset).

The build agent scaffolds the fake repo from §1, then dagrunner ingests the §2 plan (dropped in the inbox) exactly as it would a real Glean-companion plan.

---

## 1. Fake repo: `dagrunner-fixture` (build agent scaffolds this)

A minimal polyglot repo so BOTH formatters and BOTH build/test post-conditions are exercised.

```
dagrunner-fixture/
  .git/                      # git init + one baseline commit
  ts/
    package.json             # prettier + "test": "node --test"
    src/discount.ts          # TS module — has a planted correctness bug
    src/discount.test.ts     # exists but MISSING a case (planted test gap)
  java/
    pom.xml                  # single module, spotless + JUnit
    src/main/java/com/fixture/PriceCalculator.java   # planted api + correctness issue
    src/test/java/com/fixture/PriceCalculatorTest.java
  README.md
```

### Baseline files (committed BEFORE dagrunner runs — these contain the planted flaws)

**`ts/src/discount.ts`** — planted CORRECTNESS bug (no upper-bound clamp) + intentionally bad formatting (so prettier has work to do):

```ts
export function applyDiscount(price: number, percent: number) {
  // BUG: percent > 100 yields a negative price; no clamp / no validation
  return price - (price * percent) / 100;
}
```

**`ts/src/discount.test.ts`** — planted TEST-ADEQUACY gap (only the happy path; no boundary/invalid-input test):

```ts
import { test } from "node:test";
import assert from "node:assert";
import { applyDiscount } from "./discount.ts";
test("applies a normal discount", () => {
  assert.strictEqual(applyDiscount(100, 10), 90);
});
```

**`java/src/main/java/com/fixture/PriceCalculator.java`** — planted API-STABILITY issue (public method that the §2 task will change a signature on) + bad formatting:

```java
package com.fixture;
public class PriceCalculator {
  public int total(int unitPrice,int quantity){
    return unitPrice*quantity; // no overflow / negative-qty handling
  }
}
```

The three planted flaws map to three reviewer dimensions and give KNOWN expected findings:

1. `applyDiscount` missing clamp/validation -> **correctness** (always-on).
2. `discount.test.ts` missing boundary/invalid cases -> **test-adequacy** (always-on).
3. `PriceCalculator.total` public signature change in the task -> **api-stability** (when `touches_public_api`).

---

## 2. The implementation plan dagrunner ingests (Glean-companion format)

Drop this in `~/.local/share/dagrunner/inbox/` as the run input. It mimics the companion's output verbatim in structure.

````markdown
---
title: "Add quantity-aware discounting to the fixture pricing utils — Implementation Plan"
task: "synthetic://dagrunner-validation/price-discount"
epic: "synthetic://dagrunner-validation"
repo: "local/dagrunner-fixture"
base_branch: main
created: 2026-06-12
status: approved
---

# Add quantity-aware discounting to the fixture pricing utils — Implementation Plan

## Problem & goal

Add a combined pricing path so a discount can be applied to a quantity-based total across
both the TS and Java utilities. When done: TS `applyDiscount` validates its inputs, and the
Java `PriceCalculator` exposes a discounted-total operation; both are covered by tests.

## Context & constraints

- Pure utility code; no runtime/cluster needed.
- Public Java method signatures are part of the module's surface — changing them is an
  API-stability concern and must be called out.
- Match existing code style; the format hooks (prettier for TS, spotless for Java) must run.

## Proposed approach (recommended)

1. TS: add input validation + an upper clamp to `applyDiscount`; keep the existing signature.
2. Java: add a `discountedTotal(int unitPrice, int quantity, int percent)` to
   `PriceCalculator`; the existing `total(...)` stays but its behaviour is referenced.

## Change surface

| File / module / function                         | Type   | Change (directional)                      | Why              |
| ------------------------------------------------ | ------ | ----------------------------------------- | ---------------- |
| `ts/src/discount.ts::applyDiscount`              | MODIFY | validate inputs; clamp percent to [0,100] | correctness      |
| `ts/src/discount.test.ts`                        | MODIFY | add boundary + invalid-input cases        | close test gap   |
| `java/.../PriceCalculator.java::discountedTotal` | CREATE | new discounted-total method               | the feature      |
| `java/.../PriceCalculatorTest.java`              | MODIFY | cover the new method                      | test the feature |

## Architectural implications & risks

- Java public API surface grows (additive). Any signature change to `total(...)` would be a
  breaking change — avoid unless justified.

## Testing strategy

- **Unit (TS):** node --test for normal, boundary (0/100), and invalid (>100, negative) cases.
- **Unit (Java):** JUnit for discountedTotal incl. zero/negative quantity.

## Validation commands

```bash
# TS
cd ts && npx prettier --check src && npm test
# Java
cd java && ./mvnw spotless:check test -q
```
````

## Edge cases

- percent > 100 or negative; quantity <= 0; integer overflow on large totals.

## Out of scope

- Any networking, persistence, or cross-module shared types.

## Handoff notes for the DagRunner implementation node

> Self-contained spec for DagRunner; reads with no access to the authoring conversation.

- Start in `ts/`, then `java/`. "Done" = both modules build, format clean, tests green,
  and the planted correctness + test-gap issues are resolved.

## Decision log

| Decision                  | Options considered | Chosen           | Rationale               |
| ------------------------- | ------------------ | ---------------- | ----------------------- |
| percent overflow handling | clamp / reject     | clamp to [0,100] | simplest safe behaviour |

```

---

## 3. What this fixture proves (Phase 2a acceptance, made checkable)

| Capability | How the fixture proves it |
|---|---|
| classify routing | plan touches public Java API -> `touches_public_api` true -> api-stability reviewer runs; verify the selected reviewer set matches the flags |
| review fan-out (read-only) | correctness + test-adequacy + api-stability run as subagents; `findings.json` schema-valid; worktree untouched by review (clean `git status` except implement diff) |
| KNOWN findings | the 3 planted flaws appear as grounded high-confidence findings — a concrete pass/fail assertion, not a vibe check |
| fix node + Gate 2 | fix resolves the high-confidence findings, self-verify passes, gate pauses; reject-with-comment revises in the same session |
| TS format hook | prettier reformats `discount.ts` on edit — show before/after diff |
| Java format hook | spotless reformats `PriceCalculator.java` on edit — show before/after diff |
| permission/sandbox model | run from outside the repo dir, with a source repo carrying its own `.claude/settings.json`; zero pre-gate prompts; out-of-worktree mutation blocked |
| build/test post-condition | both `npm test` and `./mvnw test` run green as the fix node's exit assertion |

---

## 4. Two-target verification strategy (record in the handoff)

- **Phase 2a mechanics → this fake fixture.** Fast, deterministic, planted findings, both formatters. The build agent iterates here.
- **End of Phase 2 → de-scoped M2-6 subset on REAL camunda/camunda** (record-only single-job priority update; no CF rotation; no exporters), ingested as a mimicked companion plan in the inbox — proves dagrunner handles real engine substance + the real `./mvnw` toolchain before the weekend real task (#53839).
- The real #53839 stays untouched for the weekend.
```
