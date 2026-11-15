/**
 * missing-worktree.test.ts — a run ADOPTS a worktree it did not create, so `wm rm`
 * (or `wm rm --gone/--all`) can delete it from under a live run. `resume`,
 * `rerun` and `gate attach --reseed` used to read `state.worktreePath` without
 * checking it still exists — and their seeding steps would silently RE-CREATE the
 * deleted path as a bare `.claude/` directory. They must now fail loud BEFORE any
 * side effect (DECISIONS.md § missing-worktree-fails-loud); read-only commands
 * (status, report, gate show) must keep working on such a run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RunState } from "../core/state.js";
import { decisionId } from "../core/gate.js";
import { buildStatusJson } from "../cli/status-json.js";
import { generateReport } from "../cli/report.js";
import { buildRunSnapshot } from "../ui/run-snapshot.js";
import { createMockExecutor } from "./mock-executor.js";
import { gateAttach, gateDecide, gateShow } from "./gate-cli.js";
import { rerunNode, resumeRun } from "./run-engine.js";
import { MissingWorktreeError, WorktreeAdoptionError, assertRunWorktreeExists } from "./worktree.js";

const node = (status: string, extra: Record<string, unknown> = {}) =>
  ({ status, artifacts: [], iteration: 0, cost: 0, gateHistory: [], ...extra }) as RunState["nodes"][string];

const SESSION = "44444444-aaaa-bbbb-cccc-000000000004";

type Fx = { home: string; runDir: string; wt: string; cfg: string; stateFile: string };

/** A bugfix run paused at the fix gate; `present` decides whether its worktree exists. */
function fixture(opts: { present: boolean; origin?: "adopted" | undefined; status?: RunState["status"] } = { present: false }): Fx {
  const home = mkdtempSync(join(tmpdir(), "dr-missing-wt-"));
  const runDir = join(home, "runs", "m-1");
  mkdirSync(join(runDir, "fix"), { recursive: true });
  mkdirSync(join(runDir, "implement"), { recursive: true });
  writeFileSync(join(runDir, "fix", "summary.md"), "# fix\n");
  writeFileSync(join(runDir, "implement", "summary.md"), "# impl\n");
  // fake Claude config dir holding the companion's transcript (gate attach / decide)
  const cfg = mkdtempSync(join(tmpdir(), "dr-missing-wt-cfg-"));
  mkdirSync(join(cfg, "projects", "-p"), { recursive: true });
  writeFileSync(join(cfg, "projects", "-p", `${SESSION}.jsonl`), `{"type":"user","cwd":"${cfg}","sessionId":"${SESSION}"}\n`);
  const wt = join(home, "worktrees", "wt-m");
  if (opts.present) {
    mkdirSync(wt, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: wt });
  }
  const state: RunState = {
    runId: "m-1",
    workflow: "bugfix",
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:10:00.000Z",
    status: opts.status ?? "paused",
    worktreePath: wt,
    branch: "fix/m",
    ...(opts.origin !== undefined ? { worktreeOrigin: opts.origin } : {}),
    sourcePlanPath: "/p",
    companion: { sessionId: SESSION, configDir: cfg, associatedAt: "t", source: "handoff", reconstructed: false },
    nodes: {
      implement: node("done"),
      review: node("done"),
      fix: node("awaiting-gate", { iteration: 1 }),
      pr: node("pending"),
    },
  };
  const stateFile = join(runDir, "state.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return { home, runDir, wt, cfg, stateFile };
}

const bytes = (f: string): string => readFileSync(f, "utf8");

