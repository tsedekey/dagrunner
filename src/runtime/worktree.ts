/**
 * worktree.ts — a run ADOPTS an existing git worktree; dagrunner never creates one.
 *
 * Eddie's workflow: a workmux window (`wm add <branch>`) creates the worktree and
 * a driver session inside it runs dagrunner, whose nodes execute in that SAME
 * worktree. dagrunner therefore neither creates nor (for adopted runs) removes
 * worktrees, and knows nothing about workmux.
 *
 * `validateAdoptedWorktree` is the single gate: it runs after the run lock is
 * taken and before any other side effect, throws a distinct
 * `WorktreeAdoptionError` per cause (the caller releases the lock), and returns
 * the normalised path + checked-out branch the run records in state.json.
 *
 * The engine never falls back to cwd: `resolveWorktreeArg` is the CLI's only
 * place that looks at cwd, and an engine caller must pass the path explicitly.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readState, TERMINAL_RUN_STATUSES } from "../core/state.js";

/** A refusal the user can act on (bad path/branch/state) — the CLI prints the message, no stack. */
export class WorktreeAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeAdoptionError";
  }
}

/**
 * A run's recorded worktree is gone (or is no longer a git worktree). Extends
 * WorktreeAdoptionError so the CLI's existing "print the message, exit 1, no stack
 * trace" catch (`orFailAdoption`) covers it with no new plumbing.
 */
export class MissingWorktreeError extends WorktreeAdoptionError {
  constructor(message: string) {
    super(message);
    this.name = "MissingWorktreeError";
  }
}

export type AdoptedWorktree = {
  /** realpath of the worktree root. */
  worktreePath: string;
  /** Branch currently checked out there. */
  branch: string;
};

/** realpath when the path exists, otherwise the plain resolved path (legacy state may point at a removed dir). */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** stdout of `git <args>` run in `cwd`, trimmed; null when git exits non-zero. */
function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `--git-dir`, `--git-common-dir` and `--show-toplevel` of the worktree `cwd` is
 * in, as realpaths. git prints the first two relative to cwd in a main checkout
 * (".git") and absolute in a linked worktree — resolve both against cwd.
 */
