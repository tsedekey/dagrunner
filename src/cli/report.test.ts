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
    reviewers: {
      status: "done",
      startedAt: "2026-06-17T11:00:00.000Z",
      endedAt: "2026-06-17T11:45:00.000Z",
      artifacts: [
        "/home/testuser/.local/share/dagrunner/runs/test-plan-1234567890/reviewers/findings.json",
      ],
      model: "opus",
      iteration: 1,
      cost: 1.3,
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
//
// Burn Monitor Deliverable 4b fixture:
//   reviewers — phase: "transcript", populated intraNode. The per-model
//               token figures (opus/sonnet input, cache-read, cache-
//               creation, and the -2004/-2653 output-token deltas) are
//               D4a's own real, regression-locked reconciliation numbers
//               off run 53861-1/review (see DECISIONS.md §
//               burn-monitor-d4a-intra-node-capture) — reused here instead
//               of inventing fresh figures, so this fixture exercises the
//               real shape (dual opus/sonnet models, ~5-13% output
//               residual) a live transcript-phase report would show.
//   Three subagents: two ("reviewer-test-adequacy", "reviewer-api-
//   stability") each clear FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD
//   (500_000 cache-read tokens) — triggering the fan-out-multiplier
//   hotspot — the third ("reviewer-correctness") does not, proving the
//   qualifying-only filter. apportionedCostUsd is deliberately NOT in
//   descending array order (agent-2 > agent-1 > agent-3) — this is the
//   regression check that renderSubagentDrilldown sorts, not merely
//   passes through array order.
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
  reviewers: {
    node: "reviewers",
    sessionId: "sess-reviewers",
    costUsd: 1.3,
    schemaVersion: 1,
    phase: "transcript",
    models: [
      {
        model: "claude-opus-4-8",
        inputTokens: 7657,
        outputTokens: 38858,
        cacheReadInputTokens: 3620542,
        cacheCreationInputTokens: 214434,
        webSearchRequests: 0,
        costUSD: 0.9,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
      {
        model: "claude-sonnet-4-6",
        inputTokens: 94,
        outputTokens: 20450,
        cacheReadInputTokens: 3597662,
        cacheCreationInputTokens: 160419,
        webSearchRequests: 0,
        costUSD: 0.4,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    ],
    derived: {
      cacheReadTokens: 7218204,
      cacheCreationTokens: 374853,
      cacheColdRatio: 374853 / (374853 + 7218204),
      outputTokens: 59308,
      tierMix: {
        opus: 3881491,
        sonnet: 3778625,
        haiku: 0,
        unknown: 0,
      },
    },
    intraNode: {
      subagents: [
        {
          agentId: "agent-1",
          agentType: "reviewer-test-adequacy",
          tier: "sonnet",
          tokens: {
            inputTokens: 94,
            outputTokens: 8002,
            cacheReadInputTokens: 620000,
            cacheCreationInputTokens: 5000,
          },
          apportionedCostUsd: 0.15,
        },
        {
          agentId: "agent-2",
          agentType: "reviewer-api-stability",
          tier: "sonnet",
          tokens: {
            inputTokens: 50,
            outputTokens: 4994,
            cacheReadInputTokens: 560000,
            cacheCreationInputTokens: 3000,
          },
          apportionedCostUsd: 0.22,
        },
        {
          agentId: "agent-3",
          agentType: "reviewer-correctness",
          tier: "opus",
          tokens: {
            inputTokens: 30,
            outputTokens: 6540,
            cacheReadInputTokens: 200000,
            cacheCreationInputTokens: 1000,
          },
          apportionedCostUsd: 0.08,
        },
      ],
      toolCallCounts: { Bash: 12, Read: 5, Edit: 3 },
      retryCount: 2,
      verboseToolOutputs: [
        { toolUseId: "toolu_01abc", toolName: "Read", sizeKb: 42.7 },
      ],
      reconciliation: {
        "claude-opus-4-8": {
          inputTokens: { delta: 0, deltaPct: 0 },
          outputTokens: {
            delta: -2004,
            deltaPct: -2004 / 38858,
          },
          cacheReadInputTokens: { delta: 0, deltaPct: 0 },
          cacheCreationInputTokens: { delta: 0, deltaPct: 0 },
        },
        "claude-sonnet-4-6": {
          inputTokens: { delta: 0, deltaPct: 0 },
          outputTokens: {
            delta: -2653,
            deltaPct: -2653 / 20450,
          },
          cacheReadInputTokens: { delta: 0, deltaPct: 0 },
          cacheCreationInputTokens: { delta: 0, deltaPct: 0 },
        },
      },
    },
  },
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
  // cacheCreation total = 95 (define) + 2 (implement) + 374,853 (reviewers) = 374,950
  assert.ok(
    html.includes("374,950"),
    "rollup cache-creation total must appear",
  );
  // cacheRead total = 15 (define) + 300 (implement) + 7,218,204 (reviewers) = 7,218,519
  assert.ok(html.includes("7,218,519"), "rollup cache-read total must appear");
  // output total = 60 (define) + 5 (implement) + 59,308 (reviewers) = 59,373
  assert.ok(html.includes("59,373"), "rollup output total must appear");
});

test("generateReport: Token Rollup section is omitted when no node has valid burn data", () => {
  const html = generateReport(FIXED_STATE, []);
  assert.ok(!html.includes("Token Rollup"));
});

// ---------------------------------------------------------------------------
// Intra-Node Attribution (Burn Monitor Deliverable 4b)
// ---------------------------------------------------------------------------

/** Slices out ONLY the Intra-Node Attribution <section>...</section> block
 * — bounded at both ends, since "Node: <code>define</code>" also appears
 * (unrelated) inside the later Gate History section. */
function intraNodeSectionOf(html: string): string {
  const start = html.indexOf("<h2>Intra-Node Attribution</h2>");
  assert.ok(start >= 0, "Intra-Node Attribution section must appear");
  const end = html.indexOf("</section>", start);
  assert.ok(end >= 0, "Intra-Node Attribution section must be closed");
  return html.slice(start, end);
}

test("generateReport: a rollup-phase node (intraNode null) is entirely unaffected — no Intra-Node Attribution block for it", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  const section = intraNodeSectionOf(html);
  assert.ok(
    !/Node: <code>define<\/code>/.test(section),
    "define (phase: rollup) must not get an Intra-Node Attribution block",
  );
  assert.ok(
    !/Node: <code>implement<\/code>/.test(section),
    "implement (phase: rollup) must not get an Intra-Node Attribution block",
  );
});

