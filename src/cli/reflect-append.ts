/**
 * reflect-append.ts — append one reflection entry to the durable store log.
 *
 * Best-effort, fail-soft: an invalid or empty entry is a no-op (no crash, no write).
 * This is the single deliberate exception to dagrunner's fail-loud rule — capture
 * must never block shipping. See DECISIONS.md §reflect-append-fail-soft.
 *
 * Sink: <homeDir>/store/reflection-log.jsonl (one JSON object per line, durable
 * across run deletion).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReflectionEntry {
  /** Node or agent that is appending (e.g. "define", "review", "ci-babysit"). */
  source: string;
  /** The raw tip or gotcha text. */
  body: string;
  /** Optional run id for traceability — does not scope storage. */
  run_id?: string;
}

// ---------------------------------------------------------------------------
// appendReflection
// ---------------------------------------------------------------------------

/**
 * Append one JSONL entry to <homeDir>/store/reflection-log.jsonl.
 *
 * Fail-soft: returns silently (no throw) if body is empty or blank.
 * The store dir is created on first write.
 */
export function appendReflection(
  homeDir: string,
  entry: ReflectionEntry,
): void {
  if (!entry.body || entry.body.trim() === "") {
    return;
  }

  const logFile = join(homeDir, "store", "reflection-log.jsonl");
  mkdirSync(dirname(logFile), { recursive: true });

  const record: Record<string, string> = {
    ts: new Date().toISOString(),
    source: entry.source,
    body: entry.body,
  };
  if (entry.run_id !== undefined) {
    record["run_id"] = entry.run_id;
  }

  appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
}
