/**
 * deliverables.ts — compare what the worktree changed with what the nodes
 * DECLARED. `pr` stages ONLY paths listed in `implement/deliverables.txt` ∪
 * `fix/deliverables.txt` (commit a857753), so a changed path nobody declared is
 * silently left out of the PR commit — run 51496-1: a test file the fix node
 * added cost a whole extra gate round to notice. This surfaces both directions
 * as an ADVISORY (a gate-brief validation entry); it never blocks — unrelated
 * pre-existing dirt can be legitimate.
 *
 * "Changed" = what `changes.diff` shows: tracked differences vs the merge-base
 * of the run's base branch and HEAD (committed + staged + unstaged) plus
 * untracked non-ignored files. Excluded: build output (`target/` segments),
 * `node_modules`. dagrunner's own skip-worktree `.tool-versions` edit needs no
 * special case: `git diff <tree>` does not report skip-worktree entries (pinned
 * by the test).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMergeBase } from "./changes-diff.js";

/** Manifest files whose union is the declared deliverable set. */
export const MANIFEST_NODES = ["implement", "fix"] as const;

export function parseManifest(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const p = line.trim();
    if (p !== "" && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Union of implement/ and fix/ deliverables.txt; null when NEITHER file exists (nothing to compare against). */
export function readManifestUnion(runDir: string): string[] | null {
  let any = false;
  const union: string[] = [];
  for (const node of MANIFEST_NODES) {
    const f = join(runDir, node, "deliverables.txt");
    if (!existsSync(f)) continue;
    any = true;
    for (const p of parseManifest(readFileSync(f, "utf8"))) if (!union.includes(p)) union.push(p);
  }
  return any ? union : null;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error !== undefined) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${String(r.status)}): ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

const isNoise = (p: string): boolean => p.split("/").some((seg) => seg === "target" || seg === "node_modules");

export function compareDeliverables(args: {
  worktreePath: string;
  baseBranch: string;
  manifest: string[];
}): { changed: string[]; unlisted: string[]; unchanged: string[] } {
  const { worktreePath, baseBranch, manifest } = args;
  const base = resolveMergeBase(worktreePath, baseBranch); // throws if no base — never a silent pass
  const tracked = git(worktreePath, ["diff", "--name-only", "--no-renames", "-z", base]).split("\0");
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  const changed = [...new Set([...tracked, ...untracked])]
    .filter((p) => p !== "" && !isNoise(p))
    .sort();
  const listed = new Set(manifest);
  return {
    changed,
    unlisted: changed.filter((p) => !listed.has(p)),
    unchanged: manifest.filter((p) => !changed.includes(p)),
  };
}

export type DeliverablesCheck = { nodeId: "pr"; check: string; ok: boolean; detail?: string };

/**
 * The pre-PR gate's deliverables advisory, as brief `validation` entries (shown
 * in gate.json, gate-context.md and the UI; NOT part of the revision hash and
 * never blocking). [] when no manifest exists at all (legacy / mocked runs).
 * A comparison that cannot run is reported as a failed entry, not skipped.
 */
export function deliverablesAdvisory(
  runDir: string,
  state: { worktreePath: string; baseBranch?: string },
): DeliverablesCheck[] {
  const manifest = readManifestUnion(runDir);
  if (manifest === null) return [];
  let r: ReturnType<typeof compareDeliverables>;
  try {
    r = compareDeliverables({ worktreePath: state.worktreePath, baseBranch: state.baseBranch ?? "main", manifest });
  } catch (e) {
    return [
      {
        nodeId: "pr",
        check: "deliverables-manifest",
        ok: false,
        detail: `advisory: could not compare the worktree's changes with implement/fix deliverables.txt — ${(e as Error).message.split("\n")[0]}`,
      },
    ];
  }
  const out: DeliverablesCheck[] = [];
  if (r.unlisted.length > 0)
    out.push({
      nodeId: "pr",
      check: "deliverables-unlisted",
      ok: false,
      detail:
        `advisory (non-blocking): ${String(r.unlisted.length)} changed path(s) are NOT in implement/fix deliverables.txt, ` +
        `so pr will not stage them: ${r.unlisted.join(", ")}. Add them to fix/deliverables.txt if they belong in the PR; ignore if unrelated dirt.`,
    });
  if (r.unchanged.length > 0)
    out.push({
      nodeId: "pr",
      check: "deliverables-unchanged",
      ok: false,
      detail:
        `advisory (non-blocking): ${String(r.unchanged.length)} path(s) listed in deliverables.txt have NO change vs the base: ` +
        `${r.unchanged.join(", ")}. Stale or mistyped manifest entries?`,
    });
  if (out.length === 0) out.push({ nodeId: "pr", check: "deliverables-manifest", ok: true });
  return out;
}
