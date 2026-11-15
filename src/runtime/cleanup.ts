/**
 * cleanup.ts — `dagrun cleanup <run-id>` / `dagrun cleanup --all`.
 *
 * Two kinds of run, told apart by `state.worktreeOrigin`:
 *   - "adopted": the worktree was created by someone else (e.g. `wm add`) and
 *     dagrunner only ran inside it. Cleanup RELEASES the run (lock) and leaves
 *     the worktree and branch alone, pointing at the owner's remove command.
 *   - absent (legacy): dagrunner created the worktree under
 *     `<home>/worktrees/<run-id>` with `git worktree add`; cleanup still removes
 *     it with `git worktree remove --force`.
 *
 * `--all` walks `<home>/runs/*\/state.json` and acts only on a path a state.json
 * records — never on a directory listing of a worktree root.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { releaseLock } from "../core/lock.js";
import { readState, type RunState } from "../core/state.js";

type Io = {
  out?: (s: string) => void;
  err?: (s: string) => void;
};

export type CleanupOpts = Io & {
  homeDir: string;
  /** DEVHARNESS_SRC — git must run in the source repo to find a legacy worktree's registration. */
  devharnessSrc: string;
  /** Test seam; default = `git worktree remove <path> --force` in devharnessSrc. */
  removeWorktree?: (worktreePath: string, devharnessSrc: string) => void;
};

function defaultRemoveWorktree(
  worktreePath: string,
  devharnessSrc: string,
): void {
  execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
    cwd: devharnessSrc,
    stdio: "inherit",
  });
}

const stdout = (s: string): void => void process.stdout.write(s);
const stderr = (s: string): void => void process.stderr.write(s);

function releasedLine(state: RunState): string {
  return (
    `dagrun: run ${state.runId} released. The worktree is yours: remove it with: ` +
    `wm rm ${basename(state.worktreePath)}\n`
  );
}

/** Legacy worktree removal. True on success; failure is reported on `err`, never thrown. */
function removeLegacy(state: RunState, opts: CleanupOpts): boolean {
  const remove = opts.removeWorktree ?? defaultRemoveWorktree;
  try {
    // Must run in the source repo so git can find the worktree registration.
    remove(state.worktreePath, opts.devharnessSrc);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (opts.err ?? stderr)(
      `dagrun cleanup: failed to remove ${state.worktreePath}: ${msg}\n`,
    );
    return false;
  }
}

/**
 * Clean up one run (caller has checked that its state.json exists).
 * Adopted → release only. Legacy → remove the worktree; a failing `git worktree
 * remove` is logged and does not block the lock release (unchanged behaviour).
 */
export function cleanupRun(
  opts: CleanupOpts & { runId: string },
): "removed" | "released" {
  const out = opts.out ?? stdout;
  const state = readState(join(opts.homeDir, "runs", opts.runId, "state.json"));

  if (state.worktreeOrigin === "adopted") {
    releaseLock(opts.homeDir);
    out(releasedLine(state));
    return "released";
  }

  const remove = opts.removeWorktree ?? defaultRemoveWorktree;
  try {
    remove(state.worktreePath, opts.devharnessSrc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (opts.err ?? stderr)(
      `dagrun cleanup: git worktree remove failed: ${msg}\n`,
    );
    // Continue — don't block lock release on git failure.
  }
  releaseLock(opts.homeDir);
  out(`dagrun: cleaned up ${opts.runId}\n`);
  return "removed";
}

export type CleanupAllResult = {
  removed: number;
  released: number;
  skipped: number;
  failed: number;
};

/**
 * Clean up every run recorded under `<home>/runs/*\/state.json`: adopted runs
 * are released, legacy runs have their worktree removed, runs whose worktree no
 * longer exists (or whose state.json is unreadable) are skipped. Releases the
 * lock once at the end, as before.
 */
export function cleanupAll(opts: CleanupOpts): CleanupAllResult {
  const out = opts.out ?? stdout;
  const err = opts.err ?? stderr;
  const result: CleanupAllResult = {
    removed: 0,
    released: 0,
    skipped: 0,
    failed: 0,
  };

  const runsDir = join(opts.homeDir, "runs");
  const ids = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];
  let seen = 0;
  for (const id of ids) {
    const stateFile = join(runsDir, id, "state.json");
    if (!existsSync(stateFile)) continue; // not a run (or a --detach pre-claimed dir)
    seen++;
    let state: RunState;
    try {
      state = readState(stateFile);
    } catch (e) {
      err(
        `dagrun cleanup: skipping ${id}: unreadable state.json (${String(e)})\n`,
      );
      result.skipped++;
      continue;
    }
    if (!existsSync(state.worktreePath)) {
      out(
        `dagrun: skipped ${id} — worktree ${state.worktreePath} no longer exists\n`,
      );
      result.skipped++;
      continue;
    }
    if (state.worktreeOrigin === "adopted") {
      out(releasedLine(state));
      result.released++;
    } else if (removeLegacy(state, opts)) {
      result.removed++;
    } else {
      result.failed++;
    }
  }

  if (seen === 0) {
    out("dagrun: no runs to clean up\n");
    return result;
  }
  releaseLock(opts.homeDir);
  out(
    `dagrun: cleanup --all: removed ${result.removed}, released ${result.released}, skipped ${result.skipped}` +
      (result.failed > 0 ? `, failed ${result.failed}` : "") +
      "\n",
  );
  return result;
}
