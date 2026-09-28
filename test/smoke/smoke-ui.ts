#!/usr/bin/env node
/**
 * smoke-ui.ts — in-process smoke test for `dagrun ui`'s HTTP server.
 *
 * Drives two real (mock-executor) bugfix runs into a temp DAGRUNNER_HOME (one
 * paused at its "reproduce" gate, one driven to `done`), starts the real
 * `startUiServer` on an ephemeral port against that home, hits every JSON/SSE
 * endpoint and the HTML page, and proves the server never wrote to either run
 * directory. Does NOT touch `~/.local/share/dagrunner` or run `59478-2` — see
 * DECISIONS.md § agent-driven-slice3-ui for the separate, manual, read-only
 * pass against real data.
 *
 * Run: node --import tsx ./test/smoke/smoke-ui.ts
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startRun, resumeRun } from "../../src/runtime/run-engine.js";
import { createMockExecutor } from "../../src/runtime/mock-executor.js";
import { bugfixWorkflow } from "../../src/workflow/bugfix-workflow.js";
import { startUiServer } from "../../src/ui/server.js";
import type { DagrunnerConfig } from "../../src/config/xdg.js";
import type { RunState } from "../../src/core/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOY_REPO_PATH = join(__dirname, "fixtures", "toy-repo");
const TOY_PLAN_PATH = join(__dirname, "fixtures", "toy-plan.md");

if (!existsSync(join(TOY_REPO_PATH, ".git"))) {
  mkdirSync(TOY_REPO_PATH, { recursive: true });
  execSync(
    'git init && echo "# toy repo" > README.md && git add README.md && git commit -m "init"',
    {
      cwd: TOY_REPO_PATH,
      stdio: "inherit",
    },
  );
}
const config: DagrunnerConfig = { DEVHARNESS_SRC: TOY_REPO_PATH };

function makePlanPath(homeDir: string, issueNum: number): string {
  const dest = join(homeDir, `${issueNum}-toy-plan.md`);
  writeFileSync(dest, readFileSync(TOY_PLAN_PATH, "utf8"), "utf8");
  return dest;
}

const bugfixMockFactory = () =>
  createMockExecutor({
    reproduce: "gate-pause",
    implement: "success",
    review: "success",
    fix: "gate-pause",
    verify: "success",
    pr: "success",
  });

const BASE_TS = Date.now();
const HOME = `/tmp/dagrun-smoke-ui-${BASE_TS}`;
mkdirSync(join(HOME, "runs"), { recursive: true });
mkdirSync(join(HOME, "worktrees"), { recursive: true });

function readState(runDir: string): RunState {
  return JSON.parse(
    readFileSync(join(runDir, "state.json"), "utf8"),
  ) as RunState;
}

// ---------------------------------------------------------------------------
// RUN 1 — paused at the "reproduce" gate (exercises the awaiting-gate banner).
// ---------------------------------------------------------------------------

const PLAN_1 = makePlanPath(HOME, BASE_TS);
await startRun({
  workflow: bugfixWorkflow,
  noCompanion: true,
  planPath: PLAN_1,
  homeDir: HOME,
  config,
  executorFactory: bugfixMockFactory,
});
const RUN_ID_1 = readdirSync(join(HOME, "runs")).find((d) =>
  existsSync(join(HOME, "runs", d, "state.json")),
);
assert.ok(RUN_ID_1 !== undefined, "run 1 must exist after startRun");
{
  const state = readState(join(HOME, "runs", RUN_ID_1 as string));
  assert.equal(state.nodes["reproduce"]?.status, "awaiting-gate");
}
console.log(`smoke-ui: run 1 (${RUN_ID_1}) paused at "reproduce" gate`);

// ---------------------------------------------------------------------------
// RUN 2 — driven to `done` (exercises a completed run in the list/detail).
// ---------------------------------------------------------------------------

const PLAN_2 = makePlanPath(HOME, BASE_TS + 1);
await startRun({
  workflow: bugfixWorkflow,
  noCompanion: true,
  planPath: PLAN_2,
  homeDir: HOME,
  config,
  executorFactory: bugfixMockFactory,
});
const RUN_ID_2 = readdirSync(join(HOME, "runs")).find(
  (d) => d !== RUN_ID_1 && existsSync(join(HOME, "runs", d, "state.json")),
);
assert.ok(RUN_ID_2 !== undefined, "run 2 must exist after startRun");
await resumeRun({
  runId: RUN_ID_2 as string,
  homeDir: HOME,
  config,
  approve: true,
  executorFactory: bugfixMockFactory,
});
await resumeRun({
  runId: RUN_ID_2 as string,
  homeDir: HOME,
  config,
  approve: true,
  executorFactory: bugfixMockFactory,
});
{
  const state = readState(join(HOME, "runs", RUN_ID_2 as string));
  assert.equal(state.status, "done", `run 2 must be done, got ${state.status}`);
}
console.log(`smoke-ui: run 2 (${RUN_ID_2}) driven to done`);

// ---------------------------------------------------------------------------
// Snapshot both run directories before touching the server (read-only proof).
// ---------------------------------------------------------------------------

function snapshotDir(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map(
      (f) =>
        `${f}:${statSync(join(dir, f)).mtimeMs}:${statSync(join(dir, f)).size}`,
    );
}
const runDir1 = join(HOME, "runs", RUN_ID_1 as string);
const runDir2 = join(HOME, "runs", RUN_ID_2 as string);
const before1 = snapshotDir(runDir1);
const before2 = snapshotDir(runDir2);

// ---------------------------------------------------------------------------
// Start the real server and hit every endpoint.
// ---------------------------------------------------------------------------

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

const handle = await startUiServer({ homeDir: HOME, port: 0 });
console.log(`smoke-ui: server listening at ${handle.url}`);

try {
  const list = await get(`${handle.url}api/runs`);
  assert.equal(list.status, 200, "GET /api/runs must be 200");
  const runs = JSON.parse(list.body) as Array<{
    runId: string;
    workflow: string;
    status: string;
  }>;
  assert.ok(
    runs.some((r) => r.runId === RUN_ID_1),
    "run 1 must be listed",
  );
  assert.ok(
    runs.some((r) => r.runId === RUN_ID_2),
    "run 2 must be listed",
  );
  console.log("smoke-ui: GET /api/runs — valid JSON, both runs present");

  const detail1 = await get(`${handle.url}api/runs/${RUN_ID_1}`);
  assert.equal(detail1.status, 200);
  const snap1 = JSON.parse(detail1.body) as {
    awaitingGate: { nodeId: string } | null;
    nodeOrder: string[];
  };
  assert.equal(snap1.awaitingGate?.nodeId, "reproduce");
  assert.deepEqual(
    snap1.nodeOrder,
    bugfixWorkflow.nodes.map((n) => n.id),
  );
  console.log(
    "smoke-ui: GET /api/runs/<paused> — awaitingGate + workflow node order correct",
  );

  const detail2 = await get(`${handle.url}api/runs/${RUN_ID_2}`);
  assert.equal(detail2.status, 200);
  const snap2 = JSON.parse(detail2.body) as { status: string };
  assert.equal(snap2.status, "done");
  console.log("smoke-ui: GET /api/runs/<done> — status done");

  const notFound = await get(
    `${handle.url}api/runs/${encodeURIComponent("../../etc/passwd")}`,
  );
  assert.equal(
    notFound.status,
    400,
    "path-traversal-shaped run id must be rejected",
  );

  const root = await get(handle.url);
  assert.equal(root.status, 200);
  assert.match(root.body, /<!doctype html>/);
  console.log("smoke-ui: GET / — valid HTML page");

  const withRun = await get(`${handle.url}?run=${RUN_ID_1}`);
  assert.equal(withRun.status, 200);
  assert.match(withRun.body, /Awaiting decision/);
  assert.match(withRun.body, new RegExp(String(RUN_ID_1)));
  console.log(
    "smoke-ui: GET /?run=<paused> — gate banner rendered server-side",
  );

  // SSE framing: the first frame must be the ": connected" comment.
  const ssePayload = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("timed out waiting for the first SSE frame"));
    }, 5000);
    const req = http.get(`${handle.url}api/runs/${RUN_ID_1}/stream`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        if (buf.includes("\n\n")) {
          clearTimeout(timeout);
          req.destroy();
          resolve(buf);
        }
      });
    });
    req.on("error", reject);
  });
  assert.match(ssePayload, /^: connected\n\n/);
  console.log("smoke-ui: GET /api/runs/<id>/stream — valid SSE framing");
} finally {
  await handle.close();
}
console.log("smoke-ui: server closed cleanly");

// Port must be free again — no leftover process/port.
const relisten = createServer(() => {});
await new Promise<void>((resolve, reject) => {
  relisten.once("error", reject);
  relisten.listen(handle.port, "127.0.0.1", () => resolve());
});
await new Promise<void>((resolve) => relisten.close(() => resolve()));
console.log(`smoke-ui: port ${handle.port} confirmed free after close`);

// ---------------------------------------------------------------------------
// Read-only proof: neither run directory changed at all.
// ---------------------------------------------------------------------------

assert.deepEqual(
  snapshotDir(runDir1),
  before1,
  "run 1's directory must be byte-for-byte unchanged",
);
assert.deepEqual(
  snapshotDir(runDir2),
  before2,
  "run 2's directory must be byte-for-byte unchanged",
);
console.log(
  "smoke-ui: confirmed read-only — no file in either run directory changed",
);

console.log("smoke-ui: ALL STEPS PASSED");
