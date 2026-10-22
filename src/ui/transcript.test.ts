/**
 * transcript.test.ts — parsing one `<node>/transcript.log` line (compact SDK
 * message JSON, truncated to 8 KB by sdk-runner.ts with a trailing `…}` that
 * makes it invalid JSON) into zero or more feed drafts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTranscriptLine, TRUNCATED_NOTE } from "./transcript.js";

const asst = (content: unknown[], timestamp?: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content },
    session_id: "s",
    ...(timestamp !== undefined ? { timestamp } : {}),
  });

test("assistant text block -> one `text` draft with the first meaningful line, carrying the line's timestamp", () => {
  const r = parseTranscriptLine(
    asst([{ type: "text", text: "\n\n  Found it.\nSecond line." }], "2026-01-01T00:00:01.000Z"),
  );
  assert.equal(r.ts, "2026-01-01T00:00:01.000Z");
  assert.deepEqual(r.drafts, [{ kind: "text", text: "Found it." }]);
});

test("a long first line is clipped with an ellipsis", () => {
  const r = parseTranscriptLine(asst([{ type: "text", text: "x".repeat(500) }]));
  assert.equal(r.drafts[0]?.text.length, 221);
  assert.ok(r.drafts[0]?.text.endsWith("…"));
});

test("tool_use -> `tool` draft: name + command / file_path basename / description summary", () => {
  const r = parseTranscriptLine(
    asst([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la\nsecond", description: "list" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a/b/c/Foo.java" } },
      { type: "tool_use", id: "t3", name: "Task", input: { description: "scan the repo" } },
      { type: "tool_use", id: "t4", name: "Grep", input: { pattern: "needle" } },
      { type: "tool_use", id: "t5", name: "Noop", input: {} },
    ]),
  );
  assert.deepEqual(r.drafts, [
    { kind: "tool", tool: "Bash", text: "ls -la" },
    { kind: "tool", tool: "Read", text: "Foo.java" },
    { kind: "tool", tool: "Task", text: "scan the repo" },
    { kind: "tool", tool: "Grep", text: "needle" },
    { kind: "tool", tool: "Noop", text: "" },
  ]);
});

test("thinking blocks, empty text, and non-assistant message types produce nothing", () => {
  assert.deepEqual(
    parseTranscriptLine(asst([{ type: "thinking", thinking: "secret", signature: "zz" }, { type: "text", text: "   " }])).drafts,
    [],
  );
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "user", message: { content: [] } })).drafts, []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "system", subtype: "init" })).drafts, []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "tool_progress" })).drafts, []);
});

test("a line that is not JSON at all (garbage) is skipped without throwing", () => {
  assert.deepEqual(parseTranscriptLine("not json {").drafts, []);
  assert.equal(parseTranscriptLine("not json {").ts, null);
});

test("truncated assistant line: salvages tool name + summary via regex, ts null, marked truncated", () => {
  const full = asst([
    { type: "thinking", thinking: "", signature: "S".repeat(9000) },
    { type: "tool_use", id: "t", name: "Bash", input: { command: "mvn -q test -pl zeebe", description: "d" } },
  ]);
  const cut = full.slice(0, 8192) + "…}";
  assert.throws(() => JSON.parse(cut));
  // The tool_use sits past the cut here, so nothing is salvageable: an honest note, never a silent drop.
  const r = parseTranscriptLine(cut);
  assert.equal(r.ts, null);
  assert.deepEqual(r.drafts, [{ kind: "text", text: TRUNCATED_NOTE, truncated: true }]);

  // A tool_use that is inside the surviving prefix IS salvaged.
  const early =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Plan: run it \\"now\\"\\nmore"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"mvn -q test -pl zeebe","descr…}';
  const r2 = parseTranscriptLine(early);
  assert.deepEqual(r2.drafts, [
    { kind: "text", text: 'Plan: run it "now"', truncated: true },
    { kind: "tool", tool: "Bash", text: "mvn -q test -pl zeebe", truncated: true },
  ]);
});

test("a truncated NON-assistant line (e.g. a huge tool result) is skipped silently", () => {
  assert.deepEqual(parseTranscriptLine('{"type":"user","message":{"content":[{"tool_use_id":"x","type":"tool_result","content":"aaaa…}').drafts, []);
});

test("text with HTML is passed through untouched (escaping is the renderer's job, tested there)", () => {
  const r = parseTranscriptLine(asst([{ type: "text", text: '<img src=x onerror=alert(1)>' }]));
  assert.equal(r.drafts[0]?.text, "<img src=x onerror=alert(1)>");
});

test("copilot transcript lines: assistant.message becomes text + tool drafts; every other event type is ignored, never throws", () => {
  const msg = JSON.stringify({
    type: "assistant.message",
    timestamp: "2026-10-22T14:00:00.000Z",
    data: {
      content: "Reviewing the diff now.",
      toolRequests: [{ toolCallId: "t1", name: "bash", arguments: { command: "git --no-pager diff --cached", description: "diff" } }],
    },
  });
  const r = parseTranscriptLine(msg);
  assert.equal(r.ts, "2026-10-22T14:00:00.000Z");
  assert.deepEqual(r.drafts, [
    { kind: "text", text: "Reviewing the diff now." },
    { kind: "tool", tool: "bash", text: "git --no-pager diff --cached" },
  ]);
  for (const t of ["assistant.usage", "hook.start", "subagent.started", "session.start", "dagrun.permission", "assistant.turn_start"]) {
    assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: t, data: { x: 1 } })).drafts, [], t);
  }
  // a cut (non-JSON) copilot line must not be mistaken for a cut Claude assistant line
  assert.deepEqual(parseTranscriptLine('{"type":"assistant.message","data":{"content":"abc').drafts, []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "assistant.message" })).drafts, []);
});

