/**
 * smoke-gates-feature.ts — in-process end-to-end test of COMPANION GATES on the
 * feature workflow (mock executor, no SDK, no API key, no real Claude session).
 *
 * Added by the feature/bugfix companion-gates parity change (DECISIONS.md §
 * feature-companion-gates-parity): featureWorkflow gained `companionGates: true`
 * and a pre-PR gate on `pr` (gate.amendTargets: ["fix"]), mirroring bugfix exactly.
 * This is a separate file (not an extension of smoke-gates.ts) because that file
 * hardcodes the bugfix node id "reproduce" and `bugfixWorkflow` throughout, and the
 * docker-teardown / detach / session-recovery mechanics it proves are workflow-
 * agnostic (already proven generic there — `ancestorsOf`/`node.gate` keyed, never
 * on workflow name). This file proves only what is NEW for feature: the full gate
 * path end to end (define -> implement -> review -> fix (decide verify) -> verify
 * -> pr -> done), the publication-timing behavior change (approving the fix gate no
 * longer auto-publishes — only the pr gate's approval does), and one
 * amend-at-pr-targets-fix case.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startRun } from "../../src/runtime/run-engine.js";
import { gateDecide, gateShow } from "../../src/runtime/gate-cli.js";
import {
  createMockExecutor,
  type NodeExecutor,
  type NodeScenario,
} from "../../src/runtime/mock-executor.js";
import { featureWorkflow } from "../../src/workflow/feature-workflow.js";
import type { DagrunnerConfig } from "../../src/config/xdg.js";
import type { GateBrief } from "../../src/core/gate.js";
import type { RunState } from "../../src/core/state.js";
import type { Node } from "../../src/core/types.js";
import type { ExecutionCtx } from "../../src/runtime/mock-executor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOY_REPO = join(__dirname, "fixtures", "toy-repo");
if (!existsSync(join(TOY_REPO, ".git"))) {
  mkdirSync(TOY_REPO, { recursive: true });
  execSync(
    'git init && echo "# toy" > README.md && git add README.md && git commit -m init',
    { cwd: TOY_REPO, stdio: "inherit" },
  );
}
const config: DagrunnerConfig = { DEVHARNESS_SRC: TOY_REPO };

// --- fake Claude config dir holding the "originating companion" transcript ---
const CFG = mkdtempSync(join(tmpdir(), "dagrun-gates-feature-cfg-"));
process.env["CLAUDE_CONFIG_DIR"] = CFG;
const SESSION = "33333333-aaaa-bbbb-cccc-000000000003";
function transcript(id: string): void {
  const d = join(CFG, "projects", "-fake-companion");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${id}.jsonl`),
    `{"type":"user","cwd":"${CFG}","sessionId":"${id}"}\n`,
  );
}
transcript(SESSION);

// --- helpers (mirrors smoke-gates.ts) ---------------------------------------
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = errw;
  }
}
const stateOf = (runDir: string): RunState =>
  JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
const briefOf = (runDir: string, gate: string): GateBrief =>
  JSON.parse(
    readFileSync(join(runDir, gate, "gate.json"), "utf8"),
  ) as GateBrief;
const stamp = Date.now();
let seq = 0;
function newHome(): { home: string; plan: string } {
  const home = mkdtempSync(join(tmpdir(), "dagrun-gates-feature-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "worktrees"), { recursive: true });
  const plan = join(home, `${stamp + ++seq}-toy-plan.md`);
  writeFileSync(
    plan,
    readFileSync(join(__dirname, "fixtures", "toy-plan.md"), "utf8"),
  );
  return { home, plan };
}
// The mock executor writes nothing into the worktree; a real fix does. Model that (an
// UNTRACKED file, which is what changes.diff must render as a new-file diff) around the
// mock, per fix run — same pattern as smoke-gates.ts.
//
// Pause-vs-run is keyed on the node's OWN declared `node.gate`, not a fixed per-node
// scenario string — mirrors sdk-runner.ts:441's real production check
// (`if (node.gate !== undefined) return {status: "awaiting-gate", …}`) exactly, so a
// workflow edit that adds/removes a gate (e.g. the pr gate under test here) is actually
// exercised by this mock, not just modeled by convention. `over` is an explicit escape
// hatch (e.g. a non-"success" terminal scenario for a specific node) and always wins.
const factory =
  (over: Record<string, NodeScenario> = {}) =>
  (): NodeExecutor =>
  async (id: string, node: Node, ctx: ExecutionCtx) => {
    if (id === "fix")
      writeFileSync(
        join(ctx.worktreePath, "mock-fix-change.txt"),
        "mock fix change\n",
      );
    const scenario: NodeScenario =
      over[id] ?? (node.gate !== undefined ? "gate-pause" : "success");
    const result = await createMockExecutor({ [id]: scenario })(id, node, ctx);
    // Give the publication-timing proof real teeth: a real /pr session writes
    // pr-meta.json (title, no prUrl yet) alongside body.md; the mock's "success"/
    // "gate-pause" scenarios don't, so model that here. runPrPostProcess reads
    // this file and attempts `git push origin HEAD`, which fails loud (no "origin"
    // remote on the toy repo) — so pr/pr-error.txt appearing is direct evidence
    // that runPrPostProcess actually ran, not just that the node reached "done".
    if (id === "pr" && existsSync(ctx.artifactsDir)) {
      writeFileSync(
        join(ctx.artifactsDir, "pr-meta.json"),
        JSON.stringify({ title: "feat: mock pr" }, null, 2),
        "utf8",
      );
    }
    return result;
  };

async function newRun(over: Record<string, NodeScenario> = {}) {
  const { home, plan } = newHome();
  await quiet(() =>
    startRun({
      workflow: featureWorkflow,
      planPath: plan,
      homeDir: home,
      config,
      executorFactory: factory(over),
      companionSessionId: SESSION,
    }),
  );
  const runId = readdirSync(join(home, "runs"))[0] as string;
  return { home, runId, runDir: join(home, "runs", runId) };
}
const decide = (
  h: { home: string; runId: string },
  brief: GateBrief,
  o: Record<string, unknown>,
  over: Record<string, NodeScenario> = {},
) =>
  quiet(() =>
    gateDecide({
      homeDir: h.home,
      config,
      runId: h.runId,
      gate: brief.gateNodeId,
      revision: brief.revision,
      action: "approve",
      ...o,
      executorFactory: factory(over),
    } as never),
  );
/** propose, then confirm — returns the decision id. */
async function propose(
  h: { home: string; runId: string },
  brief: GateBrief,
  o: Record<string, unknown>,
): Promise<string> {
  let out = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  try {
    const c = await gateDecide({
      homeDir: h.home,
      config,
      runId: h.runId,
      gate: brief.gateNodeId,
      revision: brief.revision,
      action: "approve",
      ...o,
    } as never);
    assert.equal(c, 0, "proposal must succeed");
  } finally {
    process.stdout.write = real;
  }
  const m = /--confirm ([0-9a-f]{16})/.exec(out);
  assert.ok(m, `proposal must print a confirm id, got: ${out}`);
  return m[1] as string;
}
const say = (m: string) => console.log(`step ${m}`);
function createBrief(h: { home: string; runId: string }): GateBrief {
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((x: string) => {
    out.push(x);
    return true;
  }) as typeof process.stdout.write;
  try {
    gateShow({ homeDir: h.home, config, runId: h.runId });
  } finally {
    process.stdout.write = real;
  }
  return JSON.parse(out.join("")) as GateBrief;
}

