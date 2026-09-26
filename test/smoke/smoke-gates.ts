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
import { execSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatusJson } from "../../src/cli/status-json.js";
import { readEvents } from "../../src/core/events.js";
import { startRun, resumeRun } from "../../src/runtime/run-engine.js";
import { gateAttach, gateDecide, gateOpen, gateShow, resumeOpensCompanion } from "../../src/runtime/gate-cli.js";
import { createMockExecutor } from "../../src/runtime/mock-executor.js";
import { fakeDocker } from "../../src/core/verify-cleanup-testkit.js";
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
  if (present) writeFileSync(f, `{"type":"user","cwd":"${CFG}","sessionId":"${id}"}\n`);
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
// The mock executor writes nothing into the worktree; a real fix does. Model that (an UNTRACKED
// file, which is what changes.diff must render as a new-file diff) around the mock, per fix run.
const factory = (over: Record<string, string> = {}) => () => {
  const inner = createMockExecutor({ reproduce: "gate-pause", implement: "success", review: "success", fix: "gate-pause", verify: "success", pr: "gate-pause", digest: "success", ...over } as never);
  const wrapped: typeof inner = async (id, node, ctx) => {
    if (id === "fix") writeFileSync(join(ctx.worktreePath, "mock-fix-change.txt"), "mock fix change\n");
    return inner(id, node, ctx);
  };
  return wrapped;
};

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
  assert.equal(b.companion.resume?.cwd, CFG);
  assert.match(b.companion.resumeHint ?? "", /^cd '.+' && CLAUDE_CONFIG_DIR='.*' claude --resume 1111.* 'DagRunner run .* gate show /s);
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

// 2b. `resume` with no flags opens the ORIGINAL conversation (fake spawn), only when interactive
{
  const calls: { args: string[]; cwd?: string; cfg?: string }[] = [];
  const spawn = ((cmd: string, a: string[], o: { cwd?: string; env?: Record<string, string> }) => {
    assert.equal(cmd, "claude");
    calls.push({ args: a, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(o.env?.["CLAUDE_CONFIG_DIR"] !== undefined ? { cfg: o.env["CLAUDE_CONFIG_DIR"] } : {}) });
    return { status: 0 };
  }) as never;
  const base = { homeDir: R.home, config, runId: R.runId, spawn };
  assert.equal(resumeOpensCompanion({ ...base, interactive: false }), null, "non-interactive falls through to the plain pause report");
  assert.equal(calls.length, 0);
  assert.equal(await quiet(async () => resumeOpensCompanion({ ...base, interactive: true })), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args.slice(0, 2), ["--resume", SESSION]);
  assert.match(calls[0]!.args[2] ?? "", /gate show/);
  assert.equal(calls[0]!.cwd, CFG, "resumed from the session's original directory");
  assert.equal(calls[0]!.cfg, CFG);
  void gateOpen;
  say("2b passed: bare resume on a companion run opens the recorded conversation with the gate prompt (interactive only)");
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
  // engine-written saved diff, on disk at the gate and visible in the brief / status --json before registration
  const diffPath = join(R.runDir, "fix", "changes.diff");
  const diffTxt = readFileSync(diffPath, "utf8");
  assert.ok(diffTxt.length > 0, "changes.diff is non-empty");
  assert.match(diffTxt, /mock-fix-change\.txt/, "changes.diff includes the untracked file");
  assert.match(diffTxt, /\+mock fix change/);
  const listed = b.gateArtifacts.find((f) => f.path === diffPath);
  assert.equal(listed?.registered, false, "gate brief lists changes.diff before it is registered");
  assert.ok((listed?.size ?? 0) > 0 && typeof listed?.mtime === "string");
  const sj = buildStatusJson(R.home, R.runId).nodes["fix"]!.artifacts.find((f) => f.path === diffPath);
  assert.equal(sj?.registered, false, "status --json lists the unregistered changes.diff");
  const opened = readEvents(R.runDir).filter((e) => e.type === "gate.opened" && e.node === "fix" && e.detail?.["revision"] === b.revision);
  assert.equal(b.openedAt, opened[0]?.ts, "brief.openedAt is the gate.opened event ts");
  assert.equal(buildStatusJson(R.home, R.runId).awaitingGate?.since, opened.at(-1)?.ts, "status --json awaitingGate.since is the gate.opened ts");
  assert.equal(await decide(R, b, {}), 1, "approve without --run-next refused");
  assert.equal(stateOf(R.runDir).nodes["fix"]?.status, "awaiting-gate");
  const id = await propose(R, b, { runNext: false });
  assert.equal(await decide(R, b, { runNext: false, confirm: id }), 0);
  const s = stateOf(R.runDir);
  const d = JSON.parse(readFileSync(join(R.runDir, "fix", "next-node-decision.json"), "utf8")) as { run: boolean; decisionId: string };
  assert.equal(d.run, false);
  assert.equal(d.decisionId, id);
  assert.equal(s.nodes["verify"]?.status, "skipped", "verify skipped by decision");
  assert.ok(s.nodes["fix"]!.artifacts.includes(diffPath), "changes.diff registered as a fix artifact on approve");
  assert.ok(readFileSync(join(R.runDir, "pr", "changes.diff"), "utf8").includes("mock-fix-change.txt"), "pr gate open refreshes/copies changes.diff");
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
  assert.equal(rep.outcome, "PROVISIONED");
  assert.equal(s.nodes["pr"]?.status, "awaiting-gate");
  say("9 passed: verify runs when chosen; PROVISIONED report passes the evidence contract; pre-PR gate reached");
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
  assert.equal(s.nodes["verify"]?.status, "failed", "non-PROVISIONED outcome fails verify");
  assert.notEqual(s.nodes["pr"]?.status, "done", "pr must not run behind a failed verify");
  assert.equal(s.status, "failed");
  say("12a passed: a failed verify halts the run and blocks pr (no false pass)");
}
{
  // (b) a PROVISIONED claim backed by a stock image (not built from the worktree) is rejected
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
  say("12b passed: a PROVISIONED claim on a stock (unbuilt) artifact fails the node");
}

// ===========================================================================
// 13. Verify hand-off: the human's verdict at the pre-PR gate tears the environment down
// ===========================================================================
/** Executor whose verify PROVISIONS (docker-shaped report) instead of the mock's source-only report. */
function provisioning(runId: string) {
  return () => {
    const base = createMockExecutor({ reproduce: "gate-pause", implement: "success", review: "success", fix: "gate-pause", verify: "success", pr: "gate-pause", digest: "success" } as never);
    return (async (nodeId: string, node: never, ctx: { artifactsDir: string }) => {
      const r = await (base as never as (a: string, b: never, c: unknown) => Promise<unknown>)(nodeId, node, ctx);
      if (nodeId === "verify") {
        const p = join(ctx.artifactsDir, "verify-report.json");
        const rep = JSON.parse(readFileSync(p, "utf8"));
        rep.capability = "docker-compose";
        delete rep.sourceRationale;
        rep.run_id = runId;
        rep.target = { kind: "local-disposable", host: "127.0.0.1", port: 18080, ownedResources: [
          { kind: "container", name: `dagrun-${runId}-app` }, { kind: "network", name: `dagrun-${runId}-net` }, { kind: "image", name: `dagrun-${runId}-app:latest` } ] };
        rep.readiness = { command: "curl -s localhost:18080/health", result: "UP" };
        rep.teardown = { status: "pending" };
        writeFileSync(p, JSON.stringify(rep));
      }
      return r;
    }) as never;
  };
}
const tdFile = (V: { runDir: string }, dir = "verify") => JSON.parse(readFileSync(join(V.runDir, dir, "teardown.json"), "utf8")) as { status: string; trigger: string; leftovers: string[] };
async function toPrGate(over: { runNext: boolean } = { runNext: true }) {
  const V = await newRun();
  const f = provisioning(V.runId);
  const dd = (b: GateBrief, o: Record<string, unknown>) => quiet(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: b.gateNodeId, revision: b.revision, action: "approve", ...o, executorFactory: f } as never));
  const b1 = briefOf(V.runDir, "reproduce");
  await dd(b1, { confirm: await propose(V, b1, {}) });
  const b2 = briefOf(V.runDir, "fix");
  await dd(b2, { runNext: over.runNext, confirm: await propose(V, b2, { runNext: over.runNext }) });
  return { V, f, dd };
}
{
  // (a) approve: brief shows the running env; statement warns; decision tears it down exactly once
  const { V, f } = await toPrGate();
  assert.equal(stateOf(V.runDir).nodes["pr"]?.status, "awaiting-gate");
  const b = briefOf(V.runDir, "pr");
  assert.equal(b.verifyEnvironment?.status, "provisioned");
  assert.equal(b.verifyEnvironment?.port, 18080);
  assert.match(b.verifyEnvironment?.note ?? "", /manual testing pending/);
  let out = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((x: string) => { out += x; return true; }) as typeof process.stdout.write;
  try { await gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "pr", revision: b.revision, action: "approve" } as never); } finally { process.stdout.write = real; }
  assert.match(out, /TEARS DOWN the verify environment/);
  const d = fakeDocker({ container: [`dagrun-${V.runId}-app`, "other"], network: [`dagrun-${V.runId}-net`], image: [`dagrun-${V.runId}-app:latest`] });
  const id = /--confirm ([0-9a-f]{16})/.exec(out)![1]!;
  assert.equal(await quiet(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "pr", revision: b.revision, action: "approve", confirm: id, executorFactory: f, dockerExec: d.exec } as never)), 0);
  assert.equal(stateOf(V.runDir).nodes["pr"]?.gateHistory.at(-1)?.decision, "approve");
  assert.equal(tdFile(V).status, "clean");
  assert.equal(tdFile(V).trigger, "gate-decide:pr:approve");
  assert.deepEqual([...d.live.container], ["other"]);
  const callsAfter = d.calls.length;
  await quiet(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "pr", revision: b.revision, action: "approve", confirm: id, executorFactory: f, dockerExec: d.exec } as never));
  assert.equal(d.calls.length, callsAfter, "replayed decision does not tear down again");
  say("13a passed: brief shows the running env + warns; approve records the decision and tears the env down once (only owned resources)");
}
{
  // (b) hold: decision recorded, run stays paused, env torn down; no second teardown on the next decide
  const { V, f } = await toPrGate();
  const b = briefOf(V.runDir, "pr");
  const d = fakeDocker({ container: [`dagrun-${V.runId}-app`], network: [`dagrun-${V.runId}-net`], image: [`dagrun-${V.runId}-app:latest`] });
  const o = { action: "hold", comment: "need another day" };
  const id = await propose(V, b, o);
  await captureExit(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "pr", revision: b.revision, ...o, confirm: id, executorFactory: f, dockerExec: d.exec } as never));
  const s = stateOf(V.runDir);
  assert.equal(s.nodes["pr"]?.status, "awaiting-gate");
  assert.equal(s.nodes["pr"]?.gateHistory.at(-1)?.decision, "hold");
  assert.equal(tdFile(V).status, "clean");
  assert.equal(tdFile(V).trigger, "gate-decide:pr:hold");
  assert.equal(d.live.container.size + d.live.network.size + d.live.image.size, 0);
  say("13b passed: hold at the pre-PR gate is recorded, stays paused, and tears the env down");
}
{
  // (c) amend → fix: teardown completes BEFORE verify is archived/re-provisioned
  const { V, f } = await toPrGate();
  const b = briefOf(V.runDir, "pr");
  const d = fakeDocker({ container: [`dagrun-${V.runId}-app`], network: [`dagrun-${V.runId}-net`], image: [`dagrun-${V.runId}-app:latest`] });
  const o = { action: "amend", target: "fix", comment: "change it" };
  const id = await propose(V, b, o);
  await quiet(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "pr", revision: b.revision, ...o, confirm: id, executorFactory: f, dockerExec: d.exec } as never));
  assert.equal(stateOf(V.runDir).nodes["fix"]?.status, "awaiting-gate");
  assert.equal(d.live.container.size + d.live.network.size + d.live.image.size, 0, "env gone before fix/verify re-run");
  const att = join(V.runDir, "verify-attempts", "attempt-1");
  assert.equal(JSON.parse(readFileSync(join(att, "teardown.json"), "utf8")).status, "clean");
  assert.equal(JSON.parse(readFileSync(join(att, "teardown.json"), "utf8")).worktree.status, "match");
  say("13c passed: amend tears the env down before verify's dir is archived / re-provisioned");
}
{
  // (d) teardown failure is loud but never loses the decision; amend halts instead of re-provisioning
  const { V, f } = await toPrGate();
  const b = briefOf(V.runDir, "pr");
  const stuck = fakeDocker({ container: [`dagrun-${V.runId}-app`] }, { stubborn: [`dagrun-${V.runId}-app`] });
  const o = { action: "amend", target: "fix", comment: "again" };
  const id = await propose(V, b, o);
  const code = await captureExit(() => gateDecide({ homeDir: V.home, config, runId: V.runId, gate: "pr", revision: b.revision, ...o, confirm: id, executorFactory: f, dockerExec: stuck.exec } as never));
  assert.equal(code, 1, "amend with leftovers stops loudly");
  const s = stateOf(V.runDir);
  assert.equal(s.nodes["fix"]?.gateHistory.at(-1)?.action, "amend", "decision is recorded despite the failed teardown");
  assert.equal(s.nodes["fix"]?.status, "pending", "run did not continue into a colliding re-provision");
  assert.equal(tdFile(V, "verify-attempts/attempt-1").status, "leftovers");
  // approve variant: decision stands, run continues, leftovers stay retryable
  const P = await toPrGate();
  const pb = briefOf(P.V.runDir, "pr");
  const stuck2 = fakeDocker({ container: [`dagrun-${P.V.runId}-app`] }, { stubborn: [`dagrun-${P.V.runId}-app`] });
  const pid = await propose(P.V, pb, {});
  assert.equal(await quiet(() => gateDecide({ homeDir: P.V.home, config, runId: P.V.runId, gate: "pr", revision: pb.revision, action: "approve", confirm: pid, executorFactory: P.f, dockerExec: stuck2.exec } as never)), 0);
  assert.equal(stateOf(P.V.runDir).nodes["pr"]?.gateHistory.at(-1)?.decision, "approve");
  assert.equal(tdFile(P.V).status, "leftovers");
  say("13d passed: a failed teardown never loses the decision; leftovers stay pending for `dagrun verify cleanup`");
}
{
  // (e) verify skipped, or source-only (mock default): the docker seam is never touched
  const S = await toPrGate({ runNext: false });
  const sb = briefOf(S.V.runDir, "pr");
  assert.equal(sb.verifyEnvironment, undefined);
  const never = fakeDocker({});
  const sid = await propose(S.V, sb, {});
  await quiet(() => gateDecide({ homeDir: S.V.home, config, runId: S.V.runId, gate: "pr", revision: sb.revision, action: "approve", confirm: sid, executorFactory: S.f, dockerExec: never.exec } as never));
  assert.equal(never.calls.length, 0, "skipped verify: no docker calls");
  const Q = await newRun();
  const qb = briefOf(Q.runDir, "reproduce");
  await decide(Q, qb, { confirm: await propose(Q, qb, {}) });
  const fb = briefOf(Q.runDir, "fix");
  await decide(Q, fb, { runNext: true, confirm: await propose(Q, fb, { runNext: true }) });
  const pb = briefOf(Q.runDir, "pr");
  assert.equal(pb.verifyEnvironment, undefined, "source-only report provisions nothing");
  const never2 = fakeDocker({});
  const qid = await propose(Q, pb, {});
  await quiet(() => gateDecide({ homeDir: Q.home, config, runId: Q.runId, gate: "pr", revision: pb.revision, action: "approve", confirm: qid, executorFactory: factory(), dockerExec: never2.exec } as never));
  assert.equal(never2.calls.length, 0, "source-only verify: no docker calls");
  say("13e passed: no teardown when verify was skipped or source-only");
}

