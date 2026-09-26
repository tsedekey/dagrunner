/**
 * smoke-gates.ts — in-process end-to-end test of COMPANION GATES on the bugfix
 * workflow (mock executor, no SDK, no API key, no real Claude session).
 *
 * Proves routing/authorization semantics of `dagrun gate show|decide|attach`:
 * association at handoff, blocked/recovery paths, understanding-only cannot
 * advance, bound/stale/duplicate/wrong-run decisions, the fix-gate verify
 * decision, amend-with-invalidation (no replayed publication), pause/restart,
 * and verify's evidence contract (no false pass).
 *
 * It does NOT prove that a real interactive Claude session can be re-entered
 * with `claude --resume` — that is a harness property, checked separately.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startRun, resumeRun } from "../../src/runtime/run-engine.js";
import { gateAttach, gateDecide, gateShow } from "../../src/runtime/gate-cli.js";
import { createMockExecutor } from "../../src/runtime/mock-executor.js";
import { bugfixWorkflow } from "../../src/workflow/bugfix-workflow.js";
import type { DagrunnerConfig } from "../../src/config/xdg.js";
import type { GateBrief } from "../../src/core/gate.js";
import type { RunState } from "../../src/core/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOY_REPO = join(__dirname, "fixtures", "toy-repo");
if (!existsSync(join(TOY_REPO, ".git"))) {
  mkdirSync(TOY_REPO, { recursive: true });
  execSync('git init && echo "# toy" > README.md && git add README.md && git commit -m init', { cwd: TOY_REPO, stdio: "inherit" });
}
const config: DagrunnerConfig = { DEVHARNESS_SRC: TOY_REPO };

// --- fake Claude config dir holding the "originating companion" transcript ---
const CFG = mkdtempSync(join(tmpdir(), "dagrun-gates-cfg-"));
process.env["CLAUDE_CONFIG_DIR"] = CFG;
const SESSION = "11111111-aaaa-bbbb-cccc-000000000001";
const SESSION_2 = "22222222-aaaa-bbbb-cccc-000000000002";
function transcript(id: string, present = true): void {
  const d = join(CFG, "projects", "-fake-companion");
  mkdirSync(d, { recursive: true });
  const f = join(d, `${id}.jsonl`);
  if (present) writeFileSync(f, `{"type":"user","cwd":"/fake/companion dir","sessionId":"${id}"}\n`);
  else rmSync(f, { force: true });
}
transcript(SESSION);

// --- helpers ---------------------------------------------------------------
class Exit extends Error { constructor(public code: number) { super(`exit ${code}`); } }
async function captureExit(fn: () => Promise<unknown>): Promise<number> {
  const real = process.exit.bind(process);
  const out = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.exit = ((c?: number) => { throw new Exit(c ?? 0); }) as typeof process.exit;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { await fn(); return 0; }
  catch (e) { if (e instanceof Exit) return e.code; throw e; }
  finally { process.exit = real; process.stdout.write = out; process.stderr.write = errw; }
}
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await fn(); } finally { process.stdout.write = out; process.stderr.write = errw; }
}
const stateOf = (runDir: string): RunState => JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
const briefOf = (runDir: string, gate: string): GateBrief => JSON.parse(readFileSync(join(runDir, gate, "gate.json"), "utf8")) as GateBrief;
const stamp = Date.now();
let seq = 0;
function newHome(): { home: string; plan: string } {
  const home = mkdtempSync(join(tmpdir(), "dagrun-gates-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "worktrees"), { recursive: true });
  const plan = join(home, `${stamp + ++seq}-toy-plan.md`);
  writeFileSync(plan, readFileSync(join(__dirname, "fixtures", "toy-plan.md"), "utf8"));
  return { home, plan };
}
const factory = (over: Record<string, string> = {}) => () =>
  createMockExecutor({ reproduce: "gate-pause", implement: "success", review: "success", fix: "gate-pause", verify: "success", pr: "gate-pause", digest: "success", ...over } as never);

async function newRun(over: Record<string, string> = {}, session: string | null = SESSION) {
  const { home, plan } = newHome();
  await quiet(() => startRun({ workflow: bugfixWorkflow, planPath: plan, homeDir: home, config, executorFactory: factory(over), ...(session !== null ? { companionSessionId: session } : { noCompanion: true }) }));
  const runId = readdirSync(join(home, "runs"))[0] as string;
  return { home, runId, runDir: join(home, "runs", runId) };
}
const decide = (h: { home: string; runId: string }, brief: GateBrief, o: Record<string, unknown>, over: Record<string, string> = {}) =>
  quiet(() => gateDecide({ homeDir: h.home, config, runId: h.runId, gate: brief.gateNodeId, revision: brief.revision, action: "approve", ...o, executorFactory: factory(over) } as never));
/** propose, then confirm — returns the decision id. */
async function propose(h: { home: string; runId: string }, brief: GateBrief, o: Record<string, unknown>): Promise<string> {
  let out = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try { const c = await gateDecide({ homeDir: h.home, config, runId: h.runId, gate: brief.gateNodeId, revision: brief.revision, action: "approve", ...o } as never); assert.equal(c, 0, "proposal must succeed"); }
  finally { process.stdout.write = real; }
  const m = /--confirm ([0-9a-f]{16})/.exec(out);
  assert.ok(m, `proposal must print a confirm id, got: ${out}`);
  return m[1] as string;
}
const say = (m: string) => console.log(`step ${m}`);

