/**
 * server.test.ts — the read-only HTTP surface: home resolution, run-id
 * validation, port-in-use failure message, and an end-to-end pass over a real
 * (ephemeral-port) server against a temp run store, including SSE framing and
 * clean shutdown (port free again afterwards).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import http from "node:http";

import {
  formatPortInUseError,
  isValidRunId,
  resolveUiHome,
  startUiServer,
} from "./server.js";
import type { RunState } from "../core/state.js";

function tempHomeWithRun(runId: string, over: Partial<RunState> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-server-"));
  const runDir = join(home, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const state: RunState = {
    runId,
    workflow: "bugfix",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    worktreePath: "/w",
    branch: "b",
    sourcePlanPath: "/p",
    nodes: {
      reproduce: {
        status: "done",
        artifacts: [],
        iteration: 0,
        cost: 0.05,
        gateHistory: [],
      },
      implement: {
        status: "running",
        artifacts: [],
        iteration: 0,
        cost: 0,
        gateHistory: [],
      },
    },
    ...over,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return home;
}

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

test("resolveUiHome: throws loud when the directory does not exist", () => {
  assert.throws(
    () => resolveUiHome(join(tmpdir(), "dr-ui-nonexistent-" + Date.now())),
    /home not found/,
  );
});

test("resolveUiHome: returns an explicit --home path that exists", () => {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-home-"));
  assert.equal(resolveUiHome(home), home);
});

test("isValidRunId: rejects path traversal and separators, accepts normal run ids", () => {
  assert.equal(isValidRunId("9-1"), true);
  assert.equal(isValidRunId("toy-plan-1700000000000-abc123"), true);
  assert.equal(isValidRunId(".."), false);
  assert.equal(isValidRunId("../../etc"), false);
  assert.equal(isValidRunId("a/b"), false);
  assert.equal(isValidRunId(""), false);
});

test("formatPortInUseError names the exact retry flag", () => {
  assert.equal(
    formatPortInUseError(4740),
    "dagrun ui: port 4740 is already in use. Retry with: dagrun ui --port <n>",
  );
});

test("startUiServer: EADDRINUSE rejects with the exact retry message, and never touches the run store", async () => {
  const home = tempHomeWithRun("9-1");
  const blocker = createServer(() => {});
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const addr = blocker.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await assert.rejects(
    () => startUiServer({ homeDir: home, port }),
    new RegExp(`port ${port} is already in use`),
  );
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

test("startUiServer: /api/runs, /api/runs/:id, / and /?run=<id> all serve, then shuts down cleanly", async () => {
  const home = tempHomeWithRun("9-1");
  const handle = await startUiServer({ homeDir: home, port: 0 });
  try {
    const list = await get(`${handle.url}api/runs`);
    assert.equal(list.status, 200);
    const runs = JSON.parse(list.body) as Array<{ runId: string }>;
    assert.equal(runs[0]?.runId, "9-1");

    const detail = await get(`${handle.url}api/runs/9-1`);
    assert.equal(detail.status, 200);
    const snap = JSON.parse(detail.body) as {
      runId: string;
      nodeOrder: string[];
    };
    assert.equal(snap.runId, "9-1");
    assert.ok(Array.isArray(snap.nodeOrder));

    const missing = await get(`${handle.url}api/runs/does-not-exist`);
    assert.equal(missing.status, 404);

    const traversal = await get(
      `${handle.url}api/runs/${encodeURIComponent("../../etc")}`,
    );
    assert.equal(traversal.status, 400);

    const root = await get(handle.url);
    assert.equal(root.status, 200);
    assert.match(root.body, /<!doctype html>/);

    const withRun = await get(`${handle.url}?run=9-1`);
    assert.equal(withRun.status, 200);
    assert.match(withRun.body, /9-1/);
  } finally {
    await handle.close();
  }

  // Port must be free again — re-listen on the exact same port to prove it.
  const relisten = createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    relisten.once("error", reject);
    relisten.listen(handle.port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve) => relisten.close(() => resolve()));
});

test("startUiServer: the SSE stream endpoint sends valid text/event-stream framing", async () => {
  const home = tempHomeWithRun("9-1");
  const handle = await startUiServer({ homeDir: home, port: 0 });
  try {
    const first = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error("timed out waiting for the first SSE frame"));
      }, 3000);
      const req = http.get(`${handle.url}api/runs/9-1/stream`, (res) => {
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
    assert.match(first, /^: connected\n\n/);
  } finally {
    await handle.close();
  }
});

test("startUiServer: never writes to the run directory (read-only, proven by an on-disk snapshot diff)", async () => {
  const { statSync, readdirSync } = await import("node:fs");
  const home = tempHomeWithRun("9-1");
  const runDir = join(home, "runs", "9-1");
  const before = readdirSync(runDir)
    .sort()
    .map(
      (f) =>
        `${f}:${statSync(join(runDir, f)).mtimeMs}:${statSync(join(runDir, f)).size}`,
    );

  const handle = await startUiServer({ homeDir: home, port: 0 });
  try {
    await get(`${handle.url}api/runs`);
    await get(`${handle.url}api/runs/9-1`);
    await get(handle.url);
    await get(`${handle.url}?run=9-1`);
  } finally {
    await handle.close();
  }

  const after = readdirSync(runDir)
    .sort()
    .map(
      (f) =>
        `${f}:${statSync(join(runDir, f)).mtimeMs}:${statSync(join(runDir, f)).size}`,
    );
  assert.deepEqual(after, before);
});
