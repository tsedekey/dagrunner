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
