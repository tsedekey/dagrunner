/**
 * verify-evidence.ts — mechanical contract for the runtime-demonstration
 * verify node's report (`evidenceCheck: "verify-runtime"`).
 *
 * The verify node is a runtime DEMONSTRATION for the human, chosen at the fix
 * gate. Whether the demonstration happened is agent-reported, so this module
 * refuses a `DEMONSTRATED` report that lacks the provenance that would make the
 * claim checkable: a local disposable target, a candidate built from the actual
 * worktree revision (a stock released image can only be a baseline), separate
 * baseline vs candidate observations, and honest cleanup status. A verifier
 * that cannot meet this must report BLOCKED_RUNTIME / NOT_DEMONSTRATED — both
 * fail the node, never a pass.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "./types.js";

export const VERIFY_OUTCOMES = [
  "DEMONSTRATED",
  "NOT_DEMONSTRATED",
  "BLOCKED_RUNTIME",
] as const;

const CAPABILITIES = ["docker-compose", "c8run", "c8ctl", "source"] as const;
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : "";

export type WorktreeState = { head: string | null; dirty: string[] | null };

export function validateVerifyReport(
  report: unknown,
  wt: WorktreeState,
): { ok: true } | { ok: false; error: string } {
  const fail = (m: string) => ({ ok: false as const, error: `verify-report: ${m}` });
  if (!isObj(report)) return fail("not a JSON object");
  if (report["schemaVersion"] !== 2) {
    return fail(`schemaVersion must be 2 (runtime-demonstration report), got ${JSON.stringify(report["schemaVersion"])}`);
  }
  const outcome = report["outcome"];
  if (!(VERIFY_OUTCOMES as readonly unknown[]).includes(outcome)) {
    return fail(`outcome must be one of ${VERIFY_OUTCOMES.join("|")}`);
  }
  // Non-passing outcomes only need an honest reason; outcomeGate already fails them.
  if (outcome !== "DEMONSTRATED") {
    return str(report["reason"]) === ""
      ? fail(`${String(outcome)} requires a non-empty "reason"`)
      : { ok: true };
  }

  if (!(CAPABILITIES as readonly unknown[]).includes(report["capability"])) {
    return fail(`capability must be one of ${CAPABILITIES.join("|")}`);
  }
  const target = report["target"];
  if (!isObj(target) || target["kind"] !== "local-disposable") {
    return fail(`target.kind must be "local-disposable"`);
  }
  const host = str(target["host"]);
  if (!LOOPBACK.test(host)) {
    return fail(`target.host "${host}" is not loopback — never an ambient/remote endpoint`);
  }
  const cand = report["candidate"];
  if (!isObj(cand)) return fail("candidate missing");
  if (cand["builtFromWorktree"] !== true) {
    return fail("candidate.builtFromWorktree must be true — a stock release only establishes a baseline");
  }
  const rev = str(cand["sourceRevision"]);
  if (rev === "") return fail("candidate.sourceRevision missing");
  if (wt.head !== null && rev !== wt.head) {
    return fail(`candidate.sourceRevision ${rev} != worktree HEAD ${wt.head} — evidence is for a different revision`);
  }
  // Uncommitted fix changes are part of the candidate: the report must name them
  // exactly as `git status --porcelain -uall` shows them NOW (also catches a
  // verifier that edited the worktree while demonstrating).
  const dirty = cand["dirtyFiles"];
  if (!Array.isArray(dirty) || !dirty.every((d) => typeof d === "string")) {
    return fail("candidate.dirtyFiles must be an array of paths from `git status --porcelain -uall` (empty when committed)");
  }
  if (wt.dirty !== null && JSON.stringify([...dirty].sort()) !== JSON.stringify([...wt.dirty].sort())) {
    return fail(`candidate.dirtyFiles does not match the worktree now (reported ${JSON.stringify(dirty)}, actual ${JSON.stringify(wt.dirty)})`);
  }
  if (str(cand["artifact"]) === "" || str(cand["artifactIdentity"]) === "") {
    return fail("candidate.artifact and candidate.artifactIdentity (digest/sha256) are required");
  }
  const obs = report["observations"];
  if (!Array.isArray(obs) || obs.length === 0) return fail("observations must be a non-empty array");
  let candidateSeen = false;
  for (const o of obs) {
    if (!isObj(o) || (o["kind"] !== "baseline" && o["kind"] !== "candidate")) {
      return fail(`every observation needs kind "baseline" or "candidate"`);
    }
    if (str(o["command"]) === "" || str(o["result"]) === "") {
      return fail("every observation needs command and result");
    }
    if (o["kind"] === "candidate") candidateSeen = true;
  }
  if (!candidateSeen) return fail("no candidate observation — baseline evidence cannot demonstrate the fix");
  const cleanup = report["cleanup"];
  if (!isObj(cleanup) || !["clean", "leftovers"].includes(String(cleanup["status"]))) {
    return fail(`cleanup.status must be "clean" or "leftovers" (a failed cleanup is not a demonstration)`);
  }
  if (str(report["demoFile"]) === "") return fail("demoFile (manual reproduction steps for the human) missing");
  return { ok: true };
}

/** Node-level hook: run the check when the node declares `evidenceCheck`. */
export function checkEvidence(
  runDir: string,
  nodeId: string,
  node: Node,
  wt: WorktreeState,
): { ok: true } | { ok: false; error: string } {
  if (node.evidenceCheck !== "verify-runtime") return { ok: true };
  const file = node.outcomeGate?.file ?? "verify-report.json";
  const path = join(runDir, nodeId, file);
  if (!existsSync(path)) return { ok: false, error: `evidenceCheck: ${file} not found` };
  try {
    return validateVerifyReport(JSON.parse(readFileSync(path, "utf8")), wt);
  } catch (e) {
    return { ok: false, error: `evidenceCheck: ${file} unreadable — ${(e as Error).message}` };
  }
}

/** HEAD of a worktree, or null when it is not a git checkout. */
export function gitHead(worktreePath: string): string | null {
  try {
    return execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Sorted paths from `git status --porcelain -uall`, or null when not a git checkout. */
export function gitDirtyPaths(worktreePath: string): string[] | null {
  try {
    return execFileSync(
      "git",
      ["-C", worktreePath, "status", "--porcelain", "-uall"],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3).replace(/^"|"$/g, ""))
      .sort();
  } catch {
    return null;
  }
}
