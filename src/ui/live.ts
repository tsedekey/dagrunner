/**
 * live.ts — the per-run live tailer behind the SSE stream.
 *
 * A running node's activity (assistant text, tool calls) is NOT in
 * events.jsonl (state transitions only) — it lives in `<runDir>/<node>/
 * transcript.log`. Each `poll()` re-reads state.json to learn which nodes are
 * `running` NOW (a transcript may not exist yet when the client connects, and a
 * node may start later), tails events.jsonl plus those transcripts by byte
 * offset, and returns the new feed items. A node that just stopped running gets
 * one final drain so its closing lines are not lost. Archived attempts
 * (`<node>-attempts/`) are never tailed. Read-only; never throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventToItem, shortenPaths, transcriptItems, type FeedItem } from "./feed.js";
import { fastForward, readNewEventLines, tailLines, type SseOffset } from "./sse.js";

export type RunTailer = { poll: () => FeedItem[] };

type Tracked = { offset: SseOffset; lastTs: string | null };

type StateLite = { worktreePath?: string; nodes?: Record<string, { status?: string; startedAt?: string }> };

function readStateLite(runDir: string): StateLite | null {
  try {
    return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as StateLite;
  } catch {
    return null; // torn mid-write or gone: try again next poll
  }
}

const NODE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function createRunTailer(
  homeDir: string,
  runId: string,
  now: () => string = () => new Date().toISOString(),
): RunTailer {
  const runDir = join(homeDir, "runs", runId);
  const eventsOffset: SseOffset = { bytesRead: 0 };
  const tracked = new Map<string, Tracked>();

  // History is served separately (feed.ts), so everything that exists NOW is skipped here — for EVERY
  // node, not just running ones: a gate amend / revise-self re-run appends to the SAME transcript.log
  // (only `dagrun rerun` archives it), so a node that is awaiting a gate now and runs again later must
  // not replay its earlier rounds as "live". Offsets live for the tailer's lifetime; a replaced file
  // (archived rerun) is caught by tailLines' inode check, not by a startedAt heuristic.
  readNewEventLines(runDir, eventsOffset);
  const state0 = readStateLite(runDir);
  for (const id of Object.keys(state0?.nodes ?? {})) {
    if (!NODE_ID_RE.test(id)) continue;
    const t: Tracked = { offset: { bytesRead: 0 }, lastTs: null };
    fastForward(join(runDir, id, "transcript.log"), t.offset);
    tracked.set(id, t);
  }
  let prevRunning = new Set(Object.entries(state0?.nodes ?? {}).filter(([, ns]) => ns.status === "running").map(([id]) => id));

  function poll(): FeedItem[] {
    const out: FeedItem[] = [];
    for (const e of readNewEventLines(runDir, eventsOffset)) out.push(eventToItem(e.event, e.offset));

    const state = readStateLite(runDir);
    if (state === null) return out;
    const nodes = state.nodes ?? {};
    const running = new Set(Object.entries(nodes).filter(([, ns]) => ns.status === "running").map(([id]) => id));
    // A node first seen after the tailer started has no history to skip: read it from byte 0.
    for (const id of Object.keys(nodes)) {
      if (NODE_ID_RE.test(id) && !tracked.has(id)) tracked.set(id, { offset: { bytesRead: 0 }, lastTs: null });
    }
    for (const [id, t] of tracked) {
      // Tail running nodes, plus one final drain right after a node stops running.
      if (!running.has(id) && !prevRunning.has(id)) continue;
      const path = join(runDir, id, "transcript.log");
      if (!existsSync(path)) continue;
      const lines = tailLines(path, t.offset);
      if (lines.length === 0) continue;
      const r = transcriptItems({
        node: id,
        ino: t.offset.ino ?? 0,
        lines,
        lastTs: t.lastTs,
        fallbackTs: now(),
        shorten: (s) => shortenPaths(s, runDir, state.worktreePath ?? ""),
      });
      t.lastTs = r.lastTs;
      out.push(...r.items);
    }
    prevRunning = running;
    return out;
  }

  return { poll };
}
