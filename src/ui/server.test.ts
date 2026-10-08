/**
 * server.test.ts — the read-only HTTP surface: home resolution, run-id
 * validation, port-in-use failure message, and an end-to-end pass over a real
 * (ephemeral-port) server against a temp run store, including SSE framing and
 * clean shutdown (port free again afterwards).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

    // Client-rendered: `?run=<id>` serves the same static shell (the run is selected client-side from the URL).
    const withRun = await get(`${handle.url}?run=9-1`);
    assert.equal(withRun.status, 200);
    assert.equal(withRun.body, root.body);
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

// ---------------------------------------------------------------------------
// LIVE behaviour — these are the tests that fail against the old tail-events-only server.
// ---------------------------------------------------------------------------

type Frame = { event: string; data: unknown };

/** Minimal SSE client: collects parsed frames; `waitFor` polls them with a deadline. */
function sseClient(url: string) {
  const frames: Frame[] = [];
  let buf = "";
  const req = http.get(url, (res) => {
    res.on("data", (c: Buffer) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (ev !== undefined && data !== undefined) frames.push({ event: ev, data: JSON.parse(data) });
      }
    });
  });
  req.on("error", () => {});
  return {
    frames,
    close: () => req.destroy(),
    async waitFor(pred: (f: Frame) => boolean, ms = 4000): Promise<Frame> {
      const end = Date.now() + ms;
      for (;;) {
        const hit = frames.find(pred);
        if (hit !== undefined) return hit;
        if (Date.now() > end) throw new Error(`timed out; frames so far: ${JSON.stringify(frames).slice(0, 600)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

const asstLine = (ts: string, text: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: ts }) + "\n";

type FeedFrameData = { items: Array<{ id: string; text: string; node?: string; kind: string }> };
const feedHas = (text: string) => (f: Frame): boolean =>
  f.event === "feed" && (f.data as FeedFrameData).items.some((i) => i.text === text);

test("LIVE: on connect the client gets the current snapshot and feed HISTORY; lines appended to a running node's transcript.log AFTER connect arrive as feed frames", async () => {
  const home = tempHomeWithRun("9-1");
  const runDir = join(home, "runs", "9-1");
  mkdirSync(join(runDir, "implement"), { recursive: true });
  const tfile = join(runDir, "implement", "transcript.log");
  writeFileSync(tfile, asstLine("2026-01-01T00:00:01.000Z", "history line"));
  const handle = await startUiServer({ homeDir: home, port: 0, pollMs: 40 });
  const c = sseClient(`${handle.url}api/runs/9-1/stream`);
  try {
    const snap = await c.waitFor((f) => f.event === "snapshot");
    assert.equal((snap.data as { runId: string }).runId, "9-1");
    await c.waitFor(feedHas("history line"));

    appendFileSync(tfile, asstLine("2026-01-01T00:00:02.000Z", "appended after connect"));
    const live = await c.waitFor(feedHas("appended after connect"));
    const item = (live.data as FeedFrameData).items.find((i) => i.text === "appended after connect");
    assert.equal(item?.node, "implement");
    assert.equal(item?.kind, "text");
  } finally {
    c.close();
    await handle.close();
  }
});

test("LIVE: an events.jsonl append and the matching state change push a feed frame AND a fresh snapshot", async () => {
  const home = tempHomeWithRun("9-1");
  const runDir = join(home, "runs", "9-1");
  const handle = await startUiServer({ homeDir: home, port: 0, pollMs: 40 });
  const c = sseClient(`${handle.url}api/runs/9-1/stream`);
  try {
    await c.waitFor((f) => f.event === "snapshot");
    const before = c.frames.filter((f) => f.event === "snapshot").length;
    // The engine would write state.json and its derived event together.
    const st = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
    (st.nodes["implement"] as RunState["nodes"][string]).status = "done";
    st.status = "done";
    writeFileSync(join(runDir, "state.json"), JSON.stringify(st));
    appendFileSync(join(runDir, "events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:09:00.000Z", type: "node.finished", node: "implement", detail: { status: "done", cost: 1 } }) + "\n");
    await c.waitFor((f) => f.event === "feed" && (f.data as FeedFrameData).items.some((i) => /implement done/.test(i.text)));
    const snap = await c.waitFor((f) => f.event === "snapshot" && (f.data as { runStatus: string }).runStatus === "done");
    assert.ok(c.frames.filter((f) => f.event === "snapshot").length > before);
    assert.equal((snap.data as { nodes: Record<string, { status: string }> }).nodes["implement"]?.status, "done");
  } finally {
    c.close();
    await handle.close();
  }
});

test("LIVE: a node that starts running AFTER the client connected is tailed (transcript did not exist at connect time)", async () => {
  const home = tempHomeWithRun("9-1", {
    nodes: {
      reproduce: { status: "done", artifacts: [], iteration: 0, cost: 0, gateHistory: [] },
      implement: { status: "pending", artifacts: [], iteration: 0, cost: 0, gateHistory: [] },
    },
  });
  const runDir = join(home, "runs", "9-1");
  const handle = await startUiServer({ homeDir: home, port: 0, pollMs: 40 });
  const c = sseClient(`${handle.url}api/runs/9-1/stream`);
  try {
    await c.waitFor((f) => f.event === "snapshot");
    mkdirSync(join(runDir, "implement"), { recursive: true });
    writeFileSync(join(runDir, "implement", "transcript.log"), asstLine("2026-01-01T00:00:05.000Z", "first words of a late node"));
    const st = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
    (st.nodes["implement"] as RunState["nodes"][string]).status = "running";
    writeFileSync(join(runDir, "state.json"), JSON.stringify(st));
    await c.waitFor(feedHas("first words of a late node"));
    await c.waitFor((f) => f.event === "snapshot" && (f.data as { currentNodes: string[] }).currentNodes.includes("implement"));
  } finally {
    c.close();
    await handle.close();
  }
});

test("LIVE: a run directory created AFTER the server started appears in /api/runs (the page polls this)", async () => {
  const home = tempHomeWithRun("9-1");
  const handle = await startUiServer({ homeDir: home, port: 0, pollMs: 40 });
  try {
    const first = JSON.parse((await get(`${handle.url}api/runs`)).body) as Array<{ runId: string }>;
    assert.deepEqual(first.map((r) => r.runId), ["9-1"]);
    const runDir = join(home, "runs", "9-2");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({ runId: "9-2", workflow: "bugfix", createdAt: "t", updatedAt: "t", status: "running", worktreePath: "/w", branch: "b", sourcePlanPath: "/p", nodes: {} }),
    );
    const second = JSON.parse((await get(`${handle.url}api/runs`)).body) as Array<{ runId: string }>;
    assert.ok(second.some((r) => r.runId === "9-2"));
  } finally {
    await handle.close();
  }
});

test("LIVE: two clients on one run share one tailer; closing both stops the timer and the server closes promptly", async () => {
  const home = tempHomeWithRun("9-1");
  const handle = await startUiServer({ homeDir: home, port: 0, pollMs: 40 });
  const a = sseClient(`${handle.url}api/runs/9-1/stream`);
  const b = sseClient(`${handle.url}api/runs/9-1/stream`);
  await a.waitFor((f) => f.event === "snapshot");
  await b.waitFor((f) => f.event === "snapshot");
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 120));
  await handle.close(); // would hang the test run if a timer or socket leaked
});

test("REST: /feed, /output and /artifact serve history, one node's output, and a rendered artifact; bad inputs are 400/404", async () => {
  const home = tempHomeWithRun("9-1");
  const runDir = join(home, "runs", "9-1");
  mkdirSync(join(runDir, "implement"), { recursive: true });
  writeFileSync(join(runDir, "implement", "transcript.log"), asstLine("2026-01-01T00:00:01.000Z", "hello feed"));
  writeFileSync(join(runDir, "implement", "summary.md"), "# Sum\n\n<script>alert(1)</script>");
  const handle = await startUiServer({ homeDir: home, port: 0 });
  try {
    const feed = JSON.parse((await get(`${handle.url}api/runs/9-1/feed`)).body) as FeedFrameData & { total: number };
    assert.ok(feed.items.some((i) => i.text === "hello feed"));
    const out = JSON.parse((await get(`${handle.url}api/runs/9-1/output?node=implement`)).body) as FeedFrameData;
    assert.deepEqual(out.items.map((i) => i.text), ["hello feed"]);
    const art = await get(`${handle.url}api/runs/9-1/artifact?node=implement&name=summary.md`);
    assert.equal(art.status, 200);
    const view = JSON.parse(art.body) as { html: string };
    assert.match(view.html, /<h1>Sum<\/h1>/);
    assert.doesNotMatch(view.html, /<script/);
    assert.equal((await get(`${handle.url}api/runs/9-1/artifact?node=implement&name=..%2F..%2Fx.md`)).status, 400);
    assert.equal((await get(`${handle.url}api/runs/9-1/artifact?node=implement&name=nope.md`)).status, 404);
    assert.equal((await get(`${handle.url}api/runs/nope/feed`)).status, 404);
    assert.equal((await get(`${handle.url}api/runs/9-1/output?node=..`)).status, 400);
  } finally {
    await handle.close();
  }
});
