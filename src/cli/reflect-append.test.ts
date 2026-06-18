/**
 * reflect-append.test.ts — TDD unit tests for the reflect-append module.
 *
 * Written BEFORE the implementation (red → green TDD).
 * Run with: node --test --import tsx src/cli/reflect-append.test.ts
 *
 * Teeth check: break a branch → test goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendReflection, type ReflectionEntry } from "./reflect-append.js";

// ---------------------------------------------------------------------------
// Helper: isolated temp dir for each test
// ---------------------------------------------------------------------------

let counter = 0;
function makeTmpHome(): string {
  const dir = join(tmpdir(), `dagrun-reflect-test-${process.pid}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

const LOG_NAME = "store/reflection-log.jsonl";

function logPath(homeDir: string): string {
  return join(homeDir, LOG_NAME);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("reflect-append: creates store dir and file if absent", () => {
  const home = makeTmpHome();
  try {
    const entry: ReflectionEntry = {
      source: "expand",
      kind: "dagrunner-harness",
      body: "guide.md needs more error-handling guidance",
    };
    appendReflection(home, entry);
    assert.ok(
      existsSync(logPath(home)),
      "reflection-log.jsonl must be created",
    );
  } finally {
    cleanup(home);
  }
});

test("reflect-append: written line is valid JSON (one-line JSONL)", () => {
  const home = makeTmpHome();
  try {
    appendReflection(home, {
      source: "review",
      kind: "camunda-knowledge",
      body: "Module X has a hidden coupling to Y",
    });
    const raw = readFileSync(logPath(home), "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "must produce exactly one line");
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(lines[0] as string);
    }, "line must be valid JSON");
    assert.ok(typeof parsed === "object" && parsed !== null);
  } finally {
    cleanup(home);
  }
});

test("reflect-append: entry has required fields ts, source, kind, body", () => {
  const home = makeTmpHome();
  try {
    appendReflection(home, {
      source: "fix",
      kind: "dagrunner-harness",
      body: "Formatter hook changed additional files",
    });
    const obj = JSON.parse(
      readFileSync(logPath(home), "utf8").trim(),
    ) as Record<string, unknown>;
    assert.ok(
      typeof obj["ts"] === "string" && obj["ts"].length > 0,
      "ts must be a non-empty string",
    );
    assert.equal(obj["source"], "fix");
    assert.equal(obj["kind"], "dagrunner-harness");
    assert.equal(obj["body"], "Formatter hook changed additional files");
  } finally {
    cleanup(home);
  }
});

test("reflect-append: run_id is written when provided", () => {
  const home = makeTmpHome();
  try {
    appendReflection(home, {
      source: "pr",
      kind: "camunda-knowledge",
      body: "PR body format",
      run_id: "run-abc-123",
    });
    const obj = JSON.parse(
      readFileSync(logPath(home), "utf8").trim(),
    ) as Record<string, unknown>;
    assert.equal(obj["run_id"], "run-abc-123");
  } finally {
    cleanup(home);
  }
});

test("reflect-append: run_id absent when not provided", () => {
  const home = makeTmpHome();
  try {
    appendReflection(home, {
      source: "pr",
      kind: "camunda-knowledge",
      body: "tip without run id",
    });
    const obj = JSON.parse(
      readFileSync(logPath(home), "utf8").trim(),
    ) as Record<string, unknown>;
    assert.ok(
      !("run_id" in obj),
      "run_id must not be present when not provided",
    );
  } finally {
    cleanup(home);
  }
});

test("reflect-append: append is additive — second call adds a second line", () => {
  const home = makeTmpHome();
  try {
    appendReflection(home, {
      source: "expand",
      kind: "dagrunner-harness",
      body: "first tip",
    });
    appendReflection(home, {
      source: "review",
      kind: "camunda-knowledge",
      body: "second tip",
    });
    const lines = readFileSync(logPath(home), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 2, "two appends must produce two lines");
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
    assert.equal(first["body"], "first tip");
    assert.equal(second["body"], "second tip");
  } finally {
    cleanup(home);
  }
});

test("reflect-append: fail-soft on missing body — does not throw, does not write", () => {
  const home = makeTmpHome();
  try {
    // Pass an entry with an empty body — should be a no-op, not a crash.
    assert.doesNotThrow(() => {
      appendReflection(home, {
        source: "expand",
        kind: "dagrunner-harness",
        body: "",
      });
    });
    // File should not be created for an empty-body entry.
    assert.ok(
      !existsSync(logPath(home)),
      "empty body must be a no-op — file must not be created",
    );
  } finally {
    cleanup(home);
  }
});

test("reflect-append: teeth — omitting ts from read object fails (validate schema)", () => {
  // Validate the shape of what we expect: a real entry has ts.
  // This is a canary: if the module stopped writing ts, the field-presence test
  // above would catch it — but we also assert the parsed value is an ISO string.
  const home = makeTmpHome();
  try {
    appendReflection(home, {
      source: "implement",
      kind: "dagrunner-harness",
      body: "canary entry",
    });
    const obj = JSON.parse(
      readFileSync(logPath(home), "utf8").trim(),
    ) as Record<string, unknown>;
    // ts must look like an ISO 8601 timestamp.
    const ts = obj["ts"] as string;
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts),
      `ts must be ISO 8601, got: ${ts}`,
    );
  } finally {
    cleanup(home);
  }
});
