/**
 * server.ts — `dagrun ui`'s HTTP server: strictly read-only, loopback-only,
 * zero new dependencies (Node's built-in `http` only, no Express).
 *
 * Routes:
 *   GET /                          — the static page shell (client-rendered from the JSON below; `?run=<id>` selects a run client-side)
 *   GET /api/runs                  — JSON run list (discover.ts); the page polls it so new runs appear
 *   GET /api/runs/:id               — JSON run view (run-snapshot.ts)
 *   GET /api/runs/:id/feed          — activity-feed history (events.jsonl + every node's transcript.log)
 *   GET /api/runs/:id/output?node=  — one node's agent output (its transcript.log)
 *   GET /api/runs/:id/artifact?node=&name= — one artifact file rendered to safe HTML (lazy: content never rides in snapshots)
 *   GET /api/runs/:id/stream        — text/event-stream: `snapshot` (whole view, on connect and whenever it changes)
 *                                     + `feed` ({items}, history batch on connect, then live deltas from events.jsonl
 *                                     and the transcripts of running nodes); `: ping` heartbeat when idle
 *
 * Never writes to a run directory, never touches active.lock, never calls any
 * decide/approve/amend/resume path — see DECISIONS.md § agent-driven-slice3-ui.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { computeHomePath } from "../config/xdg.js";
import { discoverRuns } from "./discover.js";
import { buildRunSnapshot } from "./run-snapshot.js";
import { renderPage } from "./page.js";
import { readArtifactView } from "./artifact.js";
import { buildFeedHistory, buildNodeOutput, type FeedItem } from "./feed.js";
import { createRunTailer, type RunTailer } from "./live.js";
import { formatSse, formatSseComment } from "./sse.js";

/** `dagrun ui --home <dir>` resolution: unlike `resolveHome()`, honours an explicit flag. Fails loud (throws), never a silent cwd fallback. */
export function resolveUiHome(homeFlag?: string): string {
  const home = computeHomePath(homeFlag);
  if (!existsSync(home)) {
    throw new Error(
      `dagrun ui: home not found at "${home}" (${homeFlag !== undefined && homeFlag !== "" ? "--home" : "DAGRUNNER_HOME / XDG default"}). Run \`dagrun init\` first, or pass --home <dir>.`,
    );
  }
  return home;
}

export function formatPortInUseError(port: number): string {
  return `dagrun ui: port ${port} is already in use. Retry with: dagrun ui --port <n>`;
}

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Guards every runId taken from a URL: no path traversal, no separators. */
export function isValidRunId(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && RUN_ID_RE.test(id);
}

export type UiServerHandle = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

const DEFAULT_POLL_MS = 1000;
const NODE_ID_RE = /^[A-Za-z0-9._-]+$/;
const OUTPUT_LIMIT = 300;

