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
import type { BurnDoc } from "../runtime/burn.js";

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
    define: {
      status: "done",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T10:30:00.000Z",
      artifacts: [
        "/home/testuser/.local/share/dagrunner/runs/test-plan-1234567890/define/guide.md",
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
    pr: {
      status: "pending",
      artifacts: [],
      iteration: 0,
      cost: 0.0,
      gateHistory: [],
    },
  },
};

const FIXED_FRICTION = ["first friction line", "second friction line <&>"];

// ---------------------------------------------------------------------------
// Fixed burnByNode — Burn Monitor Deliverable 2 fixture, covering all four
// render-degrade paths the brief requires:
//   define    — clean BurnDocOk that fires BOTH a tier leak (declared
//               "sonnet", opus tokens present) and cold-reload-tax
//               (cacheColdRatio 95/110 > 0.5 threshold)
//   implement — BurnDocOk with tierMix.unknown tokens only (no declared
//               model, no hotspots — demonstrates the "unclassified"
//               render path in isolation)
//   review    — BurnDocError (the D1 error-marker case)
//   pr        — entirely absent from the map (no burn.json ever written)
// ---------------------------------------------------------------------------

const FIXED_BURN: Record<string, BurnDoc | undefined> = {
  define: {
    node: "define",
    sessionId: "sess-define",
    costUsd: 0.5,
    schemaVersion: 1,
    phase: "rollup",
    models: [
      {
        model: "claude-sonnet-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 90,
        webSearchRequests: 0,
        costUSD: 0.3,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
      {
        model: "claude-opus-4-8",
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: 0.2,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    ],
    derived: {
      cacheReadTokens: 15,
      cacheCreationTokens: 95,
      cacheColdRatio: 95 / 110,
      outputTokens: 60,
      tierMix: { opus: 40, sonnet: 250, haiku: 0, unknown: 0 },
    },
    intraNode: null,
  },
  implement: {
    node: "implement",
    sessionId: "sess-implement",
    costUsd: 0.05,
    schemaVersion: 1,
    phase: "rollup",
    models: [
      {
        model: "claude-mystery-model",
        inputTokens: 100,
        outputTokens: 5,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 2,
        webSearchRequests: 0,
        costUSD: 0.05,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    ],
    derived: {
      cacheReadTokens: 300,
      cacheCreationTokens: 2,
      cacheColdRatio: 2 / 302,
      outputTokens: 5,
      tierMix: { opus: 0, sonnet: 0, haiku: 0, unknown: 407 },
    },
    intraNode: null,
  },
  review: {
    node: "review",
    sessionId: "sess-review",
    schemaVersion: 1,
    error: "modelUsage missing from SDK result",
  },
  // pr: deliberately absent — no burn.json was ever written for this node.
};

// ---------------------------------------------------------------------------
// Golden snapshot test
// ---------------------------------------------------------------------------

test("generateReport: golden snapshot", () => {
  const actual = generateReport(FIXED_STATE, FIXED_FRICTION, FIXED_BURN);

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

// ---------------------------------------------------------------------------
// Burn & Hotspots (Burn Monitor Deliverable 2)
// ---------------------------------------------------------------------------

test("generateReport: omitting burnByNode entirely does not throw — every node degrades to 'no burn data'", () => {
  const html = generateReport(FIXED_STATE, []);
  assert.ok(html.includes("Burn &amp; Hotspots"));
  assert.ok(html.includes("no burn data"));
});

test("generateReport: a BurnDocError node renders 'no burn data' with the error message, never throws, and its status row is still present", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(
    html.includes("no burn data (modelUsage missing from SDK result)"),
    "review's BurnDocError must render inline",
  );
  // The node's existing status row (from renderNodeTable) must still be present.
  assert.ok(
    /<code>review<\/code>[\s\S]*?skipped/.test(html) ||
      (html.includes("<code>review</code>") && html.includes("skipped")),
    "review's status row must not be dropped because burn data is an error",
  );
});

test("generateReport: a node entirely absent from burnByNode renders 'no burn data' without throwing", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  // pr has no entry in FIXED_BURN at all. Scope the search to the Burn &
  // Hotspots section — "<code>pr</code>" also appears in the (unrelated)
  // Node Status table row, which must NOT satisfy this assertion.
  const burnSectionStart = html.indexOf("Burn &amp; Hotspots");
  assert.ok(burnSectionStart >= 0, "Burn & Hotspots section must be present");
  const burnSection = html.slice(burnSectionStart);
  const prRowMatch = burnSection.match(/<code>pr<\/code>[\s\S]{0,200}/);
  assert.ok(
    prRowMatch,
    "pr row must be present in the Burn & Hotspots section",
  );
  assert.ok(
    prRowMatch![0].includes("no burn data"),
    "pr (absent from burnByNode) must render 'no burn data'",
  );
});

test("generateReport: tierMix.unknown tokens are rendered visibly, not silently dropped", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(
    html.includes("unclassified: 407 tokens"),
    "implement's 407 unclassified tokens must be visible",
  );
});

test("generateReport: hotspot badges render for a node whose flags fired (tier leak + cold-reload-tax)", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(
    html.includes("tier leak") && html.includes("declared sonnet"),
    "define's tier-leak badge must render with the declared tier",
  );
  assert.ok(
    html.includes("cold-reload tax"),
    "define's cold-reload-tax badge must render",
  );
});

test("generateReport: per-model breakdown from models[] renders alongside the tier-mix aggregate", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  // define's two distinct models[] entries — this is the D1 empirical
  // motivation (opus-tier parent + sonnet-tier subagent fan-out) — must
  // both be individually visible, not just aggregated into tierMix.
  assert.ok(
    html.includes("claude-sonnet-5: 250 tok"),
    "define's claude-sonnet-5 per-model line must render",
  );
  assert.ok(
    html.includes("claude-opus-4-8: 40 tok"),
    "define's claude-opus-4-8 per-model line must render",
  );
  assert.ok(
    html.includes("claude-mystery-model: 407 tok"),
    "implement's single-model breakdown must render",
  );
});

test("generateReport: run-level Token Rollup section shows totals by bucket and by tier", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(html.includes("Token Rollup"));
  // cacheCreation total = 95 (define) + 2 (implement) = 97
  assert.ok(html.includes("97"), "rollup cache-creation total must appear");
  // cacheRead total = 15 (define) + 300 (implement) = 315
  assert.ok(html.includes("315"), "rollup cache-read total must appear");
  // output total = 60 (define) + 5 (implement) = 65
  assert.ok(html.includes("65"), "rollup output total must appear");
});

test("generateReport: Token Rollup section is omitted when no node has valid burn data", () => {
  const html = generateReport(FIXED_STATE, []);
  assert.ok(!html.includes("Token Rollup"));
});