function gitLayout(
  cwd: string,
): { gitDir: string; commonDir: string; toplevel: string } | null {
  const out = gitOut(cwd, [
    "rev-parse",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  if (out === null) return null;
  const [gitDir, commonDir, toplevel] = out.split("\n");
  if (gitDir === undefined || commonDir === undefined || toplevel === undefined)
    return null;
  return {
    gitDir: real(resolve(cwd, gitDir)),
    commonDir: real(resolve(cwd, commonDir)),
    toplevel: real(toplevel),
  };
}

/** True when `dir` is the main checkout of its repo (not a linked worktree). */
export function isMainCheckout(dir: string): boolean | null {
  const l = gitLayout(dir);
  return l === null ? null : l.gitDir === l.commonDir;
}

/**
 * Validate that `worktreePath` can be adopted by a new run. Throws
 * WorktreeAdoptionError (one distinct message per cause) or returns the
 * normalised path + branch.
 *
 * (a) a LINKED worktree of DEVHARNESS_SRC (same common git dir, own git dir),
 * (b) on a branch, and not the run's base branch,
 * (c) no tracked modifications or staged changes (untracked files are fine —
 *     workmux may leave e.g. `.workmux/`),
 * (d) the base branch resolves in DEVHARNESS_SRC,
 * (e) no other NON-terminal run in `<home>/runs/*` already uses this worktree.
 */
export function validateAdoptedWorktree(opts: {
  worktreePath: string;
  devharnessSrc: string;
  baseBranch: string;
  homeDir: string;
}): AdoptedWorktree {
  const { devharnessSrc, baseBranch, homeDir } = opts;
  const given = opts.worktreePath;
  const refuse = (cause: string): never => {
    throw new WorktreeAdoptionError(
      `dagrun: cannot adopt worktree "${given}": ${cause}`,
    );
  };

  // ---- (a) a linked worktree of DEVHARNESS_SRC ------------------------------
  if (!existsSync(given) || !statSync(given).isDirectory())
    return refuse(`the path does not exist or is not a directory.`);
  const wt = gitLayout(given);
  if (wt === null)
    return refuse(
      `it is not inside a git worktree. Pass --worktree <path> of a worktree created from DEVHARNESS_SRC (e.g. \`git worktree add\` or \`wm add\`).`,
    );
  if (wt.toplevel !== real(given))
    return refuse(
      `it is not the worktree root (the root is "${wt.toplevel}"). Pass the root.`,
    );
  if (wt.gitDir === wt.commonDir)
    return refuse(
      `it is a main checkout, not a linked worktree. dagrunner runs only in a worktree so the main checkout stays on its base branch; create one (\`git worktree add\` or \`wm add <branch>\`) and run from there.`,
    );
  const src = gitLayout(devharnessSrc);
  if (src === null)
    return refuse(`DEVHARNESS_SRC "${devharnessSrc}" is not a git repository.`);
  if (wt.commonDir !== src.commonDir)
    return refuse(
      `it is not a linked worktree of DEVHARNESS_SRC "${devharnessSrc}" (its git dir "${wt.commonDir}" belongs to a different repository).`,
    );

  // ---- (b) on a branch, and not the base branch -----------------------------
  const branch = gitOut(wt.toplevel, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch === null || branch === "")
    return refuse(
      `HEAD is detached. Check out a branch in the worktree first (\`git switch -c <branch>\`).`,
    );
  if (branch === baseBranch)
    return refuse(
      `its branch "${branch}" is the run's base branch. A run needs its own branch to commit on; use a worktree on a different branch.`,
    );

  // ---- (c) no tracked modifications / staged changes ------------------------
  const dirty = gitOut(wt.toplevel, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (dirty === null) return refuse(`\`git status\` failed in the worktree.`);
  if (dirty !== "")
    return refuse(
      `it has uncommitted changes to tracked files. Commit or stash them first.\n  ${dirty.split("\n").slice(0, 5).join("\n  ")}`,
    );

  // ---- (d) base branch resolves in DEVHARNESS_SRC ---------------------------
  // Fail loud — a typo in base_branch would silently diff/PR against the wrong base.
  if (
    gitOut(devharnessSrc, ["rev-parse", "--verify", "--quiet", baseBranch]) ===
    null
  )
    return refuse(
      `base_branch "${baseBranch}" not found in DEVHARNESS_SRC — fetch it first`,
    );

  // ---- (e) no other live run on this worktree -------------------------------
  const runsDir = join(homeDir, "runs");
  if (existsSync(runsDir)) {
    for (const id of readdirSync(runsDir)) {
      let other;
      try {
        other = readState(join(runsDir, id, "state.json"));
      } catch {
        continue; // no state yet (a --detach pre-claimed dir) or unreadable: not a live claim
      }
      if (TERMINAL_RUN_STATUSES.includes(other.status)) continue;
      if (real(other.worktreePath) !== wt.toplevel) continue;
      return refuse(
        `run "${other.runId}" (status: ${other.status}) already uses it. Finish it, \`dagrun abort ${other.runId}\`, or continue it with \`dagrun rerun ${other.runId} <node>\` / \`dagrun resume ${other.runId}\`.`,
      );
    }
  }

  return { worktreePath: wt.toplevel, branch };
}

/**
 * Fail loud when a run's recorded worktree no longer exists. dagrunner ADOPTS the
 * worktree (workmux owns it), so `wm rm` / `wm rm --gone` / `wm rm --all` can delete
 * it out from under a live run — and the seeding steps of `resume`, `rerun` and
 * `gate attach --reseed` would silently RE-CREATE the path as a bare `.claude/`
 * directory (`cpSync` makes parents) and run nodes there. Call this BEFORE any side
 * effect (lock, state write, seeding, archiving). Read-only commands (status,
 * report, gate show) deliberately do not call it. Legacy runs (no `worktreeOrigin`,
 * worktree under `<home>/worktrees`) are checked the same way.
 *
 * "Exists" = a directory containing a `.git` entry (a file in a linked worktree, a
 * directory in a main checkout): a leftover plain directory (for instance the
 * `.claude/` an earlier unguarded resume re-created) is not a worktree.
 *
 * `devharnessSrc` only personalises the recovery command text.
 */
export function assertRunWorktreeExists(
  run: { runId: string; worktreePath: string; branch: string },
  devharnessSrc?: string,
): void {
  const p = run.worktreePath;
  const isDir = existsSync(p) && statSync(p).isDirectory();
  if (isDir && existsSync(join(p, ".git"))) return;
  const src = devharnessSrc ?? "<DEVHARNESS_SRC>";
  const what = isDir
    ? `"${p}" exists but is not a git worktree (no .git there — a leftover directory)`
    : `"${p}" no longer exists`;
  throw new MissingWorktreeError(
    `dagrun: run "${run.runId}" cannot continue — its worktree ${what}.\n` +
      `It was removed outside dagrunner (for example by \`wm rm\`), and dagrunner cannot run a node without it. ` +
      `Nothing was changed. Either:\n` +
      `  1. recreate a worktree for the recorded branch "${run.branch}" at that same path, then retry` +
      (isDir ? ` (remove the leftover directory first)` : ``) +
      `:\n` +
      `       # if the branch was deleted too (\`wm rm\` deletes it unless run with -k), recreate it first at the run's last\n` +
      `       # commit (origin/${run.branch} if it was pushed, else the worktreeHead in <run dir>/<gate>/gate.json or the reflog):\n` +
      `       git -C "${src}" branch "${run.branch}" <commit>\n` +
      `       git -C "${src}" worktree prune   # only if git still lists the removed path\n` +
      `       git -C "${src}" worktree add "${p}" "${run.branch}"\n` +
      `  2. give up on the run: dagrun abort ${run.runId}`,
  );
}

/**
 * The CLI's `--worktree` resolution. An explicit flag is taken as given
 * (relative to `cwd`); otherwise the git toplevel of `cwd`. Fails loud outside a
 * git repository — there is no further fallback. The engine takes the result as
 * an explicit option and never looks at cwd itself.
 */
export function resolveWorktreeArg(
  flag: string | undefined,
  cwd: string,
): string {
  if (flag !== undefined && flag !== "") return resolve(cwd, flag);
  const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null || top === "")
    throw new WorktreeAdoptionError(
      `dagrun: the current directory "${cwd}" is not inside a git repository — run from inside the worktree or pass --worktree <path>`,
    );
  return real(top);
}
