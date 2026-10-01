import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  amendTargets,
  approveContinuesTo,
  buildGateBrief,
  computeGateRevision,
  decisionId,
  downstreamOf,
  findAppliedDecision,
  findSessionConfigDir,
  planAmend,
  gateResumePrompt,
  readSessionCwd,
  readSessionCwds,
  readNextNodeDecision,
  runHash,
  validateGateRequest,
  type GateBrief,
  type GateRequest,
} from "./gate.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";
import { loadWorkflow } from "../workflow/workflow.js";
import type { NodeState, RunState } from "./state.js";
import type { Workflow } from "./types.js";

const node = (status: NodeState["status"], iteration = 0): NodeState => ({
  status,
  artifacts: [],
  iteration,
  cost: 0,
  gateHistory: [],
});

function makeState(over: Partial<RunState> = {}, gate = "fix"): RunState {
  return {
    runId: "run-1",
    workflow: "bugfix",
    createdAt: "t",
    updatedAt: "t",
    status: "paused",
    worktreePath: "/nonexistent",
    branch: "b",
    sourcePlanPath: "p",
    companion: {
      sessionId: "sess-original-1",
      associatedAt: "t",
      source: "handoff",
      reconstructed: false,
    },
    nodes: Object.fromEntries(
      bugfixWorkflow.nodes.map((n) => [
        n.id,
        node(n.id === gate ? "awaiting-gate" : "pending"),
      ]),
    ),
    ...over,
  };
}

function brief(state: RunState, gate = "fix", blocked = false): GateBrief {
  const b = buildGateBrief({
    runDir: join(tmpdir(), "nonexistent-rundir"),
    state,
    workflow: bugfixWorkflow,
    gateNodeId: gate,
    configDirs: [],
  });
  if (!blocked) b.companion = { ...b.companion, status: "ok" };
  return b;
}

type ReqOver = { [K in keyof GateRequest]?: GateRequest[K] | undefined };
/** Build a request; an explicit `undefined` override REMOVES the key (e.g. runNext). */
const req = (b: GateBrief, over: ReqOver = {}): GateRequest => {
  const merged: Record<string, unknown> = {
    runId: b.runId,
    gate: b.gateNodeId,
    revision: b.revision,
    action: "approve",
    runNext: true,
    ...over,
  };
  for (const k of Object.keys(merged))
    if (merged[k] === undefined) delete merged[k];
  return merged as GateRequest;
};

const v = (state: RunState, b: GateBrief, r: GateRequest) =>
  validateGateRequest({ state, workflow: bugfixWorkflow, brief: b, req: r });

// --- revision binding ------------------------------------------------------

test("revision: changes with evidence, iteration and run; carries the run hash prefix", () => {
  const base = {
    runId: "r",
    gateNodeId: "fix",
    iteration: 0,
    planSha256: "p",
    worktreeHead: "h",
    files: [{ path: "a", sha256: "1" }],
  };
  const r0 = computeGateRevision(base);
  assert.ok(r0.startsWith(runHash("r") + "."));
  assert.notEqual(
    r0,
    computeGateRevision({ ...base, files: [{ path: "a", sha256: "2" }] }),
  );
  assert.notEqual(r0, computeGateRevision({ ...base, iteration: 1 }));
  assert.notEqual(r0, computeGateRevision({ ...base, worktreeHead: "h2" }));
  assert.notEqual(r0, computeGateRevision({ ...base, runId: "other" }));
  assert.equal(r0, computeGateRevision({ ...base, files: [...base.files] }));
});

// --- approval semantics ----------------------------------------------------

test("valid approve at the fix gate passes and names its target", () => {
  const s = makeState();
  const b = brief(s);
  const r = v(s, b, req(b));
  assert.equal(r.ok, true);
});

test("approve at a gate that decides a node REQUIRES an explicit run/skip choice", () => {
  const s = makeState();
  const b = brief(s);
  const r = v(s, b, req(b, { runNext: undefined }));
  assert.equal(r.ok === false && r.code, "missing-run-next");
});

test("run-next is rejected where it does not apply (pr gate / amend)", () => {
  const s = makeState({}, "pr");
  const b = brief(s, "pr");
  assert.equal(
    (v(s, b, req(b, { runNext: true })) as { code?: string }).code,
    "unexpected-run-next",
  );
  const s2 = makeState();
  const b2 = brief(s2);
  assert.equal(
    (v(s2, b2, req(b2, { action: "amend", comment: "x" })) as { code?: string })
      .code,
    "unexpected-run-next",
  );
});

test("amend/hold require a comment", () => {
  const s = makeState();
  const b = brief(s);
  for (const action of ["amend", "hold"]) {
    const r = v(s, b, req(b, { action, runNext: undefined }));
    assert.equal(r.ok === false && r.code, "missing-comment", action);
  }
});

