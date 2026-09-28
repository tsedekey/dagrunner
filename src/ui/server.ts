/**
 * server.ts — `dagrun ui`'s HTTP server: strictly read-only, loopback-only,
 * zero new dependencies (Node's built-in `http` only, no Express).
 *
 * Routes:
 *   GET /                          — the single-page timeline viewer
 *   GET /?run=<id>                 — same page, server-rendered with that run's data baked in
 *   GET /api/runs                  — JSON run list (discover.ts)
 *   GET /api/runs/:id               — JSON run-detail snapshot (run-snapshot.ts)
 *   GET /api/runs/:id/stream        — text/event-stream: new events.jsonl entries + refreshed snapshots
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
import { buildNodeViews } from "./node-views.js";
import { renderPage, type NodeView } from "./page.js";
import {
  formatSse,
  formatSseComment,
  readNewEvents,
  type SseOffset,
} from "./sse.js";

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

const POLL_MS = 1000;

export async function startUiServer(opts: {
  homeDir: string;
  port: number;
}): Promise<UiServerHandle> {
  const { homeDir } = opts;

  type SseClient = { res: ServerResponse; offset: SseOffset };
  const clientsByRun = new Map<string, Set<SseClient>>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  function tickRun(runId: string): void {
    const clients = clientsByRun.get(runId);
    if (clients === undefined || clients.size === 0) return;
    const runDir = join(homeDir, "runs", runId);
    const newEvents = new Map<SseClient, ReturnType<typeof readNewEvents>>();
    let anyNew = false;
    for (const client of clients) {
      const events = readNewEvents(runDir, client.offset);
      newEvents.set(client, events);
      if (events.length > 0) anyNew = true;
    }
    if (!anyNew) {
      for (const client of clients) client.res.write(formatSseComment("ping"));
      return;
    }
    let snapshotText: string | null = null;
    try {
      snapshotText = JSON.stringify(buildRunSnapshot(homeDir, runId));
    } catch {
      snapshotText = null; // run vanished/corrupted mid-stream — still deliver the raw events below
    }
    for (const client of clients) {
      for (const ev of newEvents.get(client) ?? [])
        client.res.write(formatSse("event", ev));
      if (snapshotText !== null)
        client.res.write(`event: snapshot\ndata: ${snapshotText}\n\n`);
    }
  }

  function addClient(
    runId: string,
    res: ServerResponse,
    req: IncomingMessage,
  ): void {
    let set = clientsByRun.get(runId);
    if (set === undefined) {
      set = new Set();
      clientsByRun.set(runId, set);
    }
    const runDir = join(homeDir, "runs", runId);
    const offset: SseOffset = { bytesRead: 0 };
    readNewEvents(runDir, offset); // fast-forward past history — SSE carries deltas only, the JSON endpoint carries the snapshot
    const client: SseClient = { res, offset };
    set.add(client);
    if (!timers.has(runId)) {
      timers.set(
        runId,
        setInterval(() => tickRun(runId), POLL_MS),
      );
    }
    req.on("close", () => {
      set?.delete(client);
      if (set !== undefined && set.size === 0) {
        const t = timers.get(runId);
        if (t !== undefined) clearInterval(t);
        timers.delete(runId);
        clientsByRun.delete(runId);
      }
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  function sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
  }

  function handleRoot(url: URL, res: ServerResponse): void {
    const runParam = url.searchParams.get("run");
    const runs = discoverRuns(homeDir);
    let run = null;
    let selectedError: string | null = null;
    let nodeViews: NodeView[] = [];
    if (runParam !== null) {
      if (!isValidRunId(runParam)) {
        selectedError = "invalid run id";
      } else {
        try {
          run = buildRunSnapshot(homeDir, runParam);
          nodeViews = buildNodeViews(run);
        } catch (e) {
          selectedError = e instanceof Error ? e.message : String(e);
        }
      }
    }
    sendHtml(
      res,
      200,
      renderPage({
        runs,
        selectedRunId: runParam,
        selectedError,
        run,
        nodeViews,
      }),
    );
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

    const streamMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (streamMatch !== null) {
      const runId = decodeURIComponent(streamMatch[1] ?? "");
      if (!isValidRunId(runId) || !existsSync(join(homeDir, "runs", runId))) {
        sendJson(res, 404, { error: `run "${runId}" not found` });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(formatSseComment("connected"));
      addClient(runId, res, req);
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
      handleRoot(url, res);
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
        for (const set of clientsByRun.values()) {
          for (const client of set) client.res.end();
        }
        for (const t of timers.values()) clearInterval(t);
        timers.clear();
        clientsByRun.clear();
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