// ===========================================================================
// 1. Handoff association is explicit and fail-loud
// ===========================================================================
{
  const { home, plan } = newHome();
  const base = { workflow: bugfixWorkflow, planPath: plan, homeDir: home, config, executorFactory: factory() };
  await assert.rejects(() => startRun(base), /--companion-session <id>.*--no-companion/s);
  await assert.rejects(() => startRun({ ...base, companionSessionId: SESSION, noCompanion: true }), /mutually exclusive/);
  await assert.rejects(() => startRun({ ...base, companionSessionId: SESSION, nightMode: true }), /--night/);
  await assert.rejects(() => startRun({ ...base, companionSessionId: "99999999-no-such-session" }), /no transcript/);
  assert.equal(readdirSync(join(home, "runs")).length, 0, "a refused start must create no run");
  say("1 passed: start requires an explicit, reachable companion session (or --no-companion); no run created on refusal");
}

function createBrief(): GateBrief {
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((x: string) => { out.push(x); return true; }) as typeof process.stdout.write;
  try { gateShow({ homeDir: R.home, config, runId: R.runId }); } finally { process.stdout.write = real; }
  return JSON.parse(out.join("")) as GateBrief;
}

// ===========================================================================
// 2-6. Full companion-gate lifecycle on one run
// ===========================================================================
const R = await newRun();
{
  const s = stateOf(R.runDir);
  assert.equal(s.status, "paused");
  assert.equal(s.nodes["reproduce"]?.status, "awaiting-gate");
  assert.equal(s.companion?.sessionId, SESSION);
  assert.equal(s.companion?.source, "handoff");
  const b = briefOf(R.runDir, "reproduce");
  assert.equal(b.companion.status, "ok");
  assert.match(b.companion.resumeHint ?? "", new RegExp(`claude --resume ${SESSION}`));
  assert.equal(b.companion.resume?.cwd, "/fake/companion dir");
  assert.match(b.companion.resumeHint ?? "", /^cd '\/fake\/companion dir' && CLAUDE_CONFIG_DIR='.*' claude --resume 1111.* 'DagRunner run .* gate show /s);
  assert.equal(b.pendingDecision.decidesNode, undefined);
  assert.deepEqual(b.pendingDecision.approveContinuesTo, ["implement", "review", "fix", "verify", "pr", "digest"]);
  assert.ok(existsSync(join(R.runDir, "reproduce", "gate-context.md")));
  assert.equal(s.companion?.configDir, CFG, "config dir recorded at handoff");
  // From a bare terminal (no CLAUDE_CONFIG_DIR) the recorded dir still finds the session.
  const savedCfg = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  const bare = createBrief();
  process.env["CLAUDE_CONFIG_DIR"] = savedCfg;
  assert.equal(bare.companion.status, "ok", "recorded configDir must keep the association reachable without env");
  say("2 passed: handoff records the originating session; pause writes a brief (run, gate, revision, evidence, pending decision) and NO gate agent was spawned");
}

// 3. bare flags refused; plain resume just re-reports the pause
{
  const before = JSON.stringify(stateOf(R.runDir).nodes);
  assert.equal(await captureExit(() => resumeRun({ runId: R.runId, homeDir: R.home, config, approve: true, executorFactory: factory() })), 1);
  assert.equal(await captureExit(() => resumeRun({ runId: R.runId, homeDir: R.home, config, rejectComment: "x", executorFactory: factory() })), 1);
  assert.equal(await captureExit(() => resumeRun({ runId: R.runId, homeDir: R.home, config, executorFactory: factory() })), 0);
  assert.equal(JSON.stringify(stateOf(R.runDir).nodes), before, "nothing may change");
  say("3 passed: bare --approve/--reject refused; plain resume re-reports the pause (restart preserves the pending gate, changes nothing)");
}

// 4. understanding-only: propose never mutates; wrong confirm never advances
{
  const b = briefOf(R.runDir, "reproduce");
  const before = JSON.stringify(stateOf(R.runDir));
  const id = await propose(R, b, {});
  assert.equal(JSON.stringify(stateOf(R.runDir)), before, "a proposal must not change state");
  assert.equal(await decide(R, b, { confirm: "0000000000000000" }), 1, "wrong confirm id refused");
  assert.equal(stateOf(R.runDir).nodes["reproduce"]?.status, "awaiting-gate");
  assert.equal(await decide(R, b, { confirm: id, session: "some-other-session" }), 1, "a different session cannot decide");
  assert.equal(stateOf(R.runDir).nodes["reproduce"]?.status, "awaiting-gate");
  say("4 passed: proposal is read-only; wrong confirm / foreign session cannot advance");
}

// 5. wrong-run and stale
{
  const b = briefOf(R.runDir, "reproduce");
  const other = await newRun();
  const ob = briefOf(other.runDir, "reproduce");
  assert.equal(await decide(R, { ...b, revision: ob.revision } as GateBrief, {}), 1, "revision from another run refused");
  assert.equal(await decide(R, { ...b, revision: b.revision.slice(0, -1) + (b.revision.endsWith("0") ? "1" : "0") } as GateBrief, {}), 1, "stale revision refused");
  assert.equal(await decide(R, { ...b, gateNodeId: "fix" } as GateBrief, {}), 1, "gate that is not awaiting refused");
  assert.equal(stateOf(R.runDir).nodes["reproduce"]?.status, "awaiting-gate");
  say("5 passed: wrong-run, stale-revision and wrong-gate decisions refused, state untouched");
}

// 6. approve reproduce → runs to fix gate; duplicate replay is a no-op
{
  const b = briefOf(R.runDir, "reproduce");
  const id = await propose(R, b, {});
  assert.equal(await decide(R, b, { confirm: id }), 0);
  let s = stateOf(R.runDir);
  assert.equal(s.nodes["reproduce"]?.status, "done");
  assert.equal(s.nodes["fix"]?.status, "awaiting-gate");
  const h = s.nodes["reproduce"]!.gateHistory.at(-1)!;
  assert.equal(h.decisionId, id);
  assert.equal(h.revision, b.revision);
  assert.match(h.resumePoint ?? "", /implement/);
  const snap = JSON.stringify(s.nodes);
  assert.equal(await decide(R, b, { confirm: id }), 0, "duplicate is a benign no-op");
  assert.equal(JSON.stringify(stateOf(R.runDir).nodes), snap, "duplicate approval advanced nothing");
  say("6 passed: bound approval advances exactly once; replay is a no-op; decision + exact resume point persisted");
}

// 7. fix gate: explicit verify decision required; skip verify → pr gate
{
  const b = briefOf(R.runDir, "fix");
  assert.equal(b.pendingDecision.decidesNode, "verify");
  assert.deepEqual(b.pendingDecision.amendTargets, ["fix"]);
  assert.equal(await decide(R, b, {}), 1, "approve without --run-next refused");
  assert.equal(stateOf(R.runDir).nodes["fix"]?.status, "awaiting-gate");
  const id = await propose(R, b, { runNext: false });
  assert.equal(await decide(R, b, { runNext: false, confirm: id }), 0);
  const s = stateOf(R.runDir);
  const d = JSON.parse(readFileSync(join(R.runDir, "fix", "next-node-decision.json"), "utf8")) as { run: boolean; decisionId: string };
  assert.equal(d.run, false);
  assert.equal(d.decisionId, id);
  assert.equal(s.nodes["verify"]?.status, "skipped", "verify skipped by decision");
  assert.equal(s.nodes["pr"]?.status, "awaiting-gate", "pre-PR gate reached; a skipped verify must not block pr");
  assert.equal(s.status, "paused");
  say("7 passed: fix gate demands an explicit run/skip verify choice; skip → verify skipped → pause at pre-PR gate");
}

// 8. pre-PR amend: revise fix, invalidate verify/pr/digest, no publication
{
  const b = briefOf(R.runDir, "pr");
  assert.deepEqual(b.pendingDecision.amendTargets, ["pr", "fix"]);
  assert.equal(b.pendingDecision.decidesNode, undefined);
  assert.equal(await decide(R, b, { action: "amend", target: "reproduce", comment: "redo" }), 1, "undeclared target refused");
  const fixIterBefore = stateOf(R.runDir).nodes["fix"]!.iteration; // mock pauses report iteration 1; real runs report 0
  const o = { action: "amend", target: "fix", comment: "handle the null case too" };
  const id = await propose(R, b, o);
  assert.equal(await decide(R, b, { ...o, confirm: id }), 0);
  const s = stateOf(R.runDir);
  assert.equal(s.nodes["fix"]?.status, "awaiting-gate", "fix revised and paused again");
  assert.equal(readFileSync(join(R.runDir, "fix", `feedback-${fixIterBefore + 1}.md`), "utf8"), "handle the null case too");
  for (const n of ["verify", "pr", "digest"]) assert.notEqual(s.nodes[n]?.status, "done", `${n} must not keep stale results`);
  assert.equal(s.nodes["pr"]?.status, "pending");
  assert.ok(existsSync(join(R.runDir, "pr-attempts", "attempt-1")), "stale pr evidence archived, not reused");
  assert.equal(existsSync(join(R.runDir, "fix", "next-node-decision.json")), false, "old verify decision cleared");
  assert.ok(!existsSync(join(R.runDir, "pr", "pr-meta.json")) || !JSON.parse(readFileSync(join(R.runDir, "pr", "pr-meta.json"), "utf8")).prUrl, "no PR was published");
  const fixHist = s.nodes["fix"]!.gateHistory.at(-1)!;
  assert.deepEqual([...(fixHist.invalidated ?? [])].sort(), ["digest", "pr", "verify"]);
  // the old pr-gate revision is now stale
  assert.equal(await decide(R, b, { action: "approve" }), 1, "stale pr-gate approval refused after amend");
  say("8 passed: amend at pre-PR gate re-runs fix, invalidates + archives verify/pr/digest, clears the old verify decision, no publication");
}

// 9. approve fix again WITH verify → verify runs and passes its evidence contract → pr gate
{
  const b = briefOf(R.runDir, "fix");
  assert.notEqual(b.revision, "", "fix has a fresh revision");
  const id = await propose(R, b, { runNext: true });
  assert.equal(await decide(R, b, { runNext: true, confirm: id }), 0);
  const s = stateOf(R.runDir);
  assert.equal(s.nodes["verify"]?.status, "done");
  const rep = JSON.parse(readFileSync(join(R.runDir, "verify", "verify-report.json"), "utf8")) as { outcome: string; candidate: { builtFromWorktree: boolean } };
  assert.equal(rep.outcome, "DEMONSTRATED");
  assert.equal(s.nodes["pr"]?.status, "awaiting-gate");
  say("9 passed: verify runs when chosen; DEMONSTRATED report passes the evidence contract; pre-PR gate reached");
}

// 10. pre-PR approve → run done; replay is a no-op
{
  const b = briefOf(R.runDir, "pr");
  const id = await propose(R, b, {});
  assert.equal(await decide(R, b, { confirm: id }), 0);
  assert.equal(stateOf(R.runDir).status, "done");
  assert.equal(stateOf(R.runDir).nodes["pr"]?.status, "done");
  assert.equal(await decide(R, b, { confirm: id }), 0);
  say("10 passed: pre-PR approval completes the run exactly once");
}

// ===========================================================================
// 11. Missing / unavailable session → blocked, recovery, no silent replacement
// ===========================================================================
{
  const X = await newRun();
  transcript(SESSION, false); // original conversation vanishes
  const brief = briefOf(X.runDir, "reproduce");
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  gateShow({ homeDir: X.home, config, runId: X.runId });
  process.stdout.write = real;
  const shown = JSON.parse(out.join("")) as GateBrief;
  assert.equal(shown.companion.status, "blocked");
  assert.match(shown.companion.blockedReason ?? "", /--reconstructed/);
  assert.equal(await decide(X, brief, {}), 1, "cannot decide while the original session is unavailable");
  assert.equal(stateOf(X.runDir).nodes["reproduce"]?.status, "awaiting-gate");
  // recovery: attach a RECONSTRUCTED session (explicit, recorded), then decide
  transcript(SESSION_2);
  assert.equal(await quiet(async () => gateAttach({ homeDir: X.home, config, runId: X.runId, session: "no-such-session-zzzz", reconstructed: true, replace: true })), 1, "unreachable session cannot be attached");
  assert.equal(await quiet(async () => gateAttach({ homeDir: X.home, config, runId: X.runId, session: SESSION_2, reconstructed: true, replace: false })), 0);
  const s = stateOf(X.runDir);
  assert.equal(s.companion?.reconstructed, true);
  assert.equal(s.companion?.source, "attach");
  transcript(SESSION); // restore for later
  say("11 passed: unavailable original session → blocked with recovery options; reconstructed fallback is explicit, flagged, and only via attach");
}

// ===========================================================================
// 11b. Adopting an existing (legacy, companion-less) run: stale "running" status is fine
//      while a gate is awaiting; --reseed refreshes the worktree's command prompts
// ===========================================================================
{
  const L = await newRun({}, null); // legacy: --no-companion
  assert.equal(stateOf(L.runDir).companion, undefined);
  const st = stateOf(L.runDir);
  writeFileSync(join(L.runDir, "state.json"), JSON.stringify({ ...st, status: "running" })); // simulate crash-stale status
  const stale = join(st.worktreePath, ".claude", "commands", "verify.md");
  writeFileSync(stale, "OLD PROMPT");
  transcript(SESSION);
  assert.equal(await quiet(async () => gateAttach({ homeDir: L.home, config, runId: L.runId, session: SESSION, reconstructed: false, replace: false, reseed: true })), 0);
  assert.notEqual(readFileSync(stale, "utf8"), "OLD PROMPT", "--reseed refreshes the worktree's verify prompt");
  assert.equal(stateOf(L.runDir).companion?.sessionId, SESSION);
  // and a run NOT waiting at a gate cannot be attached
  const done = stateOf(R.runDir);
  assert.equal(done.status, "done");
  assert.equal(await quiet(async () => gateAttach({ homeDir: R.home, config, runId: R.runId, session: SESSION, reconstructed: false, replace: true })), 1);
  say("11b passed: legacy/stale-status run adopts a companion + refreshed prompts; a finished run cannot");
}

// ===========================================================================
// 12. Verify's evidence contract: no false pass
// ===========================================================================
{
  // (a) a non-passing verify outcome halts the run and blocks pr
  const V = await newRun({ verify: "outcome-gate-fail" });
  const b = briefOf(V.runDir, "reproduce");
  await decide(V, b, { confirm: await propose(V, b, {}) });
  const fb = briefOf(V.runDir, "fix");
  const id = await propose(V, fb, { runNext: true });
  await captureExit(() => decide(V, fb, { runNext: true, confirm: id }, { verify: "outcome-gate-fail" }) as Promise<unknown>);
  const s = stateOf(V.runDir);
  assert.equal(s.nodes["verify"]?.status, "failed", "non-DEMONSTRATED outcome fails verify");
  assert.notEqual(s.nodes["pr"]?.status, "done", "pr must not run behind a failed verify");
  assert.equal(s.status, "failed");
  say("12a passed: a failed verify halts the run and blocks pr (no false pass)");
}
{
  // (b) a DEMONSTRATED claim backed by a stock image (not built from the worktree) is rejected
  const V = await newRun();
  const b = briefOf(V.runDir, "reproduce");
  await decide(V, b, { confirm: await propose(V, b, {}) });
  const fb = briefOf(V.runDir, "fix");
  const id = await propose(V, fb, { runNext: true });
  const base = createMockExecutor({ reproduce: "gate-pause", implement: "success", review: "success", fix: "gate-pause", verify: "success", pr: "gate-pause", digest: "success" } as never);
  const lying = (() => async (nodeId: string, node: never, ctx: { artifactsDir: string }) => {
    const r = await (base as never as (a: string, b: never, c: unknown) => Promise<unknown>)(nodeId, node, ctx);
    if (nodeId === "verify") {
      const p = join(ctx.artifactsDir, "verify-report.json");
      const rep = JSON.parse(readFileSync(p, "utf8"));
      rep.candidate.builtFromWorktree = false; // stock release image
      writeFileSync(p, JSON.stringify(rep));
    }
    return r;
  }) as never;
  await captureExit(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "fix", revision: fb.revision, action: "approve", runNext: true, confirm: id, executorFactory: lying } as never));
  const s = stateOf(V.runDir);
  assert.equal(s.nodes["verify"]?.status, "failed");
  assert.match(s.nodes["verify"]?.error ?? "", /builtFromWorktree/);
  say("12b passed: a DEMONSTRATED claim on a stock (unbuilt) artifact fails the node");
}

console.log("smoke-gates: ALL PASSED");