test("unknown action is refused — no generic transitions", () => {
  const s = makeState();
  const b = brief(s);
  assert.equal(
    (v(s, b, req(b, { action: "skip-everything" })) as { code?: string }).code,
    "invalid-action",
  );
});

// --- stale / wrong-run / wrong-gate ----------------------------------------

test("stale revision refused", () => {
  const s = makeState();
  const b = brief(s);
  const stale = req(b, { revision: `${runHash(s.runId)}.deadbeefdeadbeef` });
  assert.equal((v(s, b, stale) as { code?: string }).code, "stale-revision");
});

test("wrong-run approval refused (revision issued for another run)", () => {
  const s = makeState();
  const b = brief(s);
  const other = brief(makeState({ runId: "run-2" }));
  assert.equal(
    (v(s, b, req(b, { revision: other.revision })) as { code?: string }).code,
    "wrong-run",
  );
  assert.equal(
    (v(s, b, req(b, { runId: "run-2" })) as { code?: string }).code,
    "wrong-run",
  );
});

test("wrong gate / not-awaiting refused", () => {
  const s = makeState();
  const b = brief(s);
  assert.equal(
    (v(s, b, req(b, { gate: "pr" })) as { code?: string }).code,
    "not-awaiting",
  );
  const s2 = makeState({}, "pr");
  const b2 = brief(s2, "pr");
  s2.nodes["fix"] = node("awaiting-gate"); // two nodes claim awaiting → gate mismatch
  assert.equal(
    (
      v(
        s2,
        b2,
        req(b2, { gate: "fix", revision: b2.revision, runNext: undefined }),
      ) as { code?: string }
    ).code,
    "wrong-gate",
  );
});

// --- companion association -------------------------------------------------

test("no companion recorded → blocked with recovery choices, never a decision", () => {
  const { companion: _c, ...rest } = makeState();
  const s = rest as RunState;
  const b = brief(s, "fix", true);
  assert.equal(b.companion.status, "blocked");
  assert.match(b.companion.blockedReason ?? "", /attach/);
  assert.equal((v(s, b, req(b)) as { code?: string }).code, "no-companion");
});

test("recorded session with no transcript → blocked (session-unavailable), recovery mentions --reconstructed", () => {
  const s = makeState();
  const b = brief(s, "fix", true); // configDirs [] → not found
  assert.equal(b.companion.status, "blocked");
  assert.match(b.companion.blockedReason ?? "", /--reconstructed/);
  assert.equal(
    (v(s, b, req(b)) as { code?: string }).code,
    "session-unavailable",
  );
});

test("a different session cannot decide the gate", () => {
  const s = makeState();
  const b = brief(s);
  assert.equal(
    (v(s, b, req(b, { session: "someone-else" })) as { code?: string }).code,
    "session-mismatch",
  );
  assert.equal(v(s, b, req(b, { session: "sess-original-1" })).ok, true);
});

test("readSessionCwd reads the session's directory from the transcript head; null when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cwd-"));
  const f = join(dir, "s.jsonl");
  writeFileSync(
    f,
    '{"type":"user","cwd":"/Users/e/dev/my proj","sessionId":"x"}\n',
  );
  assert.equal(readSessionCwd(f), "/Users/e/dev/my proj");
  writeFileSync(f, '{"type":"summary"}\n');
  assert.equal(readSessionCwd(f), null);
  assert.equal(readSessionCwd(join(dir, "missing.jsonl")), null);
  // A session that outlived a directory rename: newest cwd wins, older ones follow.
  writeFileSync(
    f,
    '{"cwd":"/old/name"}\n{"cwd":"/old/name"}\n{"cwd":"/new/name"}\n',
  );
  assert.equal(readSessionCwd(f), "/new/name");
  assert.deepEqual(readSessionCwds(f), ["/new/name", "/old/name"]);
});

test("gateResumePrompt tells a resumed conversation a gate is waiting, defers facts to `gate show`, and forbids deciding", () => {
  const p = gateResumePrompt("59478-2", "reproduce");
  assert.match(p, /run 59478-2 is paused at its "reproduce" gate/);
  assert.match(p, /dagrun gate show 59478-2/);
  assert.match(p, /bug-fix-companion/);
  assert.match(
    p,
    /Do not decide or confirm anything until I explicitly tell you/,
  );
  assert.doesNotMatch(
    p,
    /revision/i,
    "no revision baked into a prompt that could go stale",
  );
});

