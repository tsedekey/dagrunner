import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCopilotBurn, isBurnDocOk, isBurnDocCopilot } from "./burn.js";
import { generateReport } from "../cli/report.js";
import type { RunState } from "../core/state.js";

const ev = (model: string, nano: number, extra: Record<string, unknown> = {}) => ({
  model,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 50,
  cacheWriteTokens: 5,
  reasoningTokens: 2,
  copilotUsage: { totalNanoAiu: nano },
  aiCreditsStatus: "complete",
  ...extra,
});

test("buildCopilotBurn: sums usage per model, total in nano-AIU, explicit unit, no USD field", () => {
  const doc = buildCopilotBurn({
    node: "review",
    sessionId: "s1",
    subagentStarts: 3,
    usage: [ev("claude-opus-5.5", 1000), ev("claude-opus-5.5", 500), ev("claude-sonnet-5.5", 200)],
  });
  assert.equal(doc.runtime, "copilot");
  assert.equal(doc.unit, "nano-aiu");
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.totalNanoAiu, 1700);
  assert.equal(doc.subagentStarts, 3);
  const opus = doc.models.find((m) => m.model === "claude-opus-5.5")!;
  assert.equal(opus.nanoAiu, 1500);
  assert.equal(opus.calls, 2);
  assert.equal(opus.inputTokens, 200);
  assert.equal(opus.cacheReadTokens, 100);
  assert.equal("costUsd" in doc, false);
  assert.equal(isBurnDocCopilot(doc), true);
  assert.equal(isBurnDocOk(doc), false);
});

test("buildCopilotBurn: an event without copilotUsage still counts its tokens (nano-AIU 0) and flags it", () => {
  const doc = buildCopilotBurn({
    node: "n",
    sessionId: "s",
    subagentStarts: 0,
    usage: [{ model: "m", inputTokens: 1, outputTokens: 1 }],
  });
  assert.equal(doc.totalNanoAiu, 0);
  assert.equal(doc.eventsWithoutAiu, 1);
});

test("generateReport renders a copilot burn doc without crashing and labels the unit", () => {
  const state = {
    runId: "r", workflow: "bugfix", createdAt: "x", updatedAt: "x", status: "done",
    worktreePath: "/w", branch: "b", sourcePlanPath: "/p",
    nodes: { review: { status: "done", artifacts: [], iteration: 0, model: "opus", cost: 0 } },
  } as unknown as RunState;
  const doc = buildCopilotBurn({ node: "review", sessionId: "s", subagentStarts: 2, usage: [ev("claude-opus-5.5", 12345)] });
  const html = generateReport(state, [], { review: doc });
  assert.ok(html.includes("12,345") || html.includes("12345"));
  assert.ok(/nano-AIU|AI credits/i.test(html));
  assert.ok(html.includes("n/a (AI credits)"), "node table must not render a fake $0 cost for a copilot node");
  assert.ok(html.includes("claude nodes only"), "run total must say it excludes copilot nodes");
});
