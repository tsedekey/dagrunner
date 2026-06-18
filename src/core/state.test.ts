/**
 * state.test.ts — co-located unit tests for readState / writeState.
 *
 * Canonical home for state I/O tests; dag.test.ts tests 5 and 5b overlap
 * intentionally — see DECISIONS.md (unit-test-backfill-2a overlap note).
 *
 * Run with:
 *   node --test --import tsx src/core/state.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readState, writeState } from "./state.js";
import type { RunState, NodeState } from "./state.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal NodeState (mirrors dag.test.ts pattern)
// ---------------------------------------------------------------------------

function makeNodeState(
  overrides: Partial<NodeState> & { status: NodeState["status"] },
): NodeState {
  const base: NodeState = {
    status: overrides.status,
    artifacts: overrides.artifacts ?? [],
    iteration: overrides.iteration ?? 0,
    cost: overrides.cost ?? 0,
    gateHistory: overrides.gateHistory ?? [],
  };
  if (overrides.startedAt !== undefined) base.startedAt = overrides.startedAt;
  if (overrides.endedAt !== undefined) base.endedAt = overrides.endedAt;
  if (overrides.model !== undefined) base.model = overrides.model;
  if (overrides.sessionId !== undefined) base.sessionId = overrides.sessionId;
  if (overrides.error !== undefined) base.error = overrides.error;
  if (overrides.interruptRetries !== undefined)
    base.interruptRetries = overrides.interruptRetries;
  return base;
}

// ---------------------------------------------------------------------------
// Test: round-trip
// ---------------------------------------------------------------------------

test("state round-trip: write then read equals original", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-state-"));
  const statePath = join(dir, "state.json");

  const original: RunState = {
    runId: "round-trip-test",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T01:00:00.000Z",
    status: "paused",
    worktreePath: "/tmp/worktrees/round-trip-test",
    branch: "feature/round-trip-test",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      classify: makeNodeState({
        status: "done",
        startedAt: "2026-06-18T00:01:00.000Z",
        endedAt: "2026-06-18T00:02:00.000Z",
        artifacts: ["/tmp/runs/round-trip-test/classify/classify.json"],
        model: "haiku",
        iteration: 0,
        cost: 0.0012,
        sessionId: "sess-abc",
      }),
      expand: makeNodeState({
        status: "awaiting-gate",
        startedAt: "2026-06-18T00:03:00.000Z",
        iteration: 1,
        cost: 0.042,
        sessionId: "sess-def",
        gateHistory: [
          {
            decision: "reject",
            comment: "add error handling section",
            timestamp: "2026-06-18T00:05:00.000Z",
          },
        ],
      }),
    },
  };

  writeState(statePath, original);
  const restored = readState(statePath);

  assert.deepStrictEqual(restored, original);
});

// ---------------------------------------------------------------------------
// Test: no undefined keys in serialised optional-free NodeState
// ---------------------------------------------------------------------------

test("state round-trip: optional fields absent from serialised NodeState", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-state-"));
  const statePath = join(dir, "state.json");

  const original: RunState = {
    runId: "no-optionals-test",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/no-optionals-test",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      classify: makeNodeState({ status: "pending" }),
    },
  };

  writeState(statePath, original);
  const restored = readState(statePath);

  assert.deepStrictEqual(restored, original);

  const nodeKeys = Object.keys(restored.nodes["classify"] ?? {});
  const requiredOnly = [
    "status",
    "artifacts",
    "iteration",
    "cost",
    "gateHistory",
  ];
  for (const k of nodeKeys) {
    assert.ok(
      requiredOnly.includes(k),
      `Unexpected key '${k}' in serialised NodeState — optional fields must be omitted`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test: malformed JSON → throws (fail-loud, no silent default)
// ---------------------------------------------------------------------------

test("readState: malformed JSON throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-state-"));
  const statePath = join(dir, "state.json");

  writeFileSync(statePath, "{ this is not valid json }", "utf8");

  assert.throws(
    () => readState(statePath),
    (err: unknown) => {
      assert.ok(err instanceof SyntaxError || err instanceof Error);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test: missing file → throws (not a silent default)
// ---------------------------------------------------------------------------

test("readState: missing file throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-state-"));
  const statePath = join(dir, "nonexistent-state.json");

  assert.throws(
    () => readState(statePath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Node.js file-not-found errors carry a code property
      const nodeErr = err as NodeJS.ErrnoException;
      assert.equal(nodeErr.code, "ENOENT");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test: interruptRetries round-trip (present + absent-treated-as-zero)
// ---------------------------------------------------------------------------

test("state round-trip: interruptRetries persisted; absent field treated as 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-state-"));
  const statePath = join(dir, "state.json");

  const original: RunState = {
    runId: "irr-rt-test",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/irr-rt-test",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      withRetries: makeNodeState({
        status: "failed",
        error: "process interrupted — reconciled on resume",
        interruptRetries: 2,
      }),
      withoutRetries: makeNodeState({ status: "pending" }),
    },
  };

  writeState(statePath, original);
  const restored = readState(statePath);

  assert.deepStrictEqual(restored, original);

  // interruptRetries:2 must survive the round-trip.
  assert.equal(
    restored.nodes["withRetries"]?.interruptRetries,
    2,
    "interruptRetries must be preserved through JSON serialisation",
  );

  // Absent interruptRetries reads back as undefined (absent), treated as 0 by callers.
  assert.equal(
    restored.nodes["withoutRetries"]?.interruptRetries,
    undefined,
    "absent interruptRetries must remain absent (not written as null/0)",
  );
  assert.equal(
    restored.nodes["withoutRetries"]?.interruptRetries ?? 0,
    0,
    "absent interruptRetries ?? 0 === 0 (backward-compat: missing ⇒ zero)",
  );
});