test("findSessionConfigDir locates a transcript and rejects bad ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(dir, "projects", "-some-proj"), { recursive: true });
  writeFileSync(
    join(dir, "projects", "-some-proj", "abcd1234-sess.jsonl"),
    "{}\n",
  );
  assert.equal(findSessionConfigDir("abcd1234-sess", ["/nope", dir]), dir);
  assert.equal(findSessionConfigDir("missing-sess-id", [dir]), null);
  assert.equal(findSessionConfigDir("../../etc", [dir]), null);
});

// --- idempotence -----------------------------------------------------------

test("decisionId is deterministic and bound to every field", () => {
  const b = {
    runId: "r",
    gate: "fix",
    revision: "x.y",
    action: "approve",
    runNext: true,
  };
  assert.equal(decisionId(b), decisionId({ ...b }));
  for (const change of [
    { runId: "r2" },
    { gate: "pr" },
    { revision: "x.z" },
    { action: "amend" },
    { runNext: false },
    { comment: "c" },
    { target: "fix" },
  ]) {
    assert.notEqual(
      decisionId(b),
      decisionId({ ...b, ...change }),
      JSON.stringify(change),
    );
  }
});

test("findAppliedDecision detects a repeat on any node's history", () => {
  const s = makeState();
  s.nodes["fix"]!.gateHistory.push({
    decision: "approve",
    timestamp: "t",
    decisionId: "abc",
    action: "approve",
  });
  assert.deepEqual(findAppliedDecision(s, "abc"), {
    nodeId: "fix",
    action: "approve",
  });
  assert.equal(findAppliedDecision(s, "zzz"), null);
});

// --- graph / amend planning ------------------------------------------------

test("amend targets: gate itself + declared gated ancestors only", () => {
  assert.deepEqual(amendTargets(bugfixWorkflow, "pr"), ["pr", "fix"]);
  assert.deepEqual(amendTargets(bugfixWorkflow, "fix"), ["fix"]);
  assert.deepEqual(amendTargets(bugfixWorkflow, "reproduce"), ["reproduce"]);
  const s = makeState({}, "pr");
  const b = brief(s, "pr");
  assert.equal(
    (
      v(
        s,
        b,
        req(b, {
          action: "amend",
          comment: "c",
          target: "reproduce",
          runNext: undefined,
        }),
      ) as { code?: string }
    ).code,
    "bad-target",
  );
  assert.equal(
    v(
      s,
      b,
      req(b, {
        action: "amend",
        comment: "c",
        target: "fix",
        runNext: undefined,
      }),
    ).ok,
    true,
  );
});

test("amending fix from the pre-PR gate invalidates verify, pr and digest", () => {
  const p = planAmend(bugfixWorkflow, "pr", "fix");
  assert.equal(p.revise, "fix");
  assert.deepEqual([...p.reset].sort(), ["digest", "pr", "verify"]);
  assert.deepEqual(planAmend(bugfixWorkflow, "pr", "pr"), {
    revise: "pr",
    reset: [],
  });
  assert.ok(downstreamOf(bugfixWorkflow, "reproduce").includes("pr"));
  assert.deepEqual(approveContinuesTo(bugfixWorkflow, "fix"), [
    "verify",
    "pr",
    "digest",
  ]);
});

// --- featureWorkflow parity (DECISIONS.md § feature-companion-gates-parity) ---
// Mirrors the bugfix cases immediately above — feature's pr gate now has the
// same amendTargets/companion-gate shape, proven through the same generic
// gate.ts functions (never special-cased by workflow name).

test("featureWorkflow: amend targets: gate itself + declared gated ancestors only", () => {
  assert.deepEqual(amendTargets(featureWorkflow, "pr"), ["pr", "fix"]);
  assert.deepEqual(amendTargets(featureWorkflow, "fix"), ["fix"]);
  assert.deepEqual(amendTargets(featureWorkflow, "define"), ["define"]);
});

test("featureWorkflow: amending fix from the pre-PR gate invalidates verify, pr and digest", () => {
  const p = planAmend(featureWorkflow, "pr", "fix");
  assert.equal(p.revise, "fix");
  assert.deepEqual([...p.reset].sort(), ["digest", "pr", "verify"]);
  assert.deepEqual(planAmend(featureWorkflow, "pr", "pr"), {
    revise: "pr",
    reset: [],
  });
  assert.ok(downstreamOf(featureWorkflow, "define").includes("pr"));
  assert.deepEqual(approveContinuesTo(featureWorkflow, "fix"), [
    "verify",
    "pr",
    "digest",
  ]);
});

test("loadWorkflow: feature workflow (companion gates, decidesNode, amendTargets) is valid", () => {
  loadWorkflow(featureWorkflow);
});

// --- next-node decision + load-time validation -----------------------------

