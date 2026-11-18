/**
 * payload-frontmatter.test.ts — every command dagrunner seeds into a worktree's
 * .claude/commands/ has frontmatter a STRICT YAML reader accepts.
 *
 * Claude Code retries a bad header leniently; Copilot CLI does not. It parses the header as
 * YAML, drops the command with "Skill load error: …" and shows a warning at every session
 * start in that worktree. Seeding copies payload/ verbatim, so one bad header here is
 * re-planted in every worktree (v0.1.90 repaired three: ci-babysit's description held ': ',
 * manual-smoke's and seed-data's argument-hint began with an unquoted '[…]').
 *
 * dagrunner takes no YAML dependency, so frontmatterProblems() is a deliberately strict
 * SUBSET checker: single-line `key: value`, the value either a quoted string or a plain
 * scalar YAML reads as text. A header it rejects may still be valid YAML; quote the value
 * (or put it on one line) rather than loosening the checker.
 *
 * Run with:
 *   node --test --import tsx src/runtime/payload-frontmatter.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PAYLOAD = new URL("../../payload/", import.meta.url).pathname;

/** Payload folders that are copied into a worktree's .claude/commands/. */
const COMMAND_DIRS = ["commands", join("siblings", "commands")];

const KEY_LINE = /^([A-Za-z][\w-]*):(?: +(.*))?$/;

/** A plain value starting like this is a YAML indicator (flow collection, anchor, tag, block scalar, list item…). */
const PLAIN_START = /^(?:[[\]{},#&*!|>%@`]|[-?:](?: |$))/;

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").replace(/\r$/, "");
}

/** Why `value` would not load as a string under a strict YAML reader, or null when it would. */
function valueProblem(value: string): string | null {
  if (value === "") return null;
  if (value.startsWith('"')) {
    try {
      JSON.parse(value);
      return null;
    } catch {
      return 'double-quoted value is not one complete string (escape a quote or backslash inside it with a backslash)';
    }
  }
  if (value.startsWith("'")) {
    return /^'(?:[^']|'')*'$/.test(value)
      ? null
      : "single-quoted value is not one complete string (double a quote inside it: '')";
  }
  if (value.startsWith("[") || value.startsWith("{")) {
    return "starts with a YAML list/map bracket, so it is not a string; double-quote it";
  }
  if (PLAIN_START.test(value)) {
    return `starts with '${value.slice(0, 1)}', a YAML indicator; double-quote the value`;
  }
  if (/: |:$/.test(value)) {
    return "contains ': ', which YAML reads as a nested mapping; double-quote the value";
  }
  return null;
}

/** Problems that stop a strict YAML reader loading this command's header. Empty when it loads, or when there is no header. */
function frontmatterProblems(text: string): string[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== "---") return []; // no header: the whole file is the prompt

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "---") {
      close = i;
      break;
    }
    if (/^-{4,}$/.test(line)) {
      return [
        `line ${i + 1} is ${line.length} dashes, not a bare '---': a Markdown formatter turned the header into a setext heading`,
      ];
    }
  }
  if (close === -1) return ["frontmatter never closes with a bare '---' line"];

  const problems: string[] = [];
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const m = KEY_LINE.exec(line);
    if (!m) {
      problems.push(
        `line ${i + 1}: not a single-line 'key: value' (${JSON.stringify(line.slice(0, 40))})`,
      );
      continue;
    }
    const why = valueProblem((m[2] ?? "").trim());
    if (why) problems.push(`line ${i + 1} (${m[1] ?? ""}): ${why}`);
  }
  return problems;
}

test("frontmatterProblems: accepts headers a strict YAML reader loads", () => {
  const ok = [
    "no frontmatter at all, just the prompt\n",
    '---\ndescription: "Babysit CI — one tick: poll checks"\nargument-hint: "[run-id]"\n---\n\nbody\n',
    "---\ndescription: Read-only review (never posts) — NEVER modifies code\nargument-hint: <github-pr-url-or-number>\n---\nbody\n",
    "---\ndescription: 'it''s a single-quoted: value'\n---\nbody\n",
    '---\ndescription: "say \\"hi\\""\n---\nbody\n',
    "---\r\ndescription: CRLF line endings are fine\r\n---\r\nbody\r\n",
  ];
  for (const text of ok) assert.deepEqual(frontmatterProblems(text), [], text);
});

test("frontmatterProblems: names each way a header stops loading", () => {
  const bad: Array<[string, string, RegExp]> = [
    [
      "': ' inside a plain value (ci-babysit)",
      "---\ndescription: Babysit CI — one incremental tick: poll checks\n---\nbody\n",
      /line 2 \(description\): contains ': '/,
    ],
    [
      "unquoted [run-id] is a list, not a string (manual-smoke)",
      "---\ndescription: x\nargument-hint: [run-id]\n---\nbody\n",
      /line 3 \(argument-hint\): starts with a YAML list\/map bracket/,
    ],
    [
      "unquoted list followed by more text (seed-data)",
      "---\nargument-hint: [path/to/spec.json] [--profile <name>]\n---\nbody\n",
      /list\/map bracket/,
    ],
    [
      "closing line stretched by a Markdown formatter (pr-review, seed-data)",
      "---\n\ndescription: x\nargument-hint: <url>\n-------------------\n\n# body\n",
      /line 5 is 19 dashes.*setext heading/,
    ],
    [
      "header that never closes",
      "---\ndescription: x\n\n# body\n",
      /never closes/,
    ],
    [
      "double quote that is never closed",
      '---\ndescription: "oops\n---\nbody\n',
      /double-quoted value is not one complete string/,
    ],
    [
      "multi-line value",
      "---\ndescription: >\n  folded text\n---\nbody\n",
      /starts with '>'|not a single-line/,
    ],
  ];
  for (const [name, text, expected] of bad) {
    assert.match(frontmatterProblems(text).join("\n"), expected, name);
  }
});

test("payload: every seeded command's frontmatter loads under a strict YAML reader", () => {
  const found: string[] = [];
  let scanned = 0;
  let withHeader = 0;
  for (const dir of COMMAND_DIRS) {
    const names = readdirSync(join(PAYLOAD, dir))
      .filter((n) => n.endsWith(".md"))
      .sort();
    for (const name of names) {
      const text = readFileSync(join(PAYLOAD, dir, name), "utf8");
      scanned++;
      if (firstLine(text) === "---") withHeader++;
      for (const p of frontmatterProblems(text)) {
        found.push(`payload/${dir}/${name}: ${p}`);
      }
    }
  }
  // Guards against a moved folder making this test pass by scanning nothing.
  assert.ok(scanned > 0, "no payload commands found; did payload/ move?");
  assert.ok(withHeader > 0, "no payload command has frontmatter; is the check still looking at the header?");
  assert.deepEqual(found, [], `strict-YAML problems:\n${found.join("\n")}`);
});
