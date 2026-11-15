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
// Liveness (the ONLY liveness mechanism: the lock's pid)
// ---------------------------------------------------------------------------

/** True when `pid` names a running process (signal 0; EPERM means alive but not ours). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lock, if and only if it names `runId`, its pid is alive, and it is not
 * this process — i.e. ANOTHER driver is actively running this run. Null for no
 * lock, a different run's lock, our own lock, or a stale (dead-pid) lock.
 */
export function liveDriver(homeDir: string, runId: string): LockInfo | null {
  const l = readLock(homeDir);
  if (l === null || l.runId !== runId) return null;
  if (l.pid === process.pid || !isPidAlive(l.pid)) return null;
  return l;
}

/** Fail loud (exit 1) when another live process is already driving `runId`. */
export function assertNoLiveDriver(homeDir: string, runId: string): void {
  const live = liveDriver(homeDir, runId);
  if (live === null) return;
  process.stderr.write(
    `dagrun: run ${runId} is already being driven by pid ${live.pid} (since ${live.startedAt}) — refusing a second driver. ` +
      `Poll: dagrun status ${runId} --json\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

/**
 * Exit 1 (loud) unless `runId` may take the lock: no lock, or a same-run lock
 * that is ours or stale (dead pid — recovered by overwriting). Refused: a corrupt
 * lock, a different run's lock (even a stale one — --force releases it), and a
 * same-run lock held by another LIVE process. Read-only; used by acquireLock and
 * by `--detach` parents, which must not take the lock but must not lie about
 * success when the child would be refused.
 */
export function assertLockAvailable(homeDir: string, runId: string): void {
  const path = lockPath(homeDir);
  if (!existsSync(path)) return;
  const existing = readLock(homeDir);
  if (existing === null) {
    // File exists but is unparseable — fatal; don't silently overwrite.
    process.stderr.write(
      `dagrun: active.lock at "${path}" is corrupt or unreadable — remove it manually.\n`,
    );
    process.exit(1);
  }
  if (existing.runId !== runId) {
    process.stderr.write(
      `dagrun: active run: ${existing.runId} (pid ${existing.pid}), use --force to override.\n`,
    );
    process.exit(1);
  }
  // Same runId: allowed (resume) unless another LIVE process holds it.
  // A dead pid is a stale lock left by a crash — recovered by overwriting.
  assertNoLiveDriver(homeDir, runId);
}

/**
 * Write active.lock claiming the run.
 *
 * Fails loud if a lock already exists for a DIFFERENT runId.
 * Same-run re-acquire is allowed (resume path).
 */
export function acquireLock(homeDir: string, runId: string): void {
  assertLockAvailable(homeDir, runId);

  const info: LockInfo = {
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(lockPath(homeDir), JSON.stringify(info, null, 2) + "\n", "utf8");
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
