/**
 * feed.ts — the single activity-item schema behind the UI's ACTIVITY feed and
 * each node's Output tab, used identically by page-load history (REST + the
 * first SSE batch) and live SSE deltas.
 *
 * Two sources, merged chronologically:
 *   - `events.jsonl` (engine state transitions) -> one item per event,
 *     id `e:<byte offset>`;
 *   - each node's `transcript.log` (agent assistant text + tool calls, parsed
 *     by transcript.ts) -> id `t:<node>:<inode>:<byte offset>:<block index>`.
 * Ids are derived from where the data lives, so history and live tailing
 * compute the SAME id for the same line and the client de-dupes across
 * reconnects with no server-side sequence state; the inode keeps ids unique
 * after a `dagrun rerun` archives the old transcript and starts a fresh file.
 *
 * Read-only; never throws on bad data (a garbled line is skipped).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../core/events.js";
import { tailLines, readNewEventLines, type SseOffset, type TailLine } from "./sse.js";
import { parseTranscriptLine } from "./transcript.js";

export type FeedKind =
  | "run"
  | "start"
  | "session"
  | "gate"
  | "decision"
  | "skip"
  | "fail"
  | "info"
  | "text"
  | "tool";

export type FeedItem = {
  id: string;
  ts: string;
  kind: FeedKind;
  node?: string;
  text: string;
  /** Tool name, for kind "tool". */
  tool?: string;
  /** The timestamp is a stand-in (previous line's / start of node / receipt time), not the line's own. */
  approx?: boolean;
  /** Summary salvaged from an 8 KB-cut transcript line. */
  truncated?: boolean;
  source: "events" | "transcript";
};

export const DEFAULT_MAX_TRANSCRIPT_ITEMS = 150;

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const usd = (n: unknown): string => (typeof n === "number" ? `$${n.toFixed(2)}` : "");

export function eventToItem(e: RunEvent, offset: number): FeedItem {
  const base = { id: `e:${offset}`, ts: e.ts, source: "events" as const, ...(e.node !== undefined ? { node: e.node } : {}) };
  const d = e.detail ?? {};
  const node = e.node ?? "node";
  switch (e.type) {
    case "run.started":
      return { ...base, kind: "run", text: `Run started${typeof d["workflow"] === "string" ? ` (${d["workflow"]} workflow)` : ""}` };
    case "node.started":
      return { ...base, kind: "start", text: `${node} started${typeof e.iteration === "number" && e.iteration > 0 ? ` (iteration ${e.iteration})` : ""}` };
    case "node.finished": {
      const status = typeof d["status"] === "string" ? d["status"] : "finished";
      const parts = [usd(d["cost"]), typeof d["durationMs"] === "number" ? fmtDur(d["durationMs"]) : ""].filter((x) => x !== "");
      const tail = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
      if (status === "failed") {
        return { ...base, kind: "fail", text: `${node} failed${typeof d["error"] === "string" ? `: ${d["error"].split("\n")[0]}` : ""}${tail}` };
      }
      if (status === "skipped") return { ...base, kind: "skip", text: `${node} skipped` };
      if (status === "awaiting-gate") return { ...base, kind: "session", text: `${node} finished · awaiting gate${tail}` };
      return { ...base, kind: "session", text: `${node} ${status}${tail}` };
    }
    case "node.retry":
      return { ...base, kind: "start", text: `${node} retrying` };
    case "node.invalidated":
      return { ...base, kind: "info", text: `${node} reset to pending${typeof d["from"] === "string" ? ` (was ${d["from"]})` : ""}` };
    case "gate.opened":
      return { ...base, kind: "gate", text: `Paused at ${node} gate${typeof d["revision"] === "string" ? ` (revision ${d["revision"]})` : ""}` };
    case "gate.decision": {
      const action = typeof d["action"] === "string" ? d["action"] : "decision";
      return {
        ...base,
        kind: "decision",
        text: `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} recorded at ${node}${typeof d["target"] === "string" && d["target"] !== e.node ? ` → ${d["target"]}` : ""}`,
      };
    }
    case "run.status":
      return { ...base, kind: "run", text: `Run ${String(d["from"] ?? "?")} → ${String(d["to"] ?? "?")}` };
    default:
      return { ...base, kind: "info", text: e.type };
  }
}

/** Run-dir paths -> `$RUN/…`, worktree paths -> relative: keeps tool summaries short and free of the user's absolute paths. */
export function shortenPaths(text: string, runDir: string, worktreePath: string): string {
  let t = text;
  if (runDir !== "") t = t.split(`${runDir}/`).join("$RUN/").split(runDir).join("$RUN");
  if (worktreePath !== "") t = t.split(`${worktreePath}/`).join("").split(worktreePath).join("$WORKTREE");
  return t;
}