// ===========================================================================
// 1. startRun on featureWorkflow requires the same explicit companion
//    association bugfix requires (companionGates: true is now data-driven,
//    not bugfix-only — see DECISIONS.md § feature-companion-gates-parity).
// ===========================================================================
{
  const { home, plan } = newHome();
  const base = {
    workflow: featureWorkflow,
    planPath: plan,
    homeDir: home,
    config,
    executorFactory: factory(),
  };
  await assert.rejects(
    () => startRun(base),
    /--companion-session <id>.*--no-companion/s,
  );
  assert.equal(
    readdirSync(join(home, "runs")).length,
    0,
    "a refused start must create no run",
  );
  say(
    "1 passed: featureWorkflow now requires an explicit companion association (or --no-companion), same as bugfix",
  );
}

// ===========================================================================
// 2-6. Full companion-gate lifecycle: define -> fix (skip verify) -> pr -> done
// ===========================================================================
const R = await newRun();
{
  const s = stateOf(R.runDir);
  assert.equal(s.status, "paused");
  assert.equal(s.nodes["define"]?.status, "awaiting-gate");
  assert.equal(s.companion?.sessionId, SESSION);
  const b = createBrief(R); // exercises the real `gateShow` CLI path once
  assert.equal(b.companion.status, "ok");
  assert.deepEqual(b.pendingDecision.approveContinuesTo, [
    "implement",
    "review",
    "fix",
    "verify",
    "pr",
  ]);
  say(
    "2 passed: define gate pauses with a companion brief, exactly like bugfix's reproduce gate",
  );
}

