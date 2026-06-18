/**
 * run-engine.test.ts — unit tests for pure exports only.
 *
 * Scope: pure exported helpers (makeRunId). NOT orchestration — startRun,
 * resumeRun, runDag, and their collaborators are Tier C and owned by smoke.
 * This file tests only the extracted pure functions that have no orchestration
 * dependencies. See DECISIONS.md § unit-test-backfill-2b.
 *
 * Run with:
 *   node --test --import tsx src/runtime/run-engine.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRunId } from "./run-engine.js";

// ---------------------------------------------------------------------------
// makeRunId
// ---------------------------------------------------------------------------

test("makeRunId: converts plan basename to slug and appends timestamp", () => {
  const result = makeRunId("/a/b/my-plan.md", 123);
  assert.equal(result, "my-plan-123");
});

test("makeRunId: special chars in filename are replaced with hyphens", () => {
  const result = makeRunId("/path/to/My Plan (v2).md", 456);
  // uppercase → lowercase, spaces and parens → hyphens
  assert.ok(result.endsWith("-456"), `expected to end with -456: ${result}`);
  assert.ok(
    /^[a-z0-9-]+-456$/.test(result),
    `slug must be lowercase alnum+hyphens: ${result}`,
  );
});

test("makeRunId: filename without .md extension — .md stripped only", () => {
  const result = makeRunId("/path/to/plan.md", 789);
  assert.equal(result, "plan-789");
});

test("makeRunId: timestamp zero produces slug-0", () => {
  const result = makeRunId("/x/simple.md", 0);
  assert.equal(result, "simple-0");
});
