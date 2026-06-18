/**
 * session-end.test.ts — deterministic test for the SessionEnd hook script.
 *
 * Invokes .claude/hooks/session-end.sh directly in a temp environment.
 * No SDK, no model. Runs under npm test (Tier-1 / verify-baseline).
 *
 * Mechanism tested:
 *   reflections.md (non-empty) → one stamped entry in reflection-log.jsonl
 *   reflections.md (absent / empty) → no entry (best-effort, not required)
 *
 * Wiring is exercised by smoke:live (option b seeded run, deterministic).
 * This test proves script logic; smoke:live proves the hook fires in a real session.
 *
 * Teeth-check: comment out the "reflection capture" block in session-end.sh
 * (lines ~137-181) → the first test below goes red at the logPath assertion.
 * Restore it → green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "..", ".claude", "hooks", "session-end.sh");

const FAKE_EVENT = JSON.stringify({
  session_id: "sess-test-001",
  cost_usd: 0.0042,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeTmpDirs() {
  const base = join(tmpdir(), `dagrun-hook-test-${process.pid}-${++counter}`);
  const runDir = join(base, "run");
  const artifactsDir = join(base, "artifacts");
  const storeDir = join(base, "store");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  return { base, runDir, artifactsDir, storeDir };
}

function cleanup(base: string) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function runHook(env: Record<string, string>, input: string = FAKE_EVENT) {
  return spawnSync("bash", [HOOK], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("session-end hook: seeded reflections.md → one stamped entry in reflection-log.jsonl", () => {
  const { base, runDir, artifactsDir, storeDir } = makeTmpDirs();
  try {
    writeFileSync(
      join(artifactsDir, "reflections.md"),
      "## Note\nTest reflection content.",
      "utf8",
    );
    const result = runHook({
      DAGRUN_RUN_DIR: runDir,
      DAGRUN_NODE_ID: "pr",
      DAGRUN_ARTIFACTS: artifactsDir,
      DAGRUN_STORE_DIR: storeDir,
      DAGRUN_RUN_ID: "run-test-001",
    });
    assert.strictEqual(
      result.status,
      0,
      `hook must exit 0; stderr: ${result.stderr}`,
    );
    const logPath = join(storeDir, "reflection-log.jsonl");
    assert.ok(existsSync(logPath), "reflection-log.jsonl must be created");
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert.strictEqual(lines.length, 1, "exactly one entry expected");
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.ok(
      typeof entry["ts"] === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry["ts"] as string),
      `ts must be ISO8601, got: ${String(entry["ts"])}`,
    );
    assert.strictEqual(
      entry["source"],
      "pr",
      "source must equal DAGRUN_NODE_ID",
    );
    assert.strictEqual(
      entry["run_id"],
      "run-test-001",
      "run_id must match DAGRUN_RUN_ID",
    );
    assert.ok(
      typeof entry["body"] === "string" &&
        (entry["body"] as string).includes("Test reflection"),
      "body must contain the seeded reflection content",
    );
  } finally {
    cleanup(base);
  }
});

test("session-end hook: empty reflections.md → no entry (best-effort)", () => {
  const { base, runDir, artifactsDir, storeDir } = makeTmpDirs();
  try {
    writeFileSync(join(artifactsDir, "reflections.md"), "", "utf8");
    runHook({
      DAGRUN_RUN_DIR: runDir,
      DAGRUN_NODE_ID: "expand",
      DAGRUN_ARTIFACTS: artifactsDir,
      DAGRUN_STORE_DIR: storeDir,
    });
    const logPath = join(storeDir, "reflection-log.jsonl");
    assert.ok(
      !existsSync(logPath),
      "no reflection-log.jsonl for empty reflections.md — best-effort",
    );
  } finally {
    cleanup(base);
  }
});

test("session-end hook: absent reflections.md → no entry (best-effort)", () => {
  const { base, runDir, artifactsDir, storeDir } = makeTmpDirs();
  try {
    // No reflections.md written
    runHook({
      DAGRUN_RUN_DIR: runDir,
      DAGRUN_NODE_ID: "implement",
      DAGRUN_ARTIFACTS: artifactsDir,
      DAGRUN_STORE_DIR: storeDir,
    });
    const logPath = join(storeDir, "reflection-log.jsonl");
    assert.ok(
      !existsSync(logPath),
      "no reflection-log.jsonl when reflections.md is absent — best-effort",
    );
  } finally {
    cleanup(base);
  }
});

test("session-end hook: DAGRUN_RUN_ID absent → no run_id field in entry", () => {
  const { base, runDir, artifactsDir, storeDir } = makeTmpDirs();
  try {
    writeFileSync(
      join(artifactsDir, "reflections.md"),
      "Some reflection without run id.",
      "utf8",
    );
    runHook({
      DAGRUN_RUN_DIR: runDir,
      DAGRUN_NODE_ID: "review",
      DAGRUN_ARTIFACTS: artifactsDir,
      DAGRUN_STORE_DIR: storeDir,
      // Intentionally no DAGRUN_RUN_ID
    });
    const logPath = join(storeDir, "reflection-log.jsonl");
    assert.ok(existsSync(logPath), "reflection-log.jsonl must exist");
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<
      string,
      unknown
    >;
    assert.ok(
      !("run_id" in entry),
      "run_id must not be present when DAGRUN_RUN_ID is absent",
    );
  } finally {
    cleanup(base);
  }
});

test("session-end hook: friction.jsonl written alongside reflection capture", () => {
  const { base, runDir, artifactsDir, storeDir } = makeTmpDirs();
  try {
    writeFileSync(
      join(artifactsDir, "reflections.md"),
      "Friction test reflection.",
      "utf8",
    );
    runHook({
      DAGRUN_RUN_DIR: runDir,
      DAGRUN_NODE_ID: "fix",
      DAGRUN_ARTIFACTS: artifactsDir,
      DAGRUN_STORE_DIR: storeDir,
    });
    const frictionPath = join(runDir, "friction.jsonl");
    assert.ok(existsSync(frictionPath), "friction.jsonl must be written");
    const frictionEntry = JSON.parse(
      readFileSync(frictionPath, "utf8").trim(),
    ) as Record<string, unknown>;
    assert.strictEqual(frictionEntry["event"], "session-end");
    assert.strictEqual(frictionEntry["node"], "fix");
    assert.ok(
      typeof frictionEntry["costUsd"] === "number",
      "costUsd must be a number",
    );
  } finally {
    cleanup(base);
  }
});

test("session-end hook: exit 0 with unset DAGRUN_RUN_DIR (silent no-op)", () => {
  const result = runHook({
    DAGRUN_RUN_DIR: "",
    DAGRUN_NODE_ID: "",
  });
  assert.strictEqual(result.status, 0, "must exit 0 even with unset env vars");
});
