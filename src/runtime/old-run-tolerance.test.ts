/**
 * old-run-tolerance.test.ts — a run created BEFORE the verify node was removed
 * still has `verify` in its persisted state.json (plus fix/next-node-decision.json,
 * a verify/ dir, a gateHistory entry with a stray `runNext`). Read-only commands
 * must not crash on such a run directory. No migration code exists; this pins
 * that the plain tolerant reads keep working. See DECISIONS.md § verify-node-removed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RunState } from "../core/state.js";
import { buildStatusJson } from "../cli/status-json.js";
import { generateReport } from "../cli/report.js";
import { buildRunSnapshot } from "../ui/run-snapshot.js";
import { buildGateBrief } from "../core/gate.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { listRuns } from "./run-engine.js";

const node = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    status,
    artifacts: [],
    iteration: 0,
    cost: 0.1,
    gateHistory: [],
    ...extra,
  }) as RunState["nodes"][string];

function oldRun(status: RunState["status"], prStatus: string) {
  const home = mkdtempSync(join(tmpdir(), "dr-old-run-"));
  const runDir = join(home, "runs", "old-1");
  mkdirSync(join(runDir, "fix"), { recursive: true });
  mkdirSync(join(runDir, "verify"), { recursive: true });
  mkdirSync(join(runDir, "pr"), { recursive: true });
  writeFileSync(join(runDir, "fix", "summary.md"), "# S\n");
  writeFileSync(
    join(runDir, "fix", "next-node-decision.json"),
    JSON.stringify({ node: "verify", run: true }),
  );
  writeFileSync(
    join(runDir, "verify", "verify-report.json"),
    JSON.stringify({ outcome: "PROVISIONED" }),
  );
  writeFileSync(join(runDir, "verify", "demo.md"), "steps\n");
  writeFileSync(join(runDir, "pr", "body.md"), "body\n");
  const state: RunState = {
    runId: "old-1",
    workflow: "bugfix",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    status,
    worktreePath: join(home, "no-such-worktree"),
    branch: "b",
    sourcePlanPath: "/p",
    nodes: {
      reproduce: node("done"),
      implement: node("done"),
      review: node("done"),
      fix: node("done", {
        gateHistory: [{ decision: "approve", timestamp: "t", runNext: true }],
      }),
      verify: node("done", {
        artifacts: [join(runDir, "verify", "verify-report.json")],
      }),
      pr: node(prStatus),
    },
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return { home, runDir, state };
}

test("old finished run: status --json, list, report and the UI snapshot all read it and keep the verify node visible", () => {
  const { home, state } = oldRun("done", "done");

  const st = buildStatusJson(home, "old-1");
  assert.equal(st.status, "done");
  assert.equal(st.nodes["verify"]?.status, "done");

  assert.deepEqual(
    listRuns(home).map((r) => r.runId),
    ["old-1"],
  );

  const html = generateReport(state, []);
  assert.match(html, /verify/);

  const snap = buildRunSnapshot(home, "old-1");
  assert.equal(snap.nodeOrder.at(-1), "verify");
  assert.equal(snap.nodes["verify"]?.status, "done");
  assert.doesNotThrow(() => JSON.stringify(snap));
});

test("old run paused at the pre-PR gate: the gate brief builds (verify is not an ancestor any more) and carries no verify hand-off", () => {
  const { runDir, state } = oldRun("paused", "awaiting-gate");
  const brief = buildGateBrief({
    runDir,
    state,
    workflow: bugfixWorkflow,
    gateNodeId: "pr",
    configDirs: [],
  });
  assert.equal(brief.gateNodeId, "pr");
  assert.equal("verifyEnvironment" in brief, false);
  assert.equal("decidesNode" in brief.pendingDecision, false);
  assert.ok(
    brief.upstreamArtifacts.every((u) => u.nodeId !== "verify"),
    "the legacy verify node contributes no gate evidence",
  );
});

// ---------------------------------------------------------------------------
// A run created BEFORE define/reproduce were removed (DECISIONS.md §
// plan-is-the-guide) still has that node — a gated one, `done` or paused —
// in its persisted state.json and a reproduce/guide.md (or define/guide.md) on
// disk. Same contract as above: no migration code; read-only commands must not
// crash and keep the legacy node visible. Resuming such a run is unsupported;
// what the engine actually does is measured and recorded in DECISIONS.md.
// ---------------------------------------------------------------------------

import { featureWorkflow } from "../workflow/feature-workflow.js";
import type { Workflow } from "../core/types.js";

const LEGACY: Array<{ wf: "bugfix" | "feature"; workflow: Workflow; legacyId: "reproduce" | "define" }> = [
  { wf: "bugfix", workflow: bugfixWorkflow, legacyId: "reproduce" },
  { wf: "feature", workflow: featureWorkflow, legacyId: "define" },
];

function preGuideRun(
  wf: "bugfix" | "feature",
  legacyId: string,
  runStatus: RunState["status"],
  nodeStatus: Record<string, string>,
) {
  const home = mkdtempSync(join(tmpdir(), "dr-old-guide-"));
  const runDir = join(home, "runs", "old-2");
  for (const d of [legacyId, "implement", "fix", "pr", "plan"]) mkdirSync(join(runDir, d), { recursive: true });
  writeFileSync(join(runDir, "plan", "plan.md"), "---\ntitle: old\n---\nplan\n");
  writeFileSync(join(runDir, legacyId, "guide.md"), "# old guide\n");
  writeFileSync(join(runDir, "implement", "summary.md"), "# S\n");
  writeFileSync(join(runDir, "fix", "summary.md"), "# F\n");
  const nodes: RunState["nodes"] = {};
  for (const [id, st] of Object.entries(nodeStatus)) {
    nodes[id] = node(st, id === legacyId ? { artifacts: [join(runDir, legacyId, "guide.md")], gateHistory: [{ decision: "approve", timestamp: "t" }] } : {});
  }
  const state: RunState = {
    runId: "old-2",
    workflow: wf,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    status: runStatus,
    worktreePath: join(home, "no-such-worktree"),
    branch: "b",
    sourcePlanPath: "/p",
    nodes,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return { home, runDir, state };
}

for (const { wf, workflow, legacyId } of LEGACY) {
  test(`pre-plan-is-the-guide ${wf} run, finished: status --json, list, report and the UI snapshot read it and keep the done ${legacyId} node visible`, () => {
    const { home, state } = preGuideRun(wf, legacyId, "done", {
      [legacyId]: "done", implement: "done", review: "done", fix: "done", pr: "done",
    });
    const st = buildStatusJson(home, "old-2");
    assert.equal(st.status, "done");
    assert.equal(st.nodes[legacyId]?.status, "done");
    assert.deepEqual(listRuns(home).map((r) => r.runId), ["old-2"]);
    assert.match(generateReport(state, []), new RegExp(legacyId));
    const snap = buildRunSnapshot(home, "old-2");
    assert.ok(snap.nodeOrder.includes(legacyId), "legacy node stays visible");
    assert.equal(snap.nodes[legacyId]?.status, "done");
    assert.equal(snap.defs[legacyId], undefined, "no definition for it any more");
    assert.doesNotThrow(() => JSON.stringify(snap));
  });

  test(`pre-plan-is-the-guide ${wf} run, paused at the fix gate with a done ${legacyId}: the gate brief builds and the legacy node contributes no evidence`, () => {
    const { runDir, state, home } = preGuideRun(wf, legacyId, "paused", {
      [legacyId]: "done", implement: "done", review: "done", fix: "awaiting-gate", pr: "pending",
    });
    const brief = buildGateBrief({ runDir, state, workflow, gateNodeId: "fix", configDirs: [] });
    assert.equal(brief.gateNodeId, "fix");
    assert.ok(brief.upstreamArtifacts.every((u) => u.nodeId !== legacyId));
    const st = buildStatusJson(home, "old-2");
    assert.equal(st.status, "awaiting-gate");
    assert.equal(st.awaitingGate?.nodeId, "fix");
    assert.equal(buildRunSnapshot(home, "old-2").gate?.nodeId, "fix");
  });

  test(`pre-plan-is-the-guide ${wf} run paused AT its old first gate (${legacyId} awaiting-gate): status --json, the UI snapshot and the gate brief do not crash`, () => {
    const { runDir, state, home } = preGuideRun(wf, legacyId, "paused", {
      [legacyId]: "awaiting-gate", implement: "pending", review: "pending", fix: "pending", pr: "pending",
    });
    const st = buildStatusJson(home, "old-2");
    assert.equal(st.status, "awaiting-gate");
    assert.equal(st.awaitingGate?.nodeId, legacyId);
    const snap = buildRunSnapshot(home, "old-2");
    assert.equal(snap.gate?.nodeId, legacyId);
    assert.doesNotThrow(() => JSON.stringify(snap));
    // `gate show` builds a brief for a gate id the current workflow no longer defines.
    const brief = buildGateBrief({ runDir, state, workflow, gateNodeId: legacyId, configDirs: [] });
    assert.equal(brief.gateNodeId, legacyId);
    assert.deepEqual(brief.pendingDecision.approveContinuesTo, [], "nothing is downstream of a node the workflow does not define");
  });

  test(`pre-plan-is-the-guide ${wf} run with a FAILED ${legacyId}: status --json reports the error and the run's failure`, () => {
    const { home, runDir, state } = preGuideRun(wf, legacyId, "failed", {
      [legacyId]: "failed", implement: "pending", review: "pending", fix: "pending", pr: "pending",
    });
    state.nodes[legacyId] = { ...state.nodes[legacyId]!, error: "produces contract violated — missing: guide.md" };
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
    const st = buildStatusJson(home, "old-2");
    assert.equal(st.status, "failed");
    assert.equal(st.nodes[legacyId]?.error, "produces contract violated — missing: guide.md");
  });
}