export async function startUiServer(opts: {
  homeDir: string;
  port: number;
  /** SSE poll interval; tests shrink it, the CLI uses the 1s default. */
  pollMs?: number;
}): Promise<UiServerHandle> {
  const { homeDir } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // One watch (tailer + timer) per run that has at least one connected client,
  // shared by all of that run's clients; torn down when the last one leaves.
  type Watch = {
    tailer: RunTailer;
    clients: Set<ServerResponse>;
    timer: ReturnType<typeof setInterval>;
    lastView: string | null;
  };
  const watches = new Map<string, Watch>();

  function viewJson(runId: string): string | null {
    try {
      return JSON.stringify(buildRunSnapshot(homeDir, runId));
    } catch {
      return null; // run vanished / state.json torn mid-write — keep serving what we have
    }
  }

  function write(res: ServerResponse, frame: string): void {
    try {
      res.write(frame);
    } catch {
      // socket already gone — its 'close' handler removes it
    }
  }

  function tickRun(runId: string): void {
    const w = watches.get(runId);
    if (w === undefined) return;
    let items: FeedItem[] = [];
    try {
      items = w.tailer.poll();
    } catch {
      items = []; // a read-only observer must never take the server down
    }
    const json = viewJson(runId);
    let sent = false;
    if (items.length > 0) {
      const frame = formatSse("feed", { items });
      for (const c of w.clients) write(c, frame);
      sent = true;
    }
    if (json !== null && json !== w.lastView) {
      w.lastView = json;
      const frame = `event: snapshot\ndata: ${json}\n\n`;
      for (const c of w.clients) write(c, frame);
      sent = true;
    }
    if (!sent) for (const c of w.clients) write(c, formatSseComment("ping"));
  }

  function addClient(
    runId: string,
    res: ServerResponse,
    req: IncomingMessage,
  ): void {
    let w = watches.get(runId);
    if (w === undefined) {
      // The tailer primes its offsets to "now" BEFORE the history below is read, so a line
      // written in between shows up in both — de-duped client-side by its stable id, never lost.
      const tailer = createRunTailer(homeDir, runId);
      const created: Watch = {
        tailer,
        clients: new Set(),
        lastView: null,
        timer: setInterval(() => tickRun(runId), pollMs),
      };
      watches.set(runId, created);
      w = created;
    }
    const watch = w;
    watch.clients.add(res);

    // First frames: current snapshot + recent feed history, so a (re)connecting client
    // is complete without a separate fetch, then deltas follow.
    const json = viewJson(runId);
    if (json !== null) {
      if (watch.lastView === null) watch.lastView = json;
      write(res, `event: snapshot\ndata: ${json}\n\n`);
    }
    try {
      write(res, formatSse("feed", { ...buildFeedHistory(homeDir, runId), history: true }));
    } catch {
      // history is best-effort; live deltas still flow
    }

    req.on("close", () => {
      watch.clients.delete(res);
      if (watch.clients.size === 0) {
        clearInterval(watch.timer);
        if (watches.get(runId) === watch) watches.delete(runId);
      }
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
    });
    res.end(text);
  }

  function sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store",
    });
    res.end(html);
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, {
        error: "method not allowed — dagrun ui is read-only",
      });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/runs") {
      sendJson(res, 200, discoverRuns(homeDir));
      return;
    }

    const subMatch = /^\/api\/runs\/([^/]+)\/(stream|feed|output|artifact)$/.exec(url.pathname);
    if (subMatch !== null) {
      const runId = decodeURIComponent(subMatch[1] ?? "");
      const what = subMatch[2];
      if (!isValidRunId(runId) || !existsSync(join(homeDir, "runs", runId))) {
        sendJson(res, 404, { error: `run "${runId}" not found` });
        return;
      }
      if (what === "stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(formatSseComment("connected"));
        addClient(runId, res, req);
        return;
      }
      if (what === "feed") {
        sendJson(res, 200, buildFeedHistory(homeDir, runId));
        return;
      }
      const node = url.searchParams.get("node") ?? "";
      if (what === "output") {
        if (!NODE_ID_RE.test(node) || node === "." || node === "..") {
          sendJson(res, 400, { error: "invalid node id" });
          return;
        }
        sendJson(res, 200, { items: buildNodeOutput(homeDir, runId, node, OUTPUT_LIMIT) });
        return;
      }
      const r = readArtifactView(homeDir, runId, node, url.searchParams.get("name") ?? "");
      if (r.ok) sendJson(res, 200, r.view);
      else sendJson(res, r.status, { error: r.error });
      return;
    }

    const detailMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (detailMatch !== null) {
      const runId = decodeURIComponent(detailMatch[1] ?? "");
      if (!isValidRunId(runId)) {
        sendJson(res, 400, { error: "invalid run id" });
        return;
      }
      try {
        sendJson(res, 200, buildRunSnapshot(homeDir, runId));
      } catch (e) {
        sendJson(res, 404, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (url.pathname === "/") {
      sendHtml(res, 200, renderPage());
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const server: Server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      reject(
        err.code === "EADDRINUSE"
          ? new Error(formatPortInUseError(opts.port))
          : err,
      );
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port, "127.0.0.1");
  });

  const addr = server.address();
  const port =
    typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const w of watches.values()) {
          clearInterval(w.timer);
          for (const client of w.clients) client.end();
        }
        watches.clear();
        const closable = server as unknown as {
          closeAllConnections?: () => void;
        };
        if (typeof closable.closeAllConnections === "function")
          closable.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Best-effort open of the OS default browser at `url`. Never throws; never fails the caller when `open`/`xdg-open` is missing. */
export function openBrowser(url: string): void {
  const plat = platform();
  const spec =
    plat === "darwin"
      ? { command: "open", args: [url] }
      : plat === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // A missing `open`/`xdg-open` must never crash `dagrun ui` — this is a convenience only.
    });
    child.unref();
  } catch {
    // ignore — best-effort
  }
}
