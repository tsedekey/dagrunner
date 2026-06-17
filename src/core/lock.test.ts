/**
 * lock.test.ts — co-located unit tests for acquireLock / releaseLock / readLock.
 *
 * acquireLock calls process.exit(1) for two error cases — those must be tested
 * via spawnSync to avoid killing the test runner process.
 *
 * Run with:
 *   node --test --import tsx src/core/lock.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { acquireLock, releaseLock, readLock } from "./lock.js";

// ---------------------------------------------------------------------------
// Absolute path to lock.ts — needed by spawnSync helper scripts.
// tsx can import an absolute .ts path directly.
// ---------------------------------------------------------------------------

const LOCK_TS_PATH = join(dirname(fileURLToPath(import.meta.url)), "lock.ts");

// Repo root — tsx resolves from cwd, so spawnSync must use repo root as cwd.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Helper: write a tiny inline script to a temp dir and run it via spawnSync.
// Returns the spawnSync result.
// ---------------------------------------------------------------------------

function runLockScript(
  homeDir: string,
  runId: string,
): ReturnType<typeof spawnSync> {
  const scriptDir = mkdtempSync(join(tmpdir(), "dr-lock-script-"));
  const scriptPath = join(scriptDir, "acquire.mjs");
  // Import lock.ts via absolute path so tsx resolves it regardless of cwd.
  writeFileSync(
    scriptPath,
    `
import { acquireLock } from ${JSON.stringify(LOCK_TS_PATH)};
acquireLock(${JSON.stringify(homeDir)}, ${JSON.stringify(runId)});
`.trimStart(),
    "utf8",
  );
  return spawnSync("node", ["--import", "tsx", scriptPath], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Test: acquireLock creates lock file; readLock returns correct shape
// ---------------------------------------------------------------------------

test("acquireLock creates lock file and readLock returns correct shape", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));

  acquireLock(homeDir, "test-run-1");

  const lock = readLock(homeDir);
  assert.ok(lock !== null, "readLock must return a LockInfo, not null");
  assert.equal(lock.runId, "test-run-1");
  assert.equal(typeof lock.pid, "number");
  // startedAt must be an ISO string (parseable date)
  assert.ok(
    !isNaN(Date.parse(lock.startedAt)),
    `startedAt "${lock.startedAt}" must be a parseable ISO date string`,
  );
});

// ---------------------------------------------------------------------------
// Test: same-runId re-acquire succeeds and overwrites (resume path)
// ---------------------------------------------------------------------------

test("acquireLock: same-runId re-acquire overwrites without error", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));

  acquireLock(homeDir, "resume-run");
  const first = readLock(homeDir);
  assert.ok(first !== null);

  // Re-acquire same run ID — must succeed silently.
  acquireLock(homeDir, "resume-run");
  const second = readLock(homeDir);
  assert.ok(second !== null);
  assert.equal(second.runId, "resume-run");
});

// ---------------------------------------------------------------------------
// Test: different-runId while lock held → child exits 1, stderr names holding runId
// ---------------------------------------------------------------------------

test("acquireLock: different runId → exits 1 and stderr includes holding runId", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));

  // Acquire with "holder-run" first (in-process, safe).
  acquireLock(homeDir, "holder-run");

  // Attempt to acquire "intruder-run" in a child process.
  const result = runLockScript(homeDir, "intruder-run");

  assert.equal(
    result.status,
    1,
    `Expected exit code 1, got ${String(result.status)}. stderr: ${String(result.stderr)}`,
  );
  assert.ok(
    String(result.stderr).includes("holder-run"),
    `Expected stderr to include "holder-run", got: ${String(result.stderr)}`,
  );
});

// ---------------------------------------------------------------------------
// Test: corrupt lock file → child exits 1, stderr includes "corrupt or unreadable"
// ---------------------------------------------------------------------------

test("acquireLock: corrupt lock file → exits 1 and stderr says corrupt or unreadable", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));
  const lockFilePath = join(homeDir, "active.lock");

  // Write non-JSON content to simulate corruption.
  writeFileSync(lockFilePath, "this is not json\n", "utf8");

  const result = runLockScript(homeDir, "any-run");

  assert.equal(
    result.status,
    1,
    `Expected exit code 1, got ${String(result.status)}. stderr: ${String(result.stderr)}`,
  );
  assert.ok(
    String(result.stderr).includes("corrupt or unreadable"),
    `Expected "corrupt or unreadable" in stderr, got: ${String(result.stderr)}`,
  );
});

// ---------------------------------------------------------------------------
// Test: releaseLock removes the file; calling again when gone is silent
// ---------------------------------------------------------------------------

test("releaseLock: removes file; second call is silent (no throw)", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));

  acquireLock(homeDir, "release-run");
  const lockFilePath = join(homeDir, "active.lock");
  assert.ok(existsSync(lockFilePath), "lock file must exist before release");

  releaseLock(homeDir);
  assert.ok(!existsSync(lockFilePath), "lock file must be gone after release");

  // Second call must be silent (no throw).
  assert.doesNotThrow(() => releaseLock(homeDir));
});

// ---------------------------------------------------------------------------
// Test: readLock — missing file returns null
// ---------------------------------------------------------------------------

test("readLock: missing file returns null", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));
  const lock = readLock(homeDir);
  assert.equal(lock, null);
});

// ---------------------------------------------------------------------------
// Test: readLock — valid file returns LockInfo with correct runId
// ---------------------------------------------------------------------------

test("readLock: valid file returns LockInfo with correct runId", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));

  acquireLock(homeDir, "readlock-run");
  const lock = readLock(homeDir);

  assert.ok(lock !== null);
  assert.equal(lock.runId, "readlock-run");
});

// ---------------------------------------------------------------------------
// Test: readLock — corrupt file returns null (soft — readLock is lenient)
// ---------------------------------------------------------------------------

test("readLock: corrupt file returns null (soft failure)", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-lock-"));
  const lockFilePath = join(homeDir, "active.lock");

  writeFileSync(lockFilePath, "{ garbage json", "utf8");

  const lock = readLock(homeDir);
  assert.equal(lock, null, "readLock must return null for corrupt file");
});