{
  const b = briefOf(R.runDir, "define");
  const id = await propose(R, b, {});
  assert.equal(await decide(R, b, { confirm: id }), 0);
  const s = stateOf(R.runDir);
  assert.equal(s.nodes["define"]?.status, "done");
  assert.equal(s.nodes["implement"]?.status, "done");
  assert.equal(s.nodes["review"]?.status, "done");
  assert.equal(s.nodes["fix"]?.status, "awaiting-gate");
  say("3 passed: approve define -> implement -> review -> fix gate-pause");
}

{
  const b = briefOf(R.runDir, "fix");
  assert.equal(b.pendingDecision.decidesNode, "verify");
  assert.deepEqual(b.pendingDecision.amendTargets, ["fix"]);
  assert.equal(await decide(R, b, {}), 1, "approve without --run-next refused");
  const id = await propose(R, b, { runNext: false });
  assert.equal(await decide(R, b, { runNext: false, confirm: id }), 0);
  const s = stateOf(R.runDir);
  assert.equal(
    s.nodes["verify"]?.status,
    "skipped",
    "verify skipped by decision",
  );
  // The publication-timing proof (DECISIONS.md § feature-companion-gates-parity):
  // approving fix does NOT auto-publish. pr only reaches awaiting-gate, composed
  // in-session; no push/draft-PR has happened (no prUrl anywhere).
  assert.equal(
    s.nodes["pr"]?.status,
    "awaiting-gate",
    "fix-gate approval must not auto-publish — pr must pause at its own gate",
  );
  assert.equal(s.status, "paused");
  assert.ok(
    existsSync(join(R.runDir, "pr", "body.md")),
    "pr composed body.md in-session",
  );
  // runPrPostProcess only acts once nodes.pr.status === "done" (run-engine.ts);
  // pr is "awaiting-gate" here, so it must never have been invoked — no
  // pr-error.txt (the toy repo has no "origin" remote, so a real invocation
  // would fail loud and write one; see run-engine.ts's runPrPostProcess).
  assert.equal(
    existsSync(join(R.runDir, "pr", "pr-error.txt")),
    false,
    "runPrPostProcess must not have run yet — pr is still awaiting-gate",
  );
  say(
    "4 passed: fix gate demands an explicit run/skip verify choice; skip -> verify skipped -> pr paused at its OWN gate (not auto-published)",
  );
}

{
  const b = briefOf(R.runDir, "pr");
  assert.deepEqual(b.pendingDecision.amendTargets, ["pr", "fix"]);
  const id = await propose(R, b, {});
  assert.equal(await decide(R, b, { confirm: id }), 0);
  const s = stateOf(R.runDir);
  assert.equal(s.status, "done");
  assert.equal(s.nodes["pr"]?.status, "done");
  // Real teeth, not just a status check: approving the pr gate is what makes
  // runPrPostProcess actually run `git push origin HEAD` — which fails loud
  // (no "origin" remote on the toy repo) and writes pr-error.txt. Its
  // appearance, exactly now and not at step 4, is direct evidence that
  // publication was attempted only after THIS approval, not fix's.
  assert.match(
    readFileSync(join(R.runDir, "pr", "pr-error.txt"), "utf8"),
    /git push failed/,
    "pr-gate approval must trigger runPrPostProcess (push attempted, fails loud on the remote-less toy repo)",
  );
  say(
    "5 passed: pre-PR approval completes the run exactly once (verify skipped, joinRule tolerated it) and is what actually triggers publication (runPrPostProcess attempted the push only now)",
  );
}

