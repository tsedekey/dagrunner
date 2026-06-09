/**
 * lock.ts — global active.lock for dagrunner.
 *
 * Ensures only one run is active at a time.
 * Lock file: <homeDir>/active.lock
 * Content: JSON { runId, pid, startedAt }
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LockInfo = {
  runId: string;
  pid: number;
  startedAt: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lockPath(homeDir: string): string {
  return join(homeDir, "active.lock");
}

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

/**
 * Write active.lock claiming the run.
 *
 * Fails loud if a lock already exists for a DIFFERENT runId.
 * Same-run re-acquire is allowed (resume path).
 */
export function acquireLock(homeDir: string, runId: string): void {
  const path = lockPath(homeDir);

  if (existsSync(path)) {
    const existing = readLock(homeDir);
    if (existing !== null && existing.runId !== runId) {
      process.stderr.write(
        `dagrun: active run: ${existing.runId} (pid ${existing.pid}), use --force to override.\n`,
      );
      process.exit(1);
    }
    // Same runId — allowed (resume). Fall through to overwrite.
  }

  const info: LockInfo = {
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(info, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

/**
 * Remove active.lock. Silent if the file is already gone.
 */
export function releaseLock(homeDir: string): void {
  const path = lockPath(homeDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// readLock
// ---------------------------------------------------------------------------

/**
 * Read and parse active.lock. Returns null if the file does not exist.
 */
export function readLock(homeDir: string): LockInfo | null {
  const path = lockPath(homeDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}
