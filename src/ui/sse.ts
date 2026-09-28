/**
 * sse.ts — Server-Sent Events framing + an incremental `events.jsonl` reader.
 *
 * `formatSse` is pure text framing (unit-tested in isolation). `readNewEvents`
 * tracks a byte offset per run so a live-tailing connection only reads what
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

export type SseOffset = { bytesRead: number };

/** One SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment line — used as a heartbeat/keep-alive; ignored by EventSource as an event. */
export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Read whatever complete lines were appended to `events.jsonl` since
 * `offset.bytesRead`, updating `offset` in place. Returns [] for a missing
 * file (nothing written yet) or no growth. Never throws.
 */
export function readNewEvents(runDir: string, offset: SseOffset): RunEvent[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    if (size < offset.bytesRead) {
      // File shrank (truncated/replaced) — re-read from the start next time.
      offset.bytesRead = 0;
    }
    if (size <= offset.bytesRead) return [];
    const len = size - offset.bytesRead;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, offset.bytesRead);
    const chunk = buf.subarray(0, n).toString("utf8");
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline === -1) return []; // no complete line yet — leave offset untouched
    const complete = chunk.slice(0, lastNewline);
    offset.bytesRead += Buffer.byteLength(complete, "utf8") + 1; // +1 for the newline itself
    const out: RunEvent[] = [];
    for (const line of complete.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as RunEvent);
      } catch {
        // torn/garbled line — skip, never throw from a read-only observer
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}
