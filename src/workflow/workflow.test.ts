/**
 * workflow.test.ts — co-located unit tests for loadWorkflow and validateClassifyOutput.
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
  validateClassifyOutput,
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

test('loadWorkflow: FIXTURE_BAD_MODEL throws with node name "classify" and value "opus"', () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_BAD_MODEL),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("classify"),
        `Expected "classify" in message: ${err.message}`,
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

test('loadWorkflow: FIXTURE_DUPLICATE_ID throws with id "classify" and word "duplicate"', () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_DUPLICATE_ID),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("classify"),
        `Expected "classify" in message: ${err.message}`,
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

// ---------------------------------------------------------------------------
// validateClassifyOutput — valid object with all 4 boolean fields
// ---------------------------------------------------------------------------

test("validateClassifyOutput: valid object with all 4 boolean fields returns ClassifyOutput", () => {
  const input = {
    touches_public_api: true,
    touches_runtime: false,
    perf_sensitive: false,
    touches_schema_or_proto: true,
  };

  const result = validateClassifyOutput(input);

  assert.equal(result.touches_public_api, true);
  assert.equal(result.touches_runtime, false);
  assert.equal(result.perf_sensitive, false);
  assert.equal(result.touches_schema_or_proto, true);
});

// ---------------------------------------------------------------------------
// validateClassifyOutput — missing field throws with field name
// ---------------------------------------------------------------------------

test("validateClassifyOutput: missing field throws with field name in message", () => {
  const input = {
    touches_public_api: true,
    touches_runtime: false,
    perf_sensitive: false,
    // touches_schema_or_proto deliberately omitted
  };

  assert.throws(
    () => validateClassifyOutput(input),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("touches_schema_or_proto"),
        `Expected field name "touches_schema_or_proto" in: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// validateClassifyOutput — wrong-type field throws with field name
// ---------------------------------------------------------------------------

test("validateClassifyOutput: wrong-type field throws with field name in message", () => {
  const input = {
    touches_public_api: true,
    touches_runtime: "yes", // wrong type
    perf_sensitive: false,
    touches_schema_or_proto: false,
  };

  assert.throws(
    () => validateClassifyOutput(input),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("touches_runtime"),
        `Expected field name "touches_runtime" in: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// validateClassifyOutput — null input throws
// ---------------------------------------------------------------------------

test("validateClassifyOutput: null input throws", () => {
  assert.throws(
    () => validateClassifyOutput(null),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("null"),
        `Expected "null" in: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// validateClassifyOutput — array input throws
// ---------------------------------------------------------------------------

test("validateClassifyOutput: array input throws", () => {
  assert.throws(
    () => validateClassifyOutput([true, false, false, true]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("array"),
        `Expected "array" in: ${err.message}`,
      );
      return true;
    },
  );
});