test("readNextNodeDecision: parses, and fails loud on malformed content", () => {
  assert.equal(
    readNextNodeDecision('{"node":"verify","run":true}', "verify"),
    true,
  );
  assert.equal(
    readNextNodeDecision('{"node":"verify","run":false}', "verify"),
    false,
  );
  assert.throws(
    () => readNextNodeDecision('{"node":"other","run":true}', "verify"),
    /malformed/,
  );
  assert.throws(
    () => readNextNodeDecision('{"node":"verify","run":"yes"}', "verify"),
    /malformed/,
  );
  assert.throws(() => readNextNodeDecision("not json", "verify"));
});

test("loadWorkflow: bugfix workflow (companion gates, decidesNode, amendTargets) is valid", () => {
  loadWorkflow(bugfixWorkflow);
});

test("loadWorkflow: rejects bad companionGates / decidesNode / amendTargets / evidenceCheck", () => {
  const base = (): Workflow => ({
    name: "t",
    companionGates: true,
    nodes: [
      { id: "a", command: "/a", gate: {} },
      { id: "b", dependsOn: ["a"], command: "/b" },
    ],
  });
  loadWorkflow(base());
  const noGate = base();
  delete noGate.nodes[0]!.gate;
  assert.throws(
    () => loadWorkflow(noGate),
    /companionGates is true but no node declares a gate/,
  );
  const badDecides = base();
  badDecides.nodes[0]!.gate = { decidesNode: "zzz" };
  assert.throws(
    () => loadWorkflow(badDecides),
    /decidesNode references unknown node "zzz"/,
  );
  const noWhen = base();
  noWhen.nodes[0]!.gate = { decidesNode: "b" };
  assert.throws(() => loadWorkflow(noWhen), /must declare a 'when' predicate/);
  const badAmend = base();
  badAmend.nodes[1]!.gate = { amendTargets: ["b"] };
  assert.throws(() => loadWorkflow(badAmend), /not an ancestor/);
  const badEv = base();
  (badEv.nodes[1] as { evidenceCheck?: string }).evidenceCheck = "nope";
  assert.throws(() => loadWorkflow(badEv), /invalid evidenceCheck/);
});

test("gate brief lists on-disk files not yet registered in state, without changing the revision", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-gate-files-"));
  mkdirSync(join(runDir, "fix"), { recursive: true });
  mkdirSync(join(runDir, "review"), { recursive: true });
  writeFileSync(join(runDir, "fix", "summary.md"), "S");
  writeFileSync(join(runDir, "fix", "transcript.log"), "noise");
  writeFileSync(join(runDir, "review", "findings.json"), "{}");
  const st = makeState({}, "fix");
  st.nodes["review"] = {
    ...node("done"),
    artifacts: [join(runDir, "review", "findings.json")],
  };
  const build = () =>
    buildGateBrief({
      runDir,
      state: st,
      workflow: bugfixWorkflow,
      gateNodeId: "fix",
      configDirs: [],
    });
  const before = build();
  writeFileSync(join(runDir, "fix", "changes.diff"), "diff --git");
  writeFileSync(join(runDir, "review", "extra.md"), "x");
  const after = build();
  assert.equal(
    after.revision,
    before.revision,
    "unregistered files never change the revision",
  );
  const names = (fs: { path: string; registered?: boolean }[]) =>
    fs.map((f) => `${f.path.split("/").at(-1)}:${f.registered}`);
  assert.deepEqual(names(after.gateArtifacts), [
    "changes.diff:false",
    "summary.md:false",
  ]);
  assert.ok(
    after.gateArtifacts.every(
      (f) => typeof f.size === "number" && typeof f.mtime === "string",
    ),
  );
  assert.deepEqual(
    names(
      after.upstreamArtifacts.find((u) => u.nodeId === "review")?.files ?? [],
    ),
    ["findings.json:true", "extra.md:false"],
  );
  // a registered non-produces file is listed (registered first) but still not hashed into the revision
  st.nodes["fix"] = {
    ...node("awaiting-gate"),
    artifacts: [join(runDir, "fix", "changes.diff")],
  };
  const reg = build();
  assert.deepEqual(names(reg.gateArtifacts), [
    "changes.diff:true",
    "summary.md:false",
  ]);
  assert.equal(reg.revision, before.revision);
});

test("editing a produces file still changes the revision", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-gate-files-"));
  mkdirSync(join(runDir, "fix"), { recursive: true });
  writeFileSync(join(runDir, "fix", "summary.md"), "S");
  const st = makeState({}, "fix");
  const build = () =>
    buildGateBrief({
      runDir,
      state: st,
      workflow: bugfixWorkflow,
      gateNodeId: "fix",
      configDirs: [],
    }).revision;
  const a = build();
  writeFileSync(join(runDir, "fix", "summary.md"), "S2");
  assert.notEqual(build(), a);
});
