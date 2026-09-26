/**
 * changes-diff.ts — the engine-written `changes.diff` of a run's worktree.
 *
 * The fix gate's viewer had only summary prose, not the change itself. The
 * engine (never an agent) renders `git diff <merge-base of the run's base branch
 * and HEAD>` of the WORKING TREE — committed, staged, unstaged and untracked
 * files — without staging or otherwise touching the index/worktree. Untracked
 * files come from `git ls-files --others --exclude-standard` (so the worktree's
 * seeded exclude patterns apply) rendered as new-file diffs via
 * `git diff --no-index /dev/null <file>`. `node_modules` is excluded on both
 * sides, matching normalizeDirty (verify-evidence.ts).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const EXCLUDE = [":(exclude)node_modules", ":(exclude)**/node_modules/**"];
const hasNodeModules = (p: string) => p.split("/").includes("node_modules");

function git(cwd: string, args: string[], okStatus: number[] = [0]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { maxBuffer: 512 * 1024 * 1024 });
  if (r.error !== undefined) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status === null || !okStatus.includes(r.status)) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString();
}

/** Merge-base of HEAD and the run's base branch: `origin/<base>` first, then local `<base>`. Throws if neither resolves. */
export function resolveMergeBase(worktreePath: string, baseBranch: string): string {
  const tried: string[] = [];
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      return git(worktreePath, ["merge-base", ref, "HEAD"]).trim();
    } catch (e) {
      tried.push(`${ref}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`cannot compute a diff base for base_branch "${baseBranch}" — ${tried.join("; ")}`);
}

export function renderChangesDiff(args: { worktreePath: string; baseBranch: string }): { text: string; truncated: boolean } {
  const { worktreePath, baseBranch } = args;
  const base = resolveMergeBase(worktreePath, baseBranch);
  let text = git(worktreePath, ["diff", base, "--", ".", ...EXCLUDE]);
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((p) => p !== "" && !hasNodeModules(p));
  for (const file of untracked) {
    if (Buffer.byteLength(text) > MAX_DIFF_BYTES) break;
    // --no-index exits 1 when the files differ (always, vs /dev/null).
    text += git(worktreePath, ["diff", "--no-index", "--", "/dev/null", file], [0, 1]);
  }
  if (Buffer.byteLength(text) <= MAX_DIFF_BYTES) return { text, truncated: false };
  const cut = Buffer.from(text).subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return {
    text: `${cut}\n[dagrun: changes.diff truncated at ${MAX_DIFF_BYTES} bytes — inspect the worktree for the rest]\n`,
    truncated: true,
  };
}

/** Render and write atomically (tmp + rename); throws on failure, leaving no partial file. */
export function writeChangesDiff(args: { worktreePath: string; baseBranch: string; outFile: string }): { truncated: boolean } {
  const { text, truncated } = renderChangesDiff(args);
  mkdirSync(dirname(args.outFile), { recursive: true });
  const tmp = `${args.outFile}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, args.outFile);
  return { truncated };
}

export const CHANGES_DIFF_FILE = "changes.diff";

/**
 * Engine hook: write `<runDir>/<nodeId>/changes.diff`, or WARN and return null.
 * A diff problem must never fail a node — the diff is review evidence, not a
 * contract. (No silent default: a missing base ref is reported, not guessed.)
 */
export function tryWriteChangesDiff(args: {
  worktreePath: string;
  baseBranch: string;
  runDir: string;
  nodeId: string;
}): string | null {
  const outFile = join(args.runDir, args.nodeId, CHANGES_DIFF_FILE);
  try {
    const { truncated } = writeChangesDiff({ worktreePath: args.worktreePath, baseBranch: args.baseBranch, outFile });
    if (truncated) process.stderr.write(`dagrun: warning: ${outFile} truncated at ${MAX_DIFF_BYTES} bytes\n`);
    return outFile;
  } catch (e) {
    process.stderr.write(`dagrun: warning: could not write ${outFile}: ${(e as Error).message}\n`);
    return null;
  }
}