// ===========================================================================
// 14. Agent-driven driving: `--detach` + `status --json` through the REAL CLI
//     (mock executor via DAGRUN_MOCK_SCENARIOS; no API call, no SDK).
// ===========================================================================
{
  const { home, plan } = newHome();
  for (const d of ["inbox", "store"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ DEVHARNESS_SRC: TOY_REPO }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DAGRUNNER_HOME: home,
    CLAUDE_CONFIG_DIR: CFG,
    ANTHROPIC_API_KEY: "smoke-dummy",
    DAGRUN_MOCK_SCENARIOS: JSON.stringify({ reproduce: "gate-pause", implement: "success", review: "success", fix: "gate-pause", verify: "success", pr: "gate-pause", digest: "success" }),
  };
  delete env["CLAUDE_CODE_SESSION_ID"];
  const CLI = join(__dirname, "..", "..", "src", "cli", "cli.ts");
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { env, encoding: "utf8", cwd: join(__dirname, "..", "..") });
  type SJ = { status: string; stale: boolean; currentNodes: string[]; awaitingGate: { nodeId: string; revision: string | null; since: string | null; reason: string } | null; nodes: Record<string, { status: string; attempts: { status: string; durationMs: number }[]; durationMs: number | null }>; companion: { sessionId: string } | null; lastEventAt: string | null; driver: { pid: number } | null };
  const statusJson = (runId: string): SJ => {
    const r = cli(["status", runId, "--json"]);
    assert.equal(r.status, 0, `status --json failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as SJ;
  };
  const waitFor = async (runId: string, want: (s: SJ) => boolean, what: string): Promise<SJ> => {
    let last = "";
    for (let i = 0; i < 400; i++) {
      const r = cli(["status", runId, "--json"]);
      if (r.status === 0) {
        const j = JSON.parse(r.stdout) as SJ;
        last = `${j.status} nodes=${j.currentNodes.join(",")}`;
        if (want(j)) return j;
      } else last = r.stderr.trim();
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`timed out waiting for ${what}; last: ${last}`);
  };
  const detachedOut = (out: string): { runId: string; pid: number; log: string } => {
    const m = /detached — run (\S+)\s+pid (\d+)\s+log (\S+)/.exec(out);
    assert.ok(m, `expected detach announcement, got: ${out}`);
    return { runId: m[1] as string, pid: Number(m[2]), log: m[3] as string };
  };

  // start --detach: returns at once (exit 0) with run id, pid, log path; nothing but the child drives.
  const t0 = Date.now();
  const st = cli(["start", "bugfix", "--plan", plan, "--companion-session", SESSION, "--detach"]);
  assert.equal(st.status, 0, `start --detach failed: ${st.stdout}${st.stderr}`);
  const d = detachedOut(st.stdout);
  assert.ok(d.log.endsWith(join("runs", d.runId, "driver.log")));
  const runDir = join(home, "runs", d.runId);
  const paused = await waitFor(d.runId, (j) => j.status === "awaiting-gate", "awaiting-gate at reproduce");
  assert.equal(paused.awaitingGate?.nodeId, "reproduce");
  assert.equal(paused.awaitingGate?.revision, briefOf(runDir, "reproduce").revision, "status reports the gate revision");
  assert.equal(paused.stale, false);
  assert.deepEqual(paused.currentNodes, []);
  assert.equal(paused.companion?.sessionId, SESSION);
  assert.equal(paused.nodes["reproduce"]?.attempts.length, 1, "per-iteration timing recorded");
  assert.ok(paused.lastEventAt !== null);
  assert.ok(readFileSync(d.log, "utf8").includes("PAUSED at gate"), "driver output went to driver.log");
  say(`14a passed: start --detach returned in ${Date.now() - t0}ms; status --json reports awaiting-gate/revision/companion/attempts`);

  // Confirmed decide --detach. First prove a LIVE driver blocks it (state untouched), then a STALE lock does not.
  const rb = briefOf(runDir, "reproduce");
  const decideArgs = (b: GateBrief, extra: string[] = []) => ["gate", "decide", d.runId, "--gate", b.gateNodeId, "--revision", b.revision, "--action", "approve", "--session", SESSION, ...extra];
  const proposal = cli(decideArgs(rb));
  assert.equal(proposal.status, 0, proposal.stderr);
  const cid = /--confirm ([0-9a-f]{16})/.exec(proposal.stdout)?.[1] as string;
  assert.ok(cid);
  assert.notEqual(cli([...decideArgs(rb), "--detach"]).status, 0, "--detach without --confirm is refused");

  const sleeper = spawnChild(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  try {
    const stateBefore = readFileSync(join(runDir, "state.json"), "utf8");
    writeFileSync(join(home, "active.lock"), JSON.stringify({ runId: d.runId, pid: sleeper.pid, startedAt: new Date().toISOString() }));
    const refused = cli([...decideArgs(rb, ["--confirm", cid]), "--detach"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already being driven by pid \d+/);
    assert.equal(readFileSync(join(runDir, "state.json"), "utf8"), stateBefore, "refused second driver must not touch state");
    assert.equal(statusJson(d.runId).driver?.pid, sleeper.pid, "status reports the live lock holder");
  } finally {
    sleeper.kill();
  }
  // Stale lock: a dead pid (an exited child) is recovered by the next driver, exactly as before.
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
  writeFileSync(join(home, "active.lock"), JSON.stringify({ runId: d.runId, pid: deadPid, startedAt: new Date().toISOString() }));
  assert.equal(statusJson(d.runId).driver, null, "a dead pid is not a live driver");
  const dec1 = cli([...decideArgs(rb, ["--confirm", cid]), "--detach"]);
  assert.equal(dec1.status, 0, `decide --detach failed: ${dec1.stdout}${dec1.stderr}`);
  assert.equal(detachedOut(dec1.stdout).runId, d.runId);
  const atFix = await waitFor(d.runId, (j) => j.status === "awaiting-gate" && j.awaitingGate?.nodeId === "fix", "awaiting-gate at fix");
  assert.equal(atFix.stale, false);
  assert.equal(atFix.nodes["reproduce"]?.status, "done");
  say("14b passed: live lock refuses a second driver (state untouched, reported by status); stale lock recovered; decide --detach advanced to fix");

  // Drive the remaining gates detached and poll to done.
  const fb2 = briefOf(runDir, "fix");
  const fp = cli(decideArgs(fb2, ["--run-next", "yes"]));
  const fid = /--confirm ([0-9a-f]{16})/.exec(fp.stdout)?.[1] as string;
  assert.equal(cli([...decideArgs(fb2, ["--run-next", "yes", "--confirm", fid]), "--detach"]).status, 0);
  await waitFor(d.runId, (j) => j.status === "awaiting-gate" && j.awaitingGate?.nodeId === "pr", "awaiting-gate at pr");
  const pb2 = briefOf(runDir, "pr");
  const pp = cli(decideArgs(pb2));
  const pid2 = /--confirm ([0-9a-f]{16})/.exec(pp.stdout)?.[1] as string;
  assert.equal(cli([...decideArgs(pb2, ["--confirm", pid2]), "--detach"]).status, 0);
  const done = await waitFor(d.runId, (j) => j.status === "done", "done");
  assert.equal(done.stale, false);
  assert.equal(done.awaitingGate, null);
  assert.equal(done.driver, null, "lock released at the end");
  // Event log: derived, ordered, complete.
  const evs = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ts: string; type: string; node?: string; detail?: Record<string, unknown> });
  const kinds = new Set(evs.map((e) => e.type));
  for (const k of ["run.started", "node.started", "node.finished", "gate.opened", "gate.decision", "run.status"]) assert.ok(kinds.has(k), `events.jsonl missing ${k}`);
  assert.ok(evs.filter((e) => e.type === "gate.opened").every((e) => typeof e.detail?.["revision"] === "string"), "gate.opened carries the revision");
  assert.ok(evs.some((e) => e.type === "gate.decision" && e.node === "reproduce" && e.detail?.["action"] === "approve" && typeof e.detail?.["decisionId"] === "string"));
  assert.equal(evs.at(-1)?.type, "run.status");
  assert.ok(evs.every((e, i) => i === 0 || (evs[i - 1] as { ts: string }).ts <= e.ts), "events are time-ordered");
  say("14c passed: detached decides drove the run to done; status --json done/not stale; events.jsonl complete and ordered");
}

console.log("smoke-gates: ALL PASSED");