// ===========================================================================
// 6. Full gate path WITH verify chosen: fix gate decide yes -> verify runs
//    (PROVISIONED) -> pr gate reached -> approve -> done.
// ===========================================================================
{
  const V = await newRun();
  const b1 = briefOf(V.runDir, "define");
  await decide(V, b1, { confirm: await propose(V, b1, {}) });
  const b2 = briefOf(V.runDir, "fix");
  const id2 = await propose(V, b2, { runNext: true });
  assert.equal(await decide(V, b2, { runNext: true, confirm: id2 }), 0);
  const s1 = stateOf(V.runDir);
  assert.equal(
    s1.nodes["verify"]?.status,
    "done",
    "verify must run when chosen at the fix gate",
  );
  const rep = JSON.parse(
    readFileSync(join(V.runDir, "verify", "verify-report.json"), "utf8"),
  ) as { outcome: string };
  assert.equal(rep.outcome, "PROVISIONED");
  assert.equal(
    s1.nodes["pr"]?.status,
    "awaiting-gate",
    "pre-PR gate reached, not auto-published",
  );
  const b3 = briefOf(V.runDir, "pr");
  await decide(V, b3, { confirm: await propose(V, b3, {}) });
  const s2 = stateOf(V.runDir);
  assert.equal(s2.status, "done");
  assert.equal(s2.nodes["pr"]?.status, "done");
  say(
    "6 passed: fix gate decide yes -> verify runs to PROVISIONED -> pr gate -> approve -> done",
  );
}

// ===========================================================================
// 7. amend-at-pr-targets-fix: revise fix from the pre-PR gate, invalidate
//    verify/pr, no publication — mirrors bugfix's smoke-gates.ts case 8.
// ===========================================================================
{
  const A = await newRun();
  const b1 = briefOf(A.runDir, "define");
  await decide(A, b1, { confirm: await propose(A, b1, {}) });
  const b2 = briefOf(A.runDir, "fix");
  const id2 = await propose(A, b2, { runNext: false });
  await decide(A, b2, { runNext: false, confirm: id2 });

  const b3 = briefOf(A.runDir, "pr");
  assert.deepEqual(b3.pendingDecision.amendTargets, ["pr", "fix"]);
  assert.equal(
    await decide(A, b3, { action: "amend", target: "define", comment: "redo" }),
    1,
    "undeclared target refused",
  );
  const o = {
    action: "amend",
    target: "fix",
    comment: "handle the null case too",
  };
  const id3 = await propose(A, b3, o);
  assert.equal(await decide(A, b3, { ...o, confirm: id3 }), 0);
  const s = stateOf(A.runDir);
  assert.equal(
    s.nodes["fix"]?.status,
    "awaiting-gate",
    "fix revised and paused again",
  );
  for (const n of ["verify", "pr"]) {
    assert.notEqual(
      s.nodes[n]?.status,
      "done",
      `${n} must not keep stale results`,
    );
  }
  assert.equal(s.nodes["pr"]?.status, "pending");
  assert.ok(
    existsSync(join(A.runDir, "pr-attempts", "attempt-1")),
    "stale pr evidence archived, not reused",
  );
  const fixHist = s.nodes["fix"]!.gateHistory.at(-1)!;
  assert.deepEqual([...(fixHist.invalidated ?? [])].sort(), ["pr", "verify"]);
  // pr was never approved (amended instead), so runPrPostProcess never ran —
  // no pr-error.txt (same real-teeth evidence as step 4/5: a real invocation
  // on the remote-less toy repo fails loud and writes one).
  assert.equal(
    existsSync(join(A.runDir, "pr-attempts", "attempt-1", "pr-error.txt")),
    false,
    "no PR publication was ever attempted before the amend",
  );
  assert.equal(
    existsSync(join(A.runDir, "pr", "pr-error.txt")),
    false,
    "no PR publication was ever attempted before the amend",
  );
  // the old pr-gate revision is now stale
  assert.equal(
    await decide(A, b3, { action: "approve" }),
    1,
    "stale pr-gate approval refused after amend",
  );
  say(
    '7 passed: amend at the pre-PR gate re-runs fix, invalidates + archives verify/pr, no publication (featureWorkflow pr.gate.amendTargets: ["fix"])',
  );
}

rmSync(CFG, { recursive: true, force: true });

console.log("smoke-gates-feature: ALL PASSED");
