/**
 * run-snapshot.test.ts — the UI's read model: node order per workflow, total
 * cost, per-node gate history, and reading (never computing) the gate brief.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRunSnapshot } from "./run-snapshot.js";
import type { RunState } from "../core/state.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";

function setup(workflow: "bugfix" | "feature", over: Partial<RunState> = {}) {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-snap-"));
  const runDir = join(home, "runs", "9-1");
  mkdirSync(runDir, { recursive: true });
  const state: RunState = {
    runId: "9-1",
    workflow,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    status: "paused",
    worktreePath: "/w",
    branch: "b",
    sourcePlanPath: "/p",
    nodes: {
      reproduce: {
        status: "done",
        artifacts: [],
        iteration: 1,
        cost: 0.1,
        gateHistory: [],
      },
      implement: {
        status: "done",
        artifacts: [],
        iteration: 0,
        cost: 0.2,
        gateHistory: [],
      },
      review: {
        status: "done",
        artifacts: [],
        iteration: 0,
        cost: 0.05,
        gateHistory: [],
      },
      fix: {
        status: "awaiting-gate",
        artifacts: [],
        iteration: 0,
        cost: 0.3,
        gateHistory: [
          {
            decision: "hold",
            comment: "wait",
            timestamp: "2026-01-01T00:05:00.000Z",
          },
        ],
      },
    },
    ...over,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return { home, runDir, state };
}

test("node order follows the workflow's own declared pipeline order (bugfix)", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.deepEqual(
    snap.nodeOrder,
    bugfixWorkflow.nodes.map((n) => n.id),
  );
});

test("node order follows the feature workflow when state.workflow is feature", () => {
  const { home } = setup("feature");
  const snap = buildRunSnapshot(home, "9-1");
  // The fixture state carries bugfix-named nodes; those are state-only extras and are appended AFTER the workflow's own order.
  assert.deepEqual(
    snap.nodeOrder.slice(0, featureWorkflow.nodes.length),
    featureWorkflow.nodes.map((n) => n.id),
  );
});

test("total cost sums every node's cost", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.totalCost, 0.1 + 0.2 + 0.05 + 0.3);
});

test("per-node gateHistory is carried through, decisionId and all", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.nodes["fix"]?.gateHistory.length, 1);
  assert.equal(snap.nodes["fix"]?.gateHistory[0]?.decision, "hold");
});

test("gateBrief is null when no gate.json has been written yet, even though a node awaits", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.awaitingGate?.nodeId, "fix");
  assert.equal(snap.gateBrief, null);
});

test("gateBrief is read verbatim from <gate>/gate.json, never recomputed", () => {
  const { home, runDir } = setup("bugfix");
  const fakeBrief = {
    schema: 1,
    runId: "9-1",
    workflow: "bugfix",
    gateNodeId: "fix",
    revision: "abc.def",
  };
  mkdirSync(join(runDir, "fix"), { recursive: true });
  writeFileSync(join(runDir, "fix", "gate.json"), JSON.stringify(fakeBrief));
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.gateBrief?.revision, "abc.def");
});

test("a torn/garbled gate.json degrades to null instead of throwing", () => {
  const { home, runDir } = setup("bugfix");
  mkdirSync(join(runDir, "fix"), { recursive: true });
  writeFileSync(join(runDir, "fix", "gate.json"), "{ not json");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.gateBrief, null);
});

test("an unknown workflow name falls back to state.json's own node insertion order", () => {
  const { home } = setup("bugfix", { workflow: "mystery" });
  const snap = buildRunSnapshot(home, "9-1");
  assert.deepEqual(snap.nodeOrder, ["reproduce", "implement", "review", "fix"]);
});

// ---------------------------------------------------------------------------
// Mockup-port additions: view fields + the real-data quirks the mockup author found.
// ---------------------------------------------------------------------------

test("carries the raw run status, branch/base, plan title and a quote-stripped issueUrl (state.json stores literal quotes)", () => {
  const { home, runDir } = setup("bugfix", {
    issueUrl: '"https://github.com/o/r/issues/7"',
    baseBranch: "stable/8.8",
    branch: "fix/7-thing",
  } as Partial<RunState>);
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "plan", "plan.md"), '---\ntitle: "Operate V1 GET returns 500 — Fix Plan"\n---\nbody\n');
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.runStatus, "paused");
  assert.equal(snap.issueUrl, "https://github.com/o/r/issues/7");
  assert.equal(snap.baseBranch, "stable/8.8");
  assert.equal(snap.branch, "fix/7-thing");
  assert.equal(snap.planTitle, "Operate V1 GET returns 500");
});

test("issueUrl / planTitle are null when absent; a non-http issueUrl is dropped (never an href-able javascript: url)", () => {
  const { home } = setup("bugfix");
  const a = buildRunSnapshot(home, "9-1");
  assert.equal(a.issueUrl, null);
  assert.equal(a.planTitle, null);
  const s2 = setup("bugfix", { issueUrl: "javascript:alert(1)" } as Partial<RunState>);
  assert.equal(buildRunSnapshot(s2.home, "9-1").issueUrl, null);
});

test("gate card: shown ONLY when run status is paused AND a node is awaiting-gate (gate.json keeps pendingDecision after approval)", () => {
  const brief = {
    schema: 1, runId: "9-1", workflow: "bugfix", gateNodeId: "fix", iteration: 0, revision: "r.1",
    gateArtifacts: [{ path: "/x/fix/summary.md", sha256: "d28f372f55cdabcdef" }],
    upstreamArtifacts: [{ nodeId: "review", files: [] }],
    validation: [{ nodeId: "reproduce", check: "noPlaceholders", ok: true }],
    companion: { sessionId: "sess-1", reconstructed: false, status: "ok", resume: { sessionId: "sess-1", configDir: "/c", cwd: "/home/u/proj", prompt: "p" } },
    pendingDecision: { actions: ["approve", "amend", "hold"], amendTargets: ["fix"], approveContinuesTo: ["pr"] },
  };
  // paused + awaiting -> card
  const paused = setup("bugfix");
  mkdirSync(join(paused.runDir, "fix"), { recursive: true });
  writeFileSync(join(paused.runDir, "fix", "gate.json"), JSON.stringify(brief));
    const card = buildRunSnapshot(paused.home, "9-1").gate;
  assert.ok(card !== null);
  assert.equal(card.nodeId, "fix");
  assert.equal(card.revision, "r.1");
  assert.equal(card.round, 1);
  assert.equal(card.maxIterations, 5);
  assert.deepEqual(card.actions, ["approve", "amend", "hold"]);
  assert.deepEqual(card.approveContinuesTo, ["pr"]);
  assert.deepEqual(card.evidence, [{ name: "summary.md", sha: "d28f372f55cd" }]);
  assert.deepEqual(card.upstream, ["review"]);
  assert.equal(card.companion?.cwd, "/home/u/proj");

  // run status running (gate.json left behind after an approval) -> no card even though gate.json exists
  const running = setup("bugfix", { status: "running" });
  mkdirSync(join(running.runDir, "fix"), { recursive: true });
  writeFileSync(join(running.runDir, "fix", "gate.json"), JSON.stringify(brief));
  assert.equal(buildRunSnapshot(running.home, "9-1").gate, null);

  // paused but no node awaiting -> no card
  const noAwait = setup("bugfix");
  const st = JSON.parse(readFileSync(join(noAwait.runDir, "state.json"), "utf8")) as RunState;
  st.nodes["fix"] = { ...(st.nodes["fix"] as RunState["nodes"][string]), status: "done" };
  writeFileSync(join(noAwait.runDir, "state.json"), JSON.stringify(st));
  assert.equal(buildRunSnapshot(noAwait.home, "9-1").gate, null);
});

test("gate card without a persisted brief is still shown (lighter), and a brief for a DIFFERENT gate node is ignored", () => {
  const a = setup("bugfix");
  const card = buildRunSnapshot(a.home, "9-1").gate;
  assert.ok(card !== null);
  assert.equal(card.nodeId, "fix");
  assert.equal(card.revision, null);
  assert.deepEqual(card.actions, ["approve", "amend", "hold"]);

  const b = setup("bugfix");
  mkdirSync(join(b.runDir, "fix"), { recursive: true });
  writeFileSync(join(b.runDir, "fix", "gate.json"), JSON.stringify({ gateNodeId: "reproduce", revision: "STALE", iteration: 0 }));
  assert.equal(buildRunSnapshot(b.home, "9-1").gate?.revision, null);
});

test("skipped reason: a workflow-defined skipped node is explained by its `when`/optional; a node the workflow no longer defines has none", () => {
  const base = (over: Record<string, unknown> = {}) =>
    ({ status: "skipped", artifacts: [], iteration: 0, cost: 0, gateHistory: [], ...over }) as RunState["nodes"][string];
  const s = setup("bugfix", { status: "running", nodes: { implement: base(), verify: base() } });
  const snap = buildRunSnapshot(s.home, "9-1");
  assert.equal(snap.nodes["implement"]?.skipReason, "when");
  assert.equal(snap.nodes["verify"]?.skipReason, null, "legacy verify node: no definition, no reason, no throw");
  assert.equal(snap.nodes["reproduce"]?.skipReason, null);
});

test("workflow node definitions are exposed serializably (no `when` function), with gate.maxIterations defaulting to 10", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.defs["verify"], undefined, "the verify node no longer exists");
  assert.deepEqual(snap.defs["pr"]?.dependsOn, ["fix"]);
  assert.equal(snap.defs["fix"]?.gate?.maxIterations, 5);
  assert.equal(snap.defs["reproduce"]?.gate?.maxIterations, 10);
  assert.equal(snap.defs["implement"]?.gate, null);
  assert.doesNotThrow(() => JSON.stringify(snap));
});

test("nodes in state.json that the current workflow no longer defines (legacy digest, expand…) are appended, not dropped; workflow nodes missing from state render as pending", () => {
  const { home } = setup("bugfix", {
    nodes: {
      reproduce: { status: "done", artifacts: [], iteration: 0, cost: 0, gateHistory: [] },
      digest: { status: "done", artifacts: [], iteration: 0, cost: 0.9, gateHistory: [] },
    },
  });
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.nodeOrder.at(-1), "digest");
  assert.ok(snap.nodeOrder.includes("pr"));
  assert.equal(snap.nodes["pr"]?.status, "pending");
  assert.equal(snap.nodes["digest"]?.status, "done");
  assert.equal(snap.defs["digest"], undefined);
});

test("per-node files: registered + extra from disk, plus bookkeeping files (gate.json, burn.json, gate-context.md) the CLI listing hides; transcript.log never", () => {
  const { home, runDir } = setup("bugfix");
  mkdirSync(join(runDir, "fix"), { recursive: true });
  for (const f of ["summary.md", "changes.diff", "burn.json", "gate.json", "gate-context.md", "transcript.log"]) {
    writeFileSync(join(runDir, "fix", f), "x");
  }
  const files = buildRunSnapshot(home, "9-1").nodes["fix"]?.files ?? [];
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.ok(byName["summary.md"] && byName["changes.diff"]);
  assert.equal(byName["summary.md"]?.bookkeeping, false);
  assert.equal(byName["gate.json"]?.bookkeeping, true);
  assert.equal(byName["burn.json"]?.bookkeeping, true);
  assert.equal(byName["transcript.log"], undefined);
  assert.equal(byName["summary.md"]?.registered, false);
});

test("OLD RUN (pre-removal state.json with a done verify node, a fix gate decision and a verify/ dir) snapshots without throwing and keeps the legacy node visible", () => {
  const { home, runDir } = setup("bugfix", {
    status: "done",
    nodes: {
      reproduce: { status: "done", artifacts: [], iteration: 1, cost: 0.1, gateHistory: [] },
      implement: { status: "done", artifacts: [], iteration: 0, cost: 0.2, gateHistory: [] },
      review: { status: "done", artifacts: [], iteration: 0, cost: 0.05, gateHistory: [] },
      fix: {
        status: "done", artifacts: [], iteration: 0, cost: 0.3,
        gateHistory: [{ decision: "approve", timestamp: "t", runNext: true } as never],
      },
      verify: { status: "done", artifacts: [join("/x", "verify", "verify-report.json")], iteration: 0, cost: 0.4, gateHistory: [] },
      pr: { status: "done", artifacts: [], iteration: 0, cost: 0.1, gateHistory: [] },
    },
  });
  mkdirSync(join(runDir, "fix"), { recursive: true });
  mkdirSync(join(runDir, "verify"), { recursive: true });
  writeFileSync(join(runDir, "fix", "next-node-decision.json"), JSON.stringify({ node: "verify", run: true }));
  writeFileSync(join(runDir, "verify", "verify-report.json"), JSON.stringify({ outcome: "PROVISIONED" }));
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.nodeOrder.at(-1), "verify");
  assert.equal(snap.nodes["verify"]?.status, "done");
  assert.equal(snap.defs["verify"], undefined);
  assert.doesNotThrow(() => JSON.stringify(snap));
});
