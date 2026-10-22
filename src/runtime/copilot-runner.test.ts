/**
 * copilot-runner.test.ts — the Copilot SDK is FAKED here (CopilotSdkModule
 * injected via deps.loadSdk); the real package is never imported by unit tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COPILOT_MODEL_IDS,
  copilotModelId,
  adaptAgentsForCopilot,
  makeReadOnlyPermissionHandler,
  makeCopilotRunner,
  type CopilotSdkModule,
} from "./copilot-runner.js";
import { FINDINGS_SCHEMA } from "../core/findings-schema.js";
import { runDag } from "../core/dag.js";
import { readState, writeState } from "../core/state.js";
import type { RunState } from "../core/state.js";
import { makeDefaultExecutorFactory } from "./runtime-router.js";
import type { Node } from "../core/types.js";
import type { DagrunnerConfig } from "../config/xdg.js";

// ---------------------------------------------------------------------------
// model mapping
// ---------------------------------------------------------------------------

test("copilotModelId: tiers map to Copilot ids; unpinned stays unpinned", () => {
  assert.equal(COPILOT_MODEL_IDS.opus, "claude-opus-5.5");
  assert.equal(copilotModelId({ model: "opus" }), "claude-opus-5.5");
  assert.equal(copilotModelId({ model: "sonnet" }), "claude-sonnet-5.5");
  assert.equal(copilotModelId({ model: "haiku" }), "claude-haiku-5.5");
  assert.equal(copilotModelId({}), undefined);
});

// ---------------------------------------------------------------------------
// agent adaptation (Claude model ids in frontmatter are not Copilot model ids)
// ---------------------------------------------------------------------------

test("adaptAgentsForCopilot: frontmatter model is mapped by tier to the Copilot id; body and other files untouched", () => {
  const src = mkdtempSync(join(tmpdir(), "ag-src-"));
  const dest = join(mkdtempSync(join(tmpdir(), "ag-dst-")), "agents");
  writeFileSync(join(src, "a.md"), "---\nname: a\nmodel: claude-sonnet-4-6\ntools: Read, Bash\n---\nBody\nmodel: claude-sonnet-4-6 stays in body\n");
  writeFileSync(join(src, "b.md"), "---\nname: b\n---\nNo model here\n");
  writeFileSync(join(src, "c.md"), "---\nname: c\nmodel: claude-opus-4-8\n---\nx\n");
  writeFileSync(join(src, "d.md"), "---\nname: d\nmodel: some-unknown-model\n---\nx\n");
  const changes = adaptAgentsForCopilot(src, dest);
  const read = (f: string) => readFileSync(join(dest, f), "utf8");
  assert.match(read("a.md"), /^---\nname: a\nmodel: claude-sonnet-5\.5\ntools: Read, Bash\n---\nBody\nmodel: claude-sonnet-4-6 stays in body\n$/);
  assert.equal(read("b.md"), "---\nname: b\n---\nNo model here\n");
  assert.match(read("c.md"), /model: claude-opus-5\.5/);
  assert.doesNotMatch(read("d.md"), /model:/, "an unmappable model is dropped (inherits the session model), never passed through");
  assert.deepEqual(changes.map((c) => c.file).sort(), ["a.md", "c.md", "d.md"]);
});

// ---------------------------------------------------------------------------
// read-only permission policy
// ---------------------------------------------------------------------------

const policy = () => {
  const decisions: Array<{ kind: string; decision: string }> = [];
  const h = makeReadOnlyPermissionHandler({
    artifactsDir: "/run/review",
    worktreePath: "/wt",
    onDecision: (d) => decisions.push({ kind: d.kind, decision: d.decision }),
  });
  return { h, decisions };
};

test("permission policy: read approved; arbitrary write / mcp / url rejected", async () => {
  const { h } = policy();
  assert.equal((await h({ kind: "read", path: "/wt/a.ts" })).kind, "approve-once");
  assert.equal((await h({ kind: "write", fileName: "src/a.ts", resolvedPath: "/wt/src/a.ts" })).kind, "reject");
  assert.equal((await h({ kind: "mcp" })).kind, "reject");
  assert.equal((await h({ kind: "url" })).kind, "reject");
  assert.equal((await h({ kind: "something-new" })).kind, "reject");
});

test("permission policy: writes allowed ONLY inside the node's artifactsDir (no ../ escape)", async () => {
  const { h } = policy();
  assert.equal((await h({ kind: "write", fileName: "x", resolvedPath: "/run/review/reflections.md" })).kind, "approve-once");
  assert.equal((await h({ kind: "write", fileName: "/run/review/../other/x" })).kind, "reject");
  assert.equal((await h({ kind: "write", fileName: "/run/reviewer-evil/x" })).kind, "reject");
});

test("permission policy: shell only when every command is read-only and nothing redirects to a file", async () => {
  const { h } = policy();
  const ro = [{ identifier: "git", readOnly: true }];
  assert.equal((await h({ kind: "shell", commands: ro, hasWriteFileRedirection: false })).kind, "approve-once");
  assert.equal((await h({ kind: "shell", commands: [...ro, { identifier: "rm", readOnly: false }], hasWriteFileRedirection: false })).kind, "reject");
  assert.equal((await h({ kind: "shell", commands: ro, hasWriteFileRedirection: true })).kind, "reject");
  assert.equal((await h({ kind: "shell", commands: [], hasWriteFileRedirection: false })).kind, "reject");
  assert.equal((await h({ kind: "shell" })).kind, "reject");
});

// Shapes captured from a live Copilot run: commands[].readOnly is FALSE even for cat/ls/git status,
// so the allowlist on commandSegments[].identifier is what actually admits the diff-reading commands.
const seg = (identifier: string, fullCommandText = identifier) => ({ identifier, fullCommandText });
const shell = (segments: Array<{ identifier: string; fullCommandText: string }>, extra: Record<string, unknown> = {}) => ({
  kind: "shell",
  commands: [{ identifier: segments.map((s) => s.fullCommandText).join("; "), readOnly: false }],
  commandSegments: segments,
  hasWriteFileRedirection: false,
  ...extra,
});

test("permission policy: live-observed read-only commands (flag false) are admitted via the segment allowlist", async () => {
  const { h } = policy();
  assert.equal((await h(shell([seg("git diff", "git --no-pager diff --cached origin/main")]))).kind, "approve-once");
  assert.equal((await h(shell([seg("ls", "ls -la src/"), seg("cat", "cat -n src/pager.ts")]))).kind, "approve-once");
  assert.equal((await h(shell([seg("cd"), seg("git status"), seg("git log"), seg("ls"), seg("git diff")]))).kind, "approve-once");
  assert.equal((await h(shell([seg("find", "find . -name '*.ts'")]))).kind, "approve-once");
  // `-C <dir>` (capital) is a plain working-dir switch, not the `-c k=v` config escape
  assert.equal((await h(shell([seg("git log", "git -C sub log --oneline")]))).kind, "approve-once");
  // redirects to /dev/null and fd duplication are not file writes
  assert.equal((await h(shell([seg("git diff", "git diff 2>/dev/null"), seg("head", "head -5")], { fullCommandText: "git diff 2>/dev/null | head -5" }))).kind, "approve-once");
  assert.equal((await h(shell([seg("cat", "cat x 2>&1")], { fullCommandText: "cat x 2>&1" }))).kind, "approve-once");
});

test("permission policy: mutating or code-executing shell is rejected even when it looks like a read", async () => {
  const { h } = policy();
  const rej = async (r: ReturnType<typeof shell>) => assert.equal((await h(r)).kind, "reject", JSON.stringify(r.commandSegments));
  await rej(shell([seg("rm", "rm -rf x")]));
  await rej(shell([seg("touch", "touch evil.txt")]));
  await rej(shell([seg("git checkout", "git checkout -b x")]));
  await rej(shell([seg("git branch", "git branch newbranch")]));
  await rej(shell([seg("git commit", "git commit -am x")]));
  await rej(shell([seg("cat"), seg("rm", "rm x")]));                              // one bad segment poisons the line
  await rej(shell([seg("cat", "cat > out.txt")], { hasWriteFileRedirection: true }));
  await rej(shell([seg("git diff", "git diff --output=out.patch")]));
  await rej(shell([seg("sort", "sort -o out.txt in.txt")]));
  await rej(shell([seg("find", "find . -name '*.ts' -exec rm {} ;")]));
  await rej(shell([seg("find", "find . -delete")]));
  await rej(shell([seg("cat", "cat $(rm x)")]));
  await rej(shell([seg("cat", "cat `rm x`")]));
  await rej(shell([seg("rg", "rg --pre ./evil.sh x")]));
  await rej(shell([seg("sed", "sed -i s/a/b/ f")]));
  // Allowlisted names that still execute programs (reviewer finding): config/env/option escapes.
  await rej(shell([seg("git status", "git -c core.fsmonitor=./evil.sh status")]));
  await rej(shell([seg("git log", "git -c core.pager=./evil.sh log")]));
  await rej(shell([seg("git diff", "GIT_EXTERNAL_DIFF=./evil.sh git diff")]));
  await rej(shell([seg("git log", "GIT_PAGER=./evil.sh git log")]));
  await rej(shell([seg("sort", "sort --compress-program=./evil.sh big.txt")]));
  await rej(shell([seg("git grep", "git grep -O./evil.sh foo")]));
  await rej(shell([seg("git status", "git --exec-path=/tmp/x status")]));
  // Live probe: the runtime flagged `echo hi > evil2.txt` hasWriteFileRedirection=false and the file was created.
  await rej(shell([seg("echo", "echo hi")], { fullCommandText: "echo hi > evil2.txt" }));
  await rej(shell([seg("echo", "echo hi > evil2.txt")]));
  await rej(shell([seg("printf", "printf x >> f")]));
  await rej(shell([seg("cat", "cat a > b")]));
});

test("permission policy: every decision is reported, and a reject carries feedback for the model", async () => {
  const { h, decisions } = policy();
  const r = await h({ kind: "mcp" });
  assert.equal(r.kind, "reject");
  assert.ok(typeof (r as { feedback?: string }).feedback === "string");
  await h({ kind: "read", path: "/x" });
  assert.deepEqual(decisions, [{ kind: "mcp", decision: "reject" }, { kind: "read", decision: "approve" }]);
});

// ---------------------------------------------------------------------------
// runner with a fake SDK
// ---------------------------------------------------------------------------

const GOOD = {
  run_id: "r1", timestamp: "t",
  triage: { touches_public_api: false, touches_runtime: false, touches_schema_or_proto: false, performance_sensitive: false, touches_ui: false },
  reviewers_run: ["reviewer-correctness"], reviewers_skipped: [], adversarial_verifier_run: false, findings: [],
};

type Rec = {
  started: Array<{ env: string | undefined }>;
  stopped: number;
  sessionCfgs: Array<Record<string, any>>;
  sent: Array<{ opts: any; timeout: number }>;
  aborted: number;
  disconnected: number;
  clientEnv: Array<string | undefined>;
};

function fakeSdk(behaviour: {
  reply?: string;
  throwOnSend?: Error;
  models?: string[];
  authed?: boolean;
  usage?: boolean;
} = {}): { sdk: CopilotSdkModule; rec: Rec; clients: number[] } {
  const rec: Rec = { started: [], stopped: 0, sessionCfgs: [], sent: [], aborted: 0, disconnected: 0, clientEnv: [] };
  const clients: number[] = [];
  class FakeClient {
    constructor(opts?: { env?: Record<string, string | undefined> }) { clients.push(clients.length); rec.clientEnv.push(opts?.env?.["DAGRUN_ARTIFACTS"]); }
    async start() { rec.started.push({ env: process.env["DAGRUN_ARTIFACTS"] }); }
    async stop() { rec.stopped++; return []; }
    async getAuthStatus() { return { isAuthenticated: behaviour.authed ?? true }; }
    async listModels() { return (behaviour.models ?? ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"]).map((id) => ({ id })); }
    async createSession(cfg: Record<string, any>) {
      rec.sessionCfgs.push(cfg);
      return {
        sessionId: "sess-123",
        async sendAndWait(opts: any, timeout: number) {
          rec.sent.push({ opts, timeout });
          if (behaviour.throwOnSend) throw behaviour.throwOnSend;
          await cfg["hooks"]?.onSubagentStart?.({});
          await cfg["hooks"]?.onSubagentStart?.({});
          await cfg["hooks"]?.onPreToolUse?.({ toolName: "view" });
          if (behaviour.usage !== false) {
            cfg["onEvent"]?.({ type: "assistant.usage", data: { model: "claude-opus-5.5", inputTokens: 10, outputTokens: 5, copilotUsage: { totalNanoAiu: 777 } } });
          }
          return { data: { content: behaviour.reply ?? JSON.stringify(GOOD) } };
        },
        async disconnect() { rec.disconnected++; },
        async abort() { rec.aborted++; },
      };
    }
  }
  return { sdk: { CopilotClient: FakeClient as never }, rec, clients };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cop-runner-"));
  const worktree = join(root, "wt");
  const runDir = join(root, "run");
  const artifactsDir = join(runDir, "review");
  mkdirSync(join(worktree, ".claude", "skills", "review"), { recursive: true });
  mkdirSync(join(worktree, ".claude", "agents"), { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  const config = { DEVHARNESS_SRC: "/src" } as DagrunnerConfig;
  const node: Node = { id: "review", command: "/review", model: "opus", produces: ["findings.json"] };
  const ctx = { runDir, artifactsDir, worktreePath: worktree };
  return { root, worktree, runDir, artifactsDir, config, node, ctx };
}

test("runner: env is exported BEFORE client.start(); one client per node execution, stopped after", async () => {
  const s = setup();
  const { sdk, rec, clients } = fakeSdk();
  const run = makeCopilotRunner(s.config, "run-1", s.runDir, s.worktree, join(s.root, "store"), { loadSdk: async () => sdk });
  delete process.env["DAGRUN_ARTIFACTS"];
  await run("review", s.node, s.ctx);
  assert.equal(rec.started[0]!.env, s.artifactsDir, "DAGRUN_ARTIFACTS must be set when start() runs");
  await run("review", s.node, s.ctx);
  assert.equal(rec.clientEnv[0], s.artifactsDir, "the client gets an explicit env snapshot (race-free under parallel nodes)");
  assert.equal(clients.length, 2, "a fresh CopilotClient per execution");
  assert.equal(rec.stopped, 2);
  assert.equal(rec.disconnected, 2);
});

test("runner: createSession gets model, cwd, EXPLICIT skill/agent dirs, permission handler and hooks", async () => {
  const s = setup();
  const { sdk, rec } = fakeSdk();
  const run = makeCopilotRunner(s.config, "run-1", s.runDir, s.worktree, join(s.root, "store"), { loadSdk: async () => sdk });
  await run("review", s.node, s.ctx);
  const cfg = rec.sessionCfgs[0]!;
  assert.equal(cfg["model"], "claude-opus-5.5");
  assert.equal(cfg["workingDirectory"], s.worktree);
  assert.deepEqual(cfg["skillDirectories"], [join(s.worktree, ".claude", "skills")]);
  // Agents: an ADAPTED copy of the seeded .claude/agents (model ids mapped), never the raw Claude dir.
  assert.equal(cfg["agentDirectories"].length, 1);
  assert.notEqual(cfg["agentDirectories"][0], join(s.worktree, ".claude", "agents"));
  assert.equal(typeof cfg["onPermissionRequest"], "function");
  assert.equal(typeof cfg["hooks"].onSubagentStart, "function");
});

test("runner: findings.json node uses structured output; the RUNNER writes the file; session id + burn recorded", async () => {
  const s = setup();
  const { sdk, rec } = fakeSdk();
  const run = makeCopilotRunner(s.config, "run-1", s.runDir, s.worktree, join(s.root, "store"), { loadSdk: async () => sdk });
  const res = await run("review", s.node, s.ctx);
  assert.equal(res.status, "done");
  assert.equal(res.status === "done" && res.sessionId, "sess-123");
  assert.equal(res.status === "done" && res.cost, 0, "no fake USD");
  assert.deepEqual(rec.sent[0]!.opts.responseSchema, FINDINGS_SCHEMA);
  assert.match(rec.sent[0]!.opts.prompt, /^\/review /);
  assert.ok(rec.sent[0]!.opts.prompt.includes(s.artifactsDir), "run-environment block rides in the prompt");
  assert.ok(rec.sent[0]!.timeout >= 30 * 60_000, "long turn timeout (default SDK timeout is 60s)");
  assert.deepEqual(JSON.parse(readFileSync(join(s.artifactsDir, "findings.json"), "utf8")), GOOD);
  const burn = JSON.parse(readFileSync(join(s.artifactsDir, "burn.json"), "utf8"));
  assert.equal(burn.runtime, "copilot");
  assert.equal(burn.unit, "nano-aiu");
  assert.equal(burn.totalNanoAiu, 777);
  assert.equal(burn.subagentStarts, 2);
  assert.equal(burn.sessionId, "sess-123");
  assert.ok(existsSync(join(s.artifactsDir, "transcript.log")));
  const friction = readFileSync(join(s.runDir, "friction.jsonl"), "utf8");
  assert.ok(friction.includes("sess-123") && !friction.includes("costUsd"));
});

test("runner: structured output that fails the findings schema FAILS the node (non-retryable) and writes no findings.json", async () => {
  const s = setup();
  const { sdk, rec } = fakeSdk({ reply: JSON.stringify({ ...GOOD, findings: [{ nope: 1 }] }) });
  const run = makeCopilotRunner(s.config, "run-1", s.runDir, s.worktree, join(s.root, "store"), { loadSdk: async () => sdk });
  const res = await run("review", s.node, s.ctx);
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" && res.retryable, false);
  assert.ok(!existsSync(join(s.artifactsDir, "findings.json")));
  assert.equal(rec.stopped, 1, "client stopped on failure too");
  const bad = fakeSdk({ reply: "not json" });
  const res2 = await makeCopilotRunner(s.config, "run-1", s.runDir, s.worktree, join(s.root, "store"), { loadSdk: async () => bad.sdk })("review", s.node, s.ctx);
  assert.equal(res2.status, "failed");
});

test("runner: findings claiming more reviewers than subagents that actually started FAILS retryable and writes nothing", async () => {
  const s = setup();
  // fake emits 2 onSubagentStart per turn; claim 3 reviewers
  const { sdk } = fakeSdk({ reply: JSON.stringify({ ...GOOD, reviewers_run: ["a", "b", "c"] }) });
  const res = await makeCopilotRunner(s.config, "r", s.runDir, s.worktree, join(s.root, "st"), { loadSdk: async () => sdk })("review", s.node, s.ctx);
  assert.equal(res.status, "failed");
  assert.ok(res.status === "failed" && res.retryable === true && /3 reviewer\(s\).*only 2 subagent/.test(res.error), JSON.stringify(res));
  assert.ok(!existsSync(join(s.artifactsDir, "findings.json")));
});

test("runner: node without a registered schema runs plain (no responseSchema) and does not write produces itself", async () => {
  const s = setup();
  const { sdk, rec } = fakeSdk({ reply: "done" });
  const node: Node = { id: "review", command: "/review", produces: ["notes.md"] };
  writeFileSync(join(s.artifactsDir, "notes.md"), "x");
  const run = makeCopilotRunner(s.config, "run-1", s.runDir, s.worktree, join(s.root, "store"), { loadSdk: async () => sdk });
  const res = await run("review", node, s.ctx);
  assert.equal(res.status, "done");
  assert.equal(rec.sent[0]!.opts.responseSchema, undefined);
  assert.equal(rec.sessionCfgs[0]!["model"], undefined, "unpinned node leaves the Copilot default model");
  assert.deepEqual(res.status === "done" && res.artifacts, [join(s.artifactsDir, "notes.md")]);
});

test("runner: SDK error -> failed (retryable); timeout -> abort + failed non-retryable; client always stopped", async () => {
  const s = setup();
  const e1 = fakeSdk({ throwOnSend: new Error("boom") });
  const r1 = await makeCopilotRunner(s.config, "r", s.runDir, s.worktree, join(s.root, "st"), { loadSdk: async () => e1.sdk })("review", s.node, s.ctx);
  assert.equal(r1.status === "failed" && r1.retryable, true);
  assert.equal(e1.rec.stopped, 1);
  const e2 = fakeSdk({ throwOnSend: new Error("Timeout after 5ms waiting for response completion") });
  const r2 = await makeCopilotRunner(s.config, "r", s.runDir, s.worktree, join(s.root, "st"), { loadSdk: async () => e2.sdk })("review", s.node, s.ctx);
  assert.equal(r2.status === "failed" && r2.retryable, false);
  assert.equal(e2.rec.aborted, 1);
  assert.equal(e2.rec.stopped, 1);
});

test("runner: fails loud (non-retryable) when skills/agents dir missing, SDK absent, model unavailable, or not authenticated", async () => {
  const s = setup();
  const mk = (loadSdk: () => Promise<CopilotSdkModule>) =>
    makeCopilotRunner(s.config, "r", s.runDir, s.worktree, join(s.root, "st"), { loadSdk });
  // SDK absent
  const r0 = await mk(async () => { throw new Error("Cannot find package"); })("review", s.node, s.ctx);
  assert.ok(r0.status === "failed" && /@github\/copilot-sdk/.test(r0.error) && !r0.retryable);
  // model unavailable
  const r1 = await mk(async () => fakeSdk({ models: ["gpt-5"] }).sdk)("review", s.node, s.ctx);
  assert.ok(r1.status === "failed" && /claude-opus-5\.5/.test(r1.error) && !r1.retryable);
  // unauthenticated
  const r2 = await mk(async () => fakeSdk({ authed: false }).sdk)("review", s.node, s.ctx);
  assert.ok(r2.status === "failed" && /authenticated/i.test(r2.error) && !r2.retryable);
  // missing dirs: no SDK load attempted at all
  const bare = mkdtempSync(join(tmpdir(), "cop-bare-"));
  let loaded = false;
  const r3 = await makeCopilotRunner(s.config, "r", s.runDir, bare, join(s.root, "st"), { loadSdk: async () => { loaded = true; return fakeSdk().sdk; } })("review", s.node, { ...s.ctx, worktreePath: bare });
  assert.ok(r3.status === "failed" && /skills/.test(r3.error) && !r3.retryable);
  assert.equal(loaded, false);
});

// ---------------------------------------------------------------------------
// the optional dependency must never be loaded by a Claude-only user
// ---------------------------------------------------------------------------

test("no source file statically imports @github/copilot-sdk (it is loaded only via dynamic import)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : [],
    );
  const src = new URL("../", import.meta.url).pathname;
  for (const f of walk(src)) {
    const text = readFileSync(f, "utf8");
    assert.ok(
      !/^\s*(import|export)\s[^;]*from\s+["']@github\/copilot-sdk["']/m.test(text) && !/^\s*import\s+["']@github\/copilot-sdk["']/m.test(text),
      `${f} statically imports @github/copilot-sdk`,
    );
  }
});

// ---------------------------------------------------------------------------
// session id lands in state.json (so a later reopen can `copilot --resume <id>`)
// ---------------------------------------------------------------------------

test("runDag through the router: a copilot node's session id is persisted in state.json; cost stays 0", async () => {
  const s = setup();
  const { sdk } = fakeSdk();
  const wf = {
    name: "w",
    nodes: [{ id: "review", command: "/review", model: "opus" as const, runtime: "copilot" as const, produces: ["findings.json"] }],
  };
  const factory = makeDefaultExecutorFactory(wf, undefined, {
    claude: () => { throw new Error("claude runner must not be built for a copilot-only node"); },
    copilot: (c, rid, rdir, wt, sd) => makeCopilotRunner(c, rid, rdir, wt, sd, { loadSdk: async () => sdk }),
  });
  const stateFile = join(s.runDir, "state.json");
  const state: RunState = {
    runId: "run", workflow: "bugfix", createdAt: "T", updatedAt: "T", status: "running",
    worktreePath: s.worktree, branch: "b", sourcePlanPath: "/p",
    nodes: { review: { status: "pending", artifacts: [], iteration: 0, cost: 0, gateHistory: [] } },
  };
  writeState(stateFile, state);
  const executor = factory(s.config, "run", s.runDir, s.worktree, join(s.root, "store"));
  await runDag(wf, executor, state, {
    ctx: { json: () => ({}), read: () => "", dir: (id) => join(s.runDir, id) },
    stateFile,
  });
  const n = readState(stateFile).nodes["review"]!;
  assert.equal(n.status, "done");
  assert.equal(n.sessionId, "sess-123");
  assert.equal(n.cost, 0);
});

