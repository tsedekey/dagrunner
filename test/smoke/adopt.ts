/**
 * adopt.ts — smoke helper: runs ADOPT an existing worktree, so every smoke that
 * calls startRun first needs a real linked worktree of the toy repo (what
 * `wm add <branch>` / `git worktree add` produces). Plain git only — no workmux.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

let counter = 0;

/**
 * `git worktree add` a fresh branch off `main` under `parentDir/<tag>` in `repo`
 * and return the worktree's realpath. The branch name is unique per call (the
 * toy repo is shared and long-lived), and never `main` (adoption refuses it).
 */
export function addLinkedWorktree(
  repo: string,
  parentDir: string,
  tag: string,
): string {
  mkdirSync(parentDir, { recursive: true });
  const wt = join(parentDir, `wt-${tag}`);
  const branch = `smoke/${tag}-${String(Date.now())}-${String(counter++)}`;
  execFileSync("git", ["worktree", "add", "-q", wt, "-b", branch, "main"], {
    cwd: repo,
    stdio: "pipe",
  });
  return realpathSync(wt);
}
