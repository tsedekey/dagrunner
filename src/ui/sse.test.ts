/**
 * sse.test.ts — SSE frame formatting, and the incremental events.jsonl tail
 * reader: only complete lines, torn appends leave a partial tail for later,
 * shrinkage resets the offset, malformed lines are skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  formatSse,
  formatSseComment,
  readNewEvents,
  type SseOffset,
} from "./sse.js";

test("formatSse frames an event and its JSON payload", () => {
  const frame = formatSse("snapshot", { a: 1 });
  assert.equal(frame, 'event: snapshot\ndata: {"a":1}\n\n');
});

test("formatSseComment frames a heartbeat comment line", () => {
  assert.equal(formatSseComment("ping"), ": ping\n\n");
});

function tempRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dr-ui-sse-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("readNewEvents: missing events.jsonl returns [] without throwing", () => {
  const dir = tempRunDir();
  const offset: SseOffset = { bytesRead: 0 };
  assert.deepEqual(readNewEvents(dir, offset), []);
  assert.equal(offset.bytesRead, 0);
});

test("readNewEvents: reads only what was appended since the last offset", () => {
  const dir = tempRunDir();
  const file = join(dir, "events.jsonl");
  writeFileSync(file, JSON.stringify({ ts: "t1", type: "run.started" }) + "\n");
  const offset: SseOffset = { bytesRead: 0 };
  const first = readNewEvents(dir, offset);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.type, "run.started");

  assert.deepEqual(readNewEvents(dir, offset), [], "no new bytes yet");

  appendFileSync(
    file,
    JSON.stringify({ ts: "t2", type: "node.started", node: "fix" }) + "\n",
  );
  const second = readNewEvents(dir, offset);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.node, "fix");
});

test("readNewEvents: an in-flight torn append is not consumed until the newline lands", () => {
  const dir = tempRunDir();
  const file = join(dir, "events.jsonl");
  writeFileSync(file, JSON.stringify({ ts: "t1", type: "run.started" }) + "\n");
  const offset: SseOffset = { bytesRead: 0 };
  readNewEvents(dir, offset); // consume the first complete line

  // Simulate a partial write: half a JSON line, no trailing newline yet.
  const fd = openSync(file, "a");
  writeSync(fd, '{"ts":"t2","type":"node.st');
  closeSync(fd);

  assert.deepEqual(
    readNewEvents(dir, offset),
    [],
    "torn line must not be consumed yet",
  );

  // Now the writer completes the line.
  const fd2 = openSync(file, "a");
  writeSync(fd2, 'arted","node":"fix"}\n');
  closeSync(fd2);

  const completed = readNewEvents(dir, offset);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.type, "node.started");
});

test("readNewEvents: a malformed line is skipped, not thrown", () => {
  const dir = tempRunDir();
  const file = join(dir, "events.jsonl");
  writeFileSync(
    file,
    "{ not json }\n" + JSON.stringify({ ts: "t2", type: "run.status" }) + "\n",
  );
  const offset: SseOffset = { bytesRead: 0 };
  const events = readNewEvents(dir, offset);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "run.status");
});

test("readNewEvents: a shrunk file resets the offset instead of throwing", () => {
  const dir = tempRunDir();
  const file = join(dir, "events.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      ts: "t1",
      type: "run.started",
      detail: { long: "xxxxxxxxxxxxxxxx" },
    }) + "\n",
  );
  const offset: SseOffset = { bytesRead: 0 };
  readNewEvents(dir, offset);
  assert.ok(offset.bytesRead > 0);

  // Truncate + replace with a strictly SHORTER file (e.g. a re-cleared run reusing the dir).
  writeFileSync(file, JSON.stringify({ ts: "t0", type: "run.started" }) + "\n");
  const after = readNewEvents(dir, offset);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.ts, "t0");
});
