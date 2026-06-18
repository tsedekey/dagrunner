/**
 * workflow.test.ts — co-located unit tests for loadWorkflow.
 *
 * Uses the already-exported fixtures from workflow.ts — no parallel fixtures invented here.
 * Overlaps with dag.test.ts tests 4a-4d intentionally; this is the canonical co-located home.
 * See DECISIONS.md (unit-test-backfill-2a overlap note).
 *
 * Run with:
 *   node --test --import tsx src/workflow/workflow.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadWorkflow,
  FIXTURE_VALID,
  FIXTURE_BAD_MODEL,
  FIXTURE_BAD_DEPENDS,
  FIXTURE_DUPLICATE_ID,
  FIXTURE_CYCLE,
} from "./workflow.js";

// ---------------------------------------------------------------------------
// loadWorkflow — valid workflow passes and returns same object
// ---------------------------------------------------------------------------

test("loadWorkflow: valid fixture passes and returns the workflow", () => {
  const result = loadWorkflow(FIXTURE_VALID);
  assert.deepStrictEqual(result, FIXTURE_VALID);
});

// ---------------------------------------------------------------------------
// loadWorkflow — bad model string
// ---------------------------------------------------------------------------

test('loadWorkflow: FIXTURE_BAD_MODEL throws with node name "step-a" and value "opus"', () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_BAD_MODEL),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("step-a"),
        `Expected "step-a" in message: ${err.message}`,
      );
      assert.ok(
        err.message.includes("opus") || err.message.includes("invalid model"),
        `Expected "opus" or "invalid model" in message: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// loadWorkflow — unknown dependsOn reference
// ---------------------------------------------------------------------------

test('loadWorkflow: FIXTURE_BAD_DEPENDS throws with node name "expand" and dep "nonexistent"', () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_BAD_DEPENDS),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("expand"),
        `Expected "expand" in message: ${err.message}`,
      );
      assert.ok(
        err.message.includes("nonexistent"),
        `Expected "nonexistent" in message: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// loadWorkflow — duplicate node ID
// ---------------------------------------------------------------------------

test('loadWorkflow: FIXTURE_DUPLICATE_ID throws with id "step-a" and word "duplicate"', () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_DUPLICATE_ID),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("step-a"),
        `Expected "step-a" in message: ${err.message}`,
      );
      assert.ok(
        err.message.toLowerCase().includes("duplicate"),
        `Expected "duplicate" in message: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// loadWorkflow — cycle detection
// ---------------------------------------------------------------------------

test('loadWorkflow: FIXTURE_CYCLE throws with word "cycle" and node-a or node-b', () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_CYCLE),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.toLowerCase().includes("cycle"),
        `Expected "cycle" in message: ${err.message}`,
      );
      assert.ok(
        err.message.includes("node-a") || err.message.includes("node-b"),
        `Expected cycle node names in message: ${err.message}`,
      );
      return true;
    },
  );
});
