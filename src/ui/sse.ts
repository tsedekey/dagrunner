/**
 * sse.ts — Server-Sent Events framing + an incremental file tailer.
 *
 * `formatSse` is pure text framing (unit-tested in isolation). `tailLines` is
 * the generic path-based tailer (events.jsonl AND per-node transcript.log use
 * it); `readNewEvents` is its events.jsonl convenience wrapper. A tail
 * tracks a byte offset so a live-tailing connection only reads what
 * was appended since it last looked, and never chokes on a torn in-flight
 * append: it only consumes up to the last complete `\n` in the new bytes,
 * leaving a partial tail line for the next read. A file that shrank (rotated,
 * or a fresh run reusing a run id after `dagrun clear`) resets the offset to 0
 * rather than throwing. Malformed lines are skipped, exactly like
 * `core/events.ts`'s `readEvents` — read-only, never fails a caller.
 */

import { existsSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../core/events.js";

export type SseOffset = { bytesRead: number; ino?: number };

/** One SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment line — used as a heartbeat/keep-alive; ignored by EventSource as an event. */
export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}

export type TailLine = {
  /** One complete line, without its trailing newline. */
  line: string;
  /** Byte offset of the line's first byte within the file (stable id material). */
  offset: number;
};

/**
 * Generic file tailer: the complete lines appended to `path` since
 * `offset.bytesRead`, updating `offset` in place. Complete-lines-only (a torn
 * in-flight append is left for the next call), shrink -> reset to 0, and an
 * inode change -> reset to 0 (a rotated/archived-and-recreated file can have
 * grown PAST the old offset before the next poll, which a size check alone
 * would misread as "mid-file"). Missing file / unreadable / no growth -> [].
 * Never throws: a read-only observer must not take the server down.
 */
export function tailLines(path: string, offset: SseOffset): TailLine[] {
  if (!existsSync(path)) return [];
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const st = fstatSync(fd);
    if (offset.ino !== undefined && offset.ino !== st.ino) {
      offset.bytesRead = 0; // different file under the same name (rerun archived the old one)
    }
    offset.ino = st.ino;
    const size = st.size;
    if (size < offset.bytesRead) {
      // File shrank (truncated/replaced) — re-read from the start.
      offset.bytesRead = 0;
    }
    if (size <= offset.bytesRead) return [];
    const len = size - offset.bytesRead;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, offset.bytesRead);
    const lastNewline = buf.subarray(0, n).lastIndexOf(0x0a);
    if (lastNewline === -1) return []; // no complete line yet — leave offset untouched
    const complete = buf.subarray(0, lastNewline).toString("utf8");
    const out: TailLine[] = [];
    let pos = offset.bytesRead;
    for (const line of complete.split("\n")) {
      if (line.trim() !== "") out.push({ line, offset: pos });
      pos += Buffer.byteLength(line, "utf8") + 1; // +1 for the newline itself
    }
    offset.bytesRead += lastNewline + 1;
    return out;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** Move `offset` to the end of the last complete line without returning anything. */
export function fastForward(path: string, offset: SseOffset): void {
  tailLines(path, offset);
}

/**
 * Read whatever complete lines were appended to `events.jsonl` since
 * `offset.bytesRead`, updating `offset` in place. Returns [] for a missing
 * file (nothing written yet) or no growth. Never throws.
 */
export function readNewEvents(runDir: string, offset: SseOffset): RunEvent[] {
  return readNewEventLines(runDir, offset).map((e) => e.event);
}

/** Like `readNewEvents` but keeps each event's byte offset (stable feed-item ids). */
export function readNewEventLines(
  runDir: string,
  offset: SseOffset,
): { event: RunEvent; offset: number }[] {
  const out: { event: RunEvent; offset: number }[] = [];
  for (const l of tailLines(join(runDir, "events.jsonl"), offset)) {
    try {
      out.push({ event: JSON.parse(l.line) as RunEvent, offset: l.offset });
    } catch {
      // torn/garbled line — skip, never throw from a read-only observer
    }
  }
  return out;
}