/**
 * Run `fn` with process.exit turned into a thrown error and stdout/stderr muted. resumeRun/rerunNode
 * call process.exit on some paths; un-intercepted, a missing guard would kill the test runner
 * mid-file and the run would LOOK green ("1 test, 1 pass"). Now it is a failed assertion.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  const realExit = process.exit;
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.exit = ((c?: number) => {
    throw new Error(`process.exit(${String(c)}) was called`);
  }) as typeof process.exit;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.exit = realExit;
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
const cfgOf = (fx: Fx) => ({ DEVHARNESS_SRC: fx.home });

// ---------------------------------------------------------------------------
// the shared check
// ---------------------------------------------------------------------------

test("assertRunWorktreeExists: a missing path throws a MissingWorktreeError naming the path, the run, the cause and exactly two recoveries", () => {
  const fx = fixture({ present: false });
  const run = { runId: "m-1", worktreePath: fx.wt, branch: "fix/m" };
  assert.throws(
    () => assertRunWorktreeExists(run, "/the/devharness/src"),
    (e: unknown) => {
      assert.ok(e instanceof MissingWorktreeError);
      assert.ok(e instanceof WorktreeAdoptionError, "the CLI's existing no-stack-trace catch must cover it");
      assert.ok(e.message.includes(fx.wt), "names the missing path");
      assert.ok(e.message.includes('"m-1"'), "names the run id");
      assert.match(e.message, /removed outside dagrunner/);
      assert.match(e.message, /wm rm/);
      assert.match(e.message, /cannot continue/);
      assert.match(e.message, /1\. recreate a worktree for the recorded branch "fix\/m" at that same path/);
      assert.ok(e.message.includes(`git -C "/the/devharness/src" worktree add "${fx.wt}" "fix/m"`), "an executable recreate command");
      assert.match(e.message, /worktree prune/);
      assert.match(e.message, /branch was deleted too \(`wm rm` deletes it unless run with -k\)/, "wm rm deletes the branch by default (workmux remove --help)");
      assert.ok(e.message.includes('git -C "/the/devharness/src" branch "fix/m" <commit>'));
      assert.match(e.message, /2\. give up on the run: dagrun abort m-1/);
      assert.doesNotMatch(e.message, /3\./, "exactly two options");
      return true;
    },
  );
  assert.equal(existsSync(fx.wt), false, "the check itself creates nothing");
});

test("assertRunWorktreeExists: an existing git worktree (linked `.git` file) or checkout (`.git` dir) passes; legacy runs (no worktreeOrigin) are checked the same", () => {
  const fx = fixture({ present: true });
  assert.doesNotThrow(() => assertRunWorktreeExists({ runId: "m-1", worktreePath: fx.wt, branch: "b" }));
  const linked = join(fx.home, "linked");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
  assert.doesNotThrow(() => assertRunWorktreeExists({ runId: "m-1", worktreePath: linked, branch: "b" }));
  // legacy (origin absent) + missing -> same refusal
  const legacy = fixture({ present: false, origin: undefined });
  assert.throws(() => assertRunWorktreeExists({ runId: "m-1", worktreePath: legacy.wt, branch: "b" }), MissingWorktreeError);
});

test("assertRunWorktreeExists: a directory that exists but is NOT a git worktree (e.g. a `.claude/` an earlier resume re-created) is refused too", () => {
  const fx = fixture({ present: false });
  mkdirSync(join(fx.wt, ".claude"), { recursive: true });
  assert.throws(
    () => assertRunWorktreeExists({ runId: "m-1", worktreePath: fx.wt, branch: "fix/m" }),
    (e: unknown) => {
      assert.ok(e instanceof MissingWorktreeError);
      assert.match(e.message, /not a git worktree/);
      assert.match(e.message, /remove the leftover directory first/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

test("resumeRun on a run whose worktree is gone throws BEFORE any side effect: state.json byte-identical, no lock taken, the path not re-created", async () => {
  const fx = fixture({ present: false });
  const before = bytes(fx.stateFile);
  await assert.rejects(
    () => guarded(() => resumeRun({ runId: "m-1", homeDir: fx.home, config: cfgOf(fx) })),
    (e: unknown) => e instanceof MissingWorktreeError && e.message.includes(fx.wt) && e.message.includes('"m-1"'),
  );
  assert.equal(bytes(fx.stateFile), before, "state must not be reconciled/rewritten");
  assert.equal(existsSync(join(fx.home, "active.lock")), false, "no lock was taken");
  assert.equal(existsSync(fx.wt), false, "the seeding step must not have re-created the deleted worktree");
});

test("resumeRun leaves a stale lock for ANOTHER run exactly as it was when the worktree is gone", async () => {
  const fx = fixture({ present: false });
  const lockPath = join(fx.home, "active.lock");
  const lock = JSON.stringify({ runId: "other-9", pid: 99999999, startedAt: "t" });
  writeFileSync(lockPath, lock);
  await assert.rejects(() => guarded(() => resumeRun({ runId: "m-1", homeDir: fx.home, config: cfgOf(fx) })), MissingWorktreeError);
  assert.equal(bytes(lockPath), lock, "lock file untouched (no release/acquire happened)");
});

test("resumeRun with the worktree present is unchanged: a finished run re-reports done and the sibling seed lands in the existing worktree", async () => {
  const fx = fixture({ present: true, status: "done" });
  const st = JSON.parse(bytes(fx.stateFile)) as RunState;
  for (const id of Object.keys(st.nodes)) st.nodes[id] = node("done");
  writeFileSync(fx.stateFile, JSON.stringify(st, null, 2));
  mkdirSync(join(fx.runDir, "pr"), { recursive: true });
  writeFileSync(join(fx.runDir, "pr", "body.md"), "b\n");
  writeFileSync(join(fx.runDir, "pr", "pr-meta.json"), JSON.stringify({ title: "t", prUrl: "https://example.invalid/pull/1" }));
  await guarded(() => resumeRun({ runId: "m-1", homeDir: fx.home, config: cfgOf(fx), executorFactory: () => createMockExecutor() }));
  assert.equal((JSON.parse(bytes(fx.stateFile)) as RunState).status, "done");
  assert.ok(existsSync(join(fx.wt, ".claude")), "the existing worktree was re-seeded as before");
});

// ---------------------------------------------------------------------------
// rerun
// ---------------------------------------------------------------------------

test("rerunNode on a run whose worktree is gone throws before archiving or wiping anything and without re-creating the path", async () => {
  const fx = fixture({ present: false });
  writeFileSync(join(fx.runDir, "fix", "transcript.log"), "the failed attempt\n");
  const before = bytes(fx.stateFile);
  await assert.rejects(
    () => guarded(() => rerunNode({ runId: "m-1", nodeId: "fix", homeDir: fx.home, config: cfgOf(fx), executorFactory: () => createMockExecutor() })),
    (e: unknown) => e instanceof MissingWorktreeError && e.message.includes(fx.wt),
  );
  assert.equal(bytes(fx.stateFile), before, "state untouched");
  assert.equal(existsSync(join(fx.runDir, "fix-attempts")), false, "nothing archived");
  assert.equal(bytes(join(fx.runDir, "fix", "transcript.log")), "the failed attempt\n", "artifacts not wiped");
  assert.equal(existsSync(fx.wt), false, "the re-seed must not have re-created the deleted worktree");
});

test("rerunNode with the worktree present is unchanged: the node re-executes, the prior attempt is archived", async () => {
  const fx = fixture({ present: true });
  writeFileSync(join(fx.runDir, "implement", "transcript.log"), "attempt 1\n");
  await guarded(() => rerunNode({ runId: "m-1", nodeId: "implement", homeDir: fx.home, config: cfgOf(fx), executorFactory: () => createMockExecutor() }));
  assert.ok(existsSync(join(fx.runDir, "implement-attempts", "attempt-1", "transcript.log")));
  assert.equal((JSON.parse(bytes(fx.stateFile)) as RunState).nodes["implement"]?.status, "done");
});

// ---------------------------------------------------------------------------
// gate attach --reseed (and confirmed decide, which would otherwise hand a doomed run to a detached child)
// ---------------------------------------------------------------------------

test("gateAttach --reseed on a run whose worktree is gone throws before the companion association is written or anything is seeded", () => {
  const fx = fixture({ present: false });
  const st = JSON.parse(bytes(fx.stateFile)) as RunState;
  delete (st as { companion?: unknown }).companion; // a legacy run being adopted
  writeFileSync(fx.stateFile, JSON.stringify(st, null, 2));
  const before = bytes(fx.stateFile);
  assert.throws(
    () => gateAttach({ homeDir: fx.home, config: cfgOf(fx), runId: "m-1", session: SESSION, reconstructed: false, replace: false, reseed: true, configDirs: [fx.cfg] }),
    (e: unknown) => e instanceof MissingWorktreeError && e.message.includes(fx.wt),
  );
  assert.equal(bytes(fx.stateFile), before, "no half-applied attach: state.json byte-identical");
  assert.equal(existsSync(fx.wt), false, "the reseed must not have re-created the deleted worktree");
});

test("gateAttach WITHOUT --reseed does not need the worktree and keeps working", () => {
  const fx = fixture({ present: false });
  const quiet = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let code: number;
  try {
    code = gateAttach({ homeDir: fx.home, config: cfgOf(fx), runId: "m-1", session: SESSION, reconstructed: false, replace: true, configDirs: [fx.cfg] });
  } finally {
    process.stdout.write = quiet;
  }
  assert.equal(code, 0);
  assert.equal((JSON.parse(bytes(fx.stateFile)) as RunState).companion?.source, "attach");
});

test("gateAttach --reseed with the worktree present is unchanged: the bundled commands are copied in", () => {
  const fx = fixture({ present: true });
  const quiet = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let code: number;
  try {
    code = gateAttach({ homeDir: fx.home, config: cfgOf(fx), runId: "m-1", session: SESSION, reconstructed: false, replace: true, reseed: true, configDirs: [fx.cfg] });
  } finally {
    process.stdout.write = quiet;
  }
  assert.equal(code, 0);
  assert.ok(existsSync(join(fx.wt, ".claude", "commands", "fix.md")));
});

test("gateDecide --confirm refuses BEFORE handing off to a detached child when the worktree is gone (the driver would otherwise poll a doomed run forever)", async () => {
  const fx = fixture({ present: false });
  // propose to learn the decision id, exactly as the driver does
  let out = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  let revision = "";
  try {
    const sj = buildStatusJson(fx.home, "m-1");
    assert.equal(sj.awaitingGate?.nodeId, "fix");
    // revision comes from the brief gate show prints
    const shown: string[] = [];
    process.stdout.write = ((s: string) => { shown.push(s); return true; }) as typeof process.stdout.write;
    assert.equal(gateShow({ homeDir: fx.home, config: cfgOf(fx), runId: "m-1", configDirs: [fx.cfg] }), 0);
    revision = (JSON.parse(shown.join("")) as { revision: string }).revision;
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    const base = { homeDir: fx.home, config: cfgOf(fx), runId: "m-1", gate: "fix", revision, action: "approve" as const, session: SESSION, configDirs: [fx.cfg] };
    assert.equal(await gateDecide(base), 0, "the proposal is read-only and still works");
    const id = decisionId({ runId: "m-1", gate: "fix", revision, action: "approve" });
    assert.match(out, new RegExp(`--confirm ${id}`));
    const before = bytes(fx.stateFile);
    let detached = false;
    await assert.rejects(
      () => guarded(() => gateDecide({ ...base, confirm: id, detach: () => { detached = true; return 0; } })),
      (e: unknown) => e instanceof MissingWorktreeError,
    );
    assert.equal(detached, false, "the detach callback was never invoked");
    assert.equal(bytes(fx.stateFile), before);
  } finally {
    process.stdout.write = real;
  }
});

// ---------------------------------------------------------------------------
// read-only commands keep working on such a run
// ---------------------------------------------------------------------------

test("read-only commands keep working with the worktree gone: status --json, report, UI snapshot, and gate show at the fix gate AND the pr gate (deliverables manifest present)", () => {
  const fx = fixture({ present: false });
  // status --json
  assert.equal(buildStatusJson(fx.home, "m-1").status, "awaiting-gate");
  // report + snapshot
  const st = JSON.parse(bytes(fx.stateFile)) as RunState;
  assert.doesNotThrow(() => generateReport(st, []));
  assert.doesNotThrow(() => JSON.stringify(buildRunSnapshot(fx.home, "m-1")));
  // gate show at the fix gate
  const quiet = process.stdout.write.bind(process.stdout);
  const shown: string[] = [];
  process.stdout.write = ((s: string) => { shown.push(s); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(gateShow({ homeDir: fx.home, config: cfgOf(fx), runId: "m-1", configDirs: [fx.cfg] }), 0);
    const fixBrief = JSON.parse(shown.join("")) as { gateNodeId: string; validation: unknown[] };
    assert.equal(fixBrief.gateNodeId, "fix");
    // ... and at the pr gate, where the deliverables advisory shells out to git in the missing worktree
    for (const d of ["implement", "fix"]) writeFileSync(join(fx.runDir, d, "deliverables.txt"), "src/A.java\n");
    mkdirSync(join(fx.runDir, "pr"), { recursive: true });
    writeFileSync(join(fx.runDir, "pr", "body.md"), "b\n");
    const st2 = JSON.parse(bytes(fx.stateFile)) as RunState;
    st2.nodes["fix"] = node("done");
    st2.nodes["pr"] = node("awaiting-gate", { iteration: 1 });
    writeFileSync(fx.stateFile, JSON.stringify(st2, null, 2));
    shown.length = 0;
    assert.equal(gateShow({ homeDir: fx.home, config: cfgOf(fx), runId: "m-1", configDirs: [fx.cfg] }), 0);
    const prBrief = JSON.parse(shown.join("")) as { gateNodeId: string; worktreeHead: string | null; validation: { check: string; ok: boolean; detail?: string }[] };
    assert.equal(prBrief.gateNodeId, "pr");
    assert.equal(prBrief.worktreeHead, null, "no HEAD in a missing worktree — null, not a crash");
    const adv = prBrief.validation.find((v) => v.check === "deliverables-manifest");
    assert.equal(adv?.ok, false, "the advisory degrades to a failed row instead of throwing");
  } finally {
    process.stdout.write = quiet;
  }
  assert.equal(existsSync(fx.wt), false, "read-only commands never re-create the worktree");
  assert.equal(existsSync(join(fx.home, "worktrees")), false, "nothing was created next to the run either");
});