export function transcriptItems(args: {
  node: string;
  ino: number;
  lines: TailLine[];
  /** ts of the last line parsed before this batch (carry-over for ts-less lines). */
  lastTs: string | null;
  /** Used when no line has supplied a ts yet (node start time, or receipt time when live). */
  fallbackTs: string;
  shorten: (s: string) => string;
}): { items: FeedItem[]; lastTs: string | null } {
  const items: FeedItem[] = [];
  let lastTs = args.lastTs;
  for (const l of args.lines) {
    const { ts, drafts } = parseTranscriptLine(l.line);
    if (ts !== null) lastTs = ts;
    drafts.forEach((d, i) => {
      const own = ts !== null;
      items.push({
        id: `t:${args.node}:${args.ino}:${l.offset}:${i}`,
        ts: ts ?? lastTs ?? args.fallbackTs,
        kind: d.kind,
        node: args.node,
        text: args.shorten(d.text),
        ...(d.tool !== undefined ? { tool: d.tool } : {}),
        ...(own ? {} : { approx: true }),
        ...(d.truncated === true ? { truncated: true } : {}),
        source: "transcript",
      });
    });
  }
  return { items, lastTs };
}

/** Chronological order (ts, then input order), de-duplicated by id. */
export function mergeFeed(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const uniq: { item: FeedItem; n: number }[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    uniq.push({ item, n: uniq.length });
  }
  uniq.sort((a, b) => (a.item.ts < b.item.ts ? -1 : a.item.ts > b.item.ts ? 1 : a.n - b.n));
  return uniq.map((u) => u.item);
}

type StateLite = { worktreePath: string; nodes: Record<string, { startedAt?: string }> };

function readStateLite(runDir: string): StateLite | null {
  try {
    return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as StateLite;
  } catch {
    return null;
  }
}

const NODE_ID_RE = /^[A-Za-z0-9._-]+$/;

function nodeTranscriptItems(runDir: string, node: string, state: StateLite): FeedItem[] {
  if (!NODE_ID_RE.test(node)) return [];
  const path = join(runDir, node, "transcript.log");
  if (!existsSync(path)) return [];
  const offset: SseOffset = { bytesRead: 0 };
  const lines = tailLines(path, offset);
  let fallbackTs = state.nodes[node]?.startedAt;
  if (fallbackTs === undefined) {
    try {
      fallbackTs = statSync(path).mtime.toISOString();
    } catch {
      fallbackTs = new Date(0).toISOString();
    }
  }
  return transcriptItems({
    node,
    ino: offset.ino ?? 0,
    lines,
    lastTs: null,
    fallbackTs,
    shorten: (s) => shortenPaths(s, runDir, state.worktreePath),
  }).items;
}

/**
 * Feed history for page load: ALL engine events + the newest `maxTranscript`
 * transcript-derived items across every node, merged chronologically.
 * `total` = items before the transcript cap, so the client can say how many
 * older agent items are not shown.
 */
export function buildFeedHistory(
  homeDir: string,
  runId: string,
  opts: { maxTranscript?: number } = {},
): { items: FeedItem[]; total: number } {
  const max = opts.maxTranscript ?? DEFAULT_MAX_TRANSCRIPT_ITEMS;
  const runDir = join(homeDir, "runs", runId);
  const state = readStateLite(runDir);
  const events = readNewEventLines(runDir, { bytesRead: 0 }).map((e) => eventToItem(e.event, e.offset));
  const transcript: FeedItem[] = [];
  if (state !== null) {
    for (const node of Object.keys(state.nodes)) transcript.push(...nodeTranscriptItems(runDir, node, state));
  }
  const sortedTranscript = mergeFeed(transcript);
  const kept = sortedTranscript.length > max ? sortedTranscript.slice(sortedTranscript.length - max) : sortedTranscript;
  return { items: mergeFeed([...events, ...kept]), total: events.length + sortedTranscript.length };
}

/** One node's agent output (its live `transcript.log` only — archived attempts are not shown), newest `limit` items. */
export function buildNodeOutput(homeDir: string, runId: string, node: string, limit: number): FeedItem[] {
  const runDir = join(homeDir, "runs", runId);
  const state = readStateLite(runDir);
  if (state === null) return [];
  const items = mergeFeed(nodeTranscriptItems(runDir, node, state));
  return items.length > limit ? items.slice(items.length - limit) : items;
}