test("generateReport: Intra-Node Attribution section omitted entirely when no node has phase: transcript", () => {
  const rollupOnly: Record<string, BurnDoc | undefined> = {
    define: FIXED_BURN["define"],
    implement: FIXED_BURN["implement"],
  };
  const html = generateReport(FIXED_STATE, [], rollupOnly);
  assert.ok(!html.includes("Intra-Node Attribution"));
});

test("generateReport: subagent fan-out drilldown renders one row per subagent, sorted descending by apportioned cost", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  const section = intraNodeSectionOf(html);
  const idxApiStability = section.indexOf("reviewer-api-stability"); // $0.2200 — highest
  const idxTestAdequacy = section.indexOf("reviewer-test-adequacy"); // $0.1500
  const idxCorrectness = section.indexOf("reviewer-correctness"); // $0.0800 — lowest
  assert.ok(
    idxApiStability >= 0 && idxTestAdequacy >= 0 && idxCorrectness >= 0,
    "all three reviewer dimensions must render",
  );
  assert.ok(
    idxApiStability < idxTestAdequacy && idxTestAdequacy < idxCorrectness,
    "subagents must be sorted DESCENDING by apportionedCostUsd, not array order",
  );
  assert.ok(html.includes("$0.2200"), "highest apportioned cost must render");
  assert.ok(html.includes("$0.0800"), "lowest apportioned cost must render");
});

test("generateReport: tool-call counts render sorted descending by count", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  const section = intraNodeSectionOf(html);
  const idxBash = section.indexOf("<code>Bash</code>"); // count 12 — highest
  const idxRead = section.indexOf("<code>Read</code>"); // count 5
  const idxEdit = section.indexOf("<code>Edit</code>"); // count 3 — lowest
  assert.ok(idxBash >= 0 && idxRead >= 0 && idxEdit >= 0);
  assert.ok(
    idxBash < idxRead && idxRead < idxEdit,
    "tool calls must render sorted DESCENDING by count",
  );
});

test("generateReport: nonzero retry count renders", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(html.includes("Retry count: 2"));
});

test("generateReport: verbose tool output renders tool name + size, never the absolute transcript path", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(html.includes("Read"));
  assert.ok(html.includes("42.7 KB"));
  assert.ok(
    !html.includes("toolu_01abc"),
    "the raw toolUseId (Claude Code internal transcript linkage) must not be rendered",
  );
});

test("generateReport: reconciliation deltas render plainly for both models, matching the stored delta/deltaPct", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(html.includes("claude-opus-4-8"));
  assert.ok(html.includes("claude-sonnet-4-6"));
  // opus output-token delta: -2004, deltaPct -2004/38858 ≈ -5.157239% → "-5.16%"
  assert.ok(
    html.includes("-5.16%"),
    "opus output-token reconciliation percentage must render to 2 decimal places",
  );
  // sonnet output-token delta: -2653, deltaPct -2653/20450 ≈ -12.973105% → "-12.97%"
  assert.ok(
    html.includes("-12.97%"),
    "sonnet output-token reconciliation percentage must render to 2 decimal places",
  );
  assert.ok(html.includes("-2,004"), "opus output-token raw delta must render");
  assert.ok(
    html.includes("-2,653"),
    "sonnet output-token raw delta must render",
  );
});

test("generateReport: verbose-tool-output and fan-out-multiplier hotspot badges fire for the transcript-phase node", () => {
  const html = generateReport(FIXED_STATE, [], FIXED_BURN);
  assert.ok(
    html.includes("verbose tool output"),
    "verbose-tool-output badge must render",
  );
  assert.ok(
    html.includes("fan-out multiplier"),
    "fan-out-multiplier badge must render",
  );
  // Only agent-1 (620,000) and agent-2 (560,000) qualify (>= 500,000);
  // agent-3 (200,000) does not — qualifying count is 2, sum is 1,180,000.
  assert.ok(
    html.includes("2 subagents, 1,180,000 cache-read tokens total"),
    "fan-out-multiplier badge must report only the qualifying count/sum",
  );
});
