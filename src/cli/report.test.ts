/**
 * report.test.ts — golden test for generateReport.
 *
 * Strategy: call generateReport with a fixed RunState + fixed friction lines.
 * The output is deterministic (no Date/random/env) given fixed inputs.
 *
 * Golden snapshot: src/cli/report.golden.snap
 *   UPDATE_SNAPSHOTS=1 — write the snapshot (deliberate act; reviewed in diff)
 *   (no flag)          — compare and fail loudly on any difference
 *
 * .snap extension: Prettier hook covers .html but NOT .snap — keeps the
 * snapshot stable across sessions (no accidental reformatting).
 *
 * Teeth check (manual, not automated): change one char in report.ts →
 * golden test goes red. Revert to restore.
 *
 * Run with:
 *   node --test --import tsx src/cli/report.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateReport } from "./report.js";
import type { RunState } from "../core/state.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("./report.golden.snap", import.meta.url),
);

// ---------------------------------------------------------------------------
// Fixed RunState — deterministic, no Date.now(), no env paths
// ---------------------------------------------------------------------------

const FIXED_STATE: RunState = {
  runId: "test-plan-1234567890",
  workflow: "feature",
  createdAt: "2026-06-17T10:00:00.000Z",
  updatedAt: "2026-06-17T11:00:00.000Z",
  status: "done",
  worktreePath:
    "/home/testuser/.local/share/dagrunner/worktrees/test-plan-1234567890",
  branch: "feature/test-plan-1234567890",
  sourcePlanPath: "/path/to/test-plan.md",
  nodes: {
    expand: {
      status: "done",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T10:30:00.000Z",
      artifacts: [
        "/home/testuser/.local/share/dagrunner/runs/test-plan-1234567890/expand/guide.md",
      ],
      model: "sonnet",
      iteration: 1,
      cost: 0.1234,
      gateHistory: [
        {
          decision: "approve",
          comment: "LGTM <&>",
          timestamp: "2026-06-17T10:30:00.000Z",
        },
      ],
    },
    implement: {
      status: "failed",
      startedAt: "2026-06-17T10:30:00.000Z",
      artifacts: [],
      iteration: 0,
      cost: 0.0,
      gateHistory: [],
      error: "Node failed: artifact not produced <&>",
    },
    review: {
      status: "skipped",
      artifacts: [],
      iteration: 0,
      cost: 0.0,
      gateHistory: [],
    },
  },
};

const FIXED_FRICTION = ["first friction line", "second friction line <&>"];

// ---------------------------------------------------------------------------
// Golden snapshot test
// ---------------------------------------------------------------------------

test("generateReport: golden snapshot", () => {
  const actual = generateReport(FIXED_STATE, FIXED_FRICTION);

  if (process.env["UPDATE_SNAPSHOTS"] === "1") {
    writeFileSync(SNAPSHOT_PATH, actual, "utf8");
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `Golden snapshot missing at ${SNAPSHOT_PATH}. ` +
        `Run with UPDATE_SNAPSHOTS=1 to generate it.`,
    );
  }

  const expected = readFileSync(SNAPSHOT_PATH, "utf8");
  assert.equal(
    actual,
    expected,
    `generateReport output differs from snapshot.\n` +
      `Snapshot: ${SNAPSHOT_PATH}\n` +
      `To update: UPDATE_SNAPSHOTS=1 node --test --import tsx src/cli/report.test.ts`,
  );
});

// ---------------------------------------------------------------------------
// Structural correctness (non-golden — always checked)
// ---------------------------------------------------------------------------

test("generateReport: output is valid HTML with DOCTYPE and title", () => {
  const html = generateReport(FIXED_STATE, []);
  assert.ok(html.startsWith("<!DOCTYPE html>"), "must start with DOCTYPE");
  assert.ok(html.includes("<title>"), "must contain title tag");
  assert.ok(
    html.includes("test-plan-1234567890"),
    "runId must appear in output",
  );
});

test("generateReport: XSS escaping — special chars in state are escaped", () => {
  const state: RunState = {
    ...FIXED_STATE,
    runId: "<script>alert('xss')</script>",
    nodes: {},
  };
  const html = generateReport(state, []);
  // Raw script tag must not appear
  assert.ok(
    !html.includes("<script>alert('xss')</script>"),
    "raw script tag must not appear",
  );
  assert.ok(html.includes("&lt;script&gt;"), "script tag must be escaped");
});

test("generateReport: gate history section present when gates exist", () => {
  const html = generateReport(FIXED_STATE, []);
  assert.ok(
    html.includes("Gate History"),
    "Gate History section must appear when gateHistory is non-empty",
  );
  // Gate comment with <&> must be escaped
  assert.ok(!html.includes("LGTM <&>"), "raw gate comment must not appear");
  assert.ok(html.includes("LGTM"), "gate comment text must be present escaped");
});

test("generateReport: friction section omitted when friction list is empty", () => {
  // The friction section is omitted when frictionLines is empty
  const htmlEmpty = generateReport({ ...FIXED_STATE, nodes: {} }, []);
  assert.ok(
    !htmlEmpty.includes("Friction Log"),
    "Friction Log must be absent when friction list is empty",
  );
});

test("generateReport: friction section present and capped at last 20 lines", () => {
  const manyLines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
  const html = generateReport(FIXED_STATE, manyLines);
  assert.ok(html.includes("Friction Log"), "Friction Log must appear");
  // Only the last 20 should appear; line-0 should NOT be present
  assert.ok(
    !html.includes("line-0"),
    "first 10 friction lines must be omitted",
  );
  assert.ok(html.includes("line-29"), "last friction line must be present");
});
