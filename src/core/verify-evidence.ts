/**
 * verify-evidence.ts — mechanical contract for the provision-and-hand-off
 * verify node's report (`evidenceCheck: "verify-runtime"`).
 *
 * The verify node PROVISIONS a real runtime (candidate built from the worktree,
 * running on loopback) and hands it to the human for manual testing; it renders
 * no verdict and does not tear down (the human's verdict at the pre-PR gate does,
 * via core/verify-cleanup.ts). Whether the environment is genuinely up is
 * agent-reported, so this module refuses a `PROVISIONED` report that lacks the
 * evidence that makes the claim checkable: a local disposable loopback target,
 * a candidate built from the actual worktree revision, a durable typed
 * `ownedResources` inventory (enough for a later cleanup with no other memory,
 * every name carrying the `dagrun-<run-id>-` ownership prefix), and a readiness
 * probe result. A verifier that cannot meet this reports BLOCKED_RUNTIME, which
 * fails the node, never a pass.
 *
 * schemaVersion 3 is required of the node. Cleanup also READS schemaVersion 2
 * (see verify-cleanup.ts) so runs produced before this change stay cleanable.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Node } from "./types.js";

export const VERIFY_OUTCOMES = ["PROVISIONED", "BLOCKED_RUNTIME"] as const;
export const VERIFY_SCHEMA_VERSION = 3;

const CAPABILITIES = ["docker-compose", "c8run", "c8ctl", "source"] as const;
export const RESOURCE_KINDS = ["container", "network", "image", "volume", "tempdir"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;

/** Ownership prefix every resource a verify node creates must carry. */
export const ownershipPrefix = (runId: string): string => `dagrun-${runId}-`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : "";

export type WorktreeState = { head: string | null; dirty: string[] | null };

const PORCELAIN_PREFIX = /^[ MTADRCU?!]{2} /;
const hasNodeModules = (p: string) => p.split("/").includes("node_modules");

/**
 * Canonical form of a dirty-file list, applied to BOTH the reported and the
 * live list so the two can never disagree on representation:
 *  - a `git status --porcelain` line and a bare path both reduce to the bare path
 *    (rename `old -> new` keeps `new`, quotes stripped);
 *  - anything under a `node_modules` directory is dropped — untracked/ignored
 *    dependency output that IDE indexers or background installs write into the
 *    worktree is never part of the candidate;
 *  - an untracked DIRECTORY summary (`?? dir/`, no `-uall`) is dropped: it cannot
 *    be compared to the file-level live list, and any real file inside it still
 *    appears in the live list, so hiding it would fail loud, not pass silently.
 * Tracked changes and untracked real files are still compared exactly.
 */
export function normalizeDirty(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    let p = raw;
    let untrackedDir = false;
    if (PORCELAIN_PREFIX.test(p)) {
      untrackedDir = p.startsWith("??") && p.trimEnd().endsWith("/");
      p = p.slice(3);
    }
    p = p.replace(/^.* -> /, "").replace(/^"|"$/g, "");
    if (p === "" || untrackedDir || hasNodeModules(p)) continue;
    out.push(p);
  }
  return out.sort();
}

export function validateVerifyReport(
  report: unknown,
  wt: WorktreeState,
  runIdArg?: string,
): { ok: true } | { ok: false; error: string } {
  const fail = (m: string) => ({ ok: false as const, error: `verify-report: ${m}` });
  if (!isObj(report)) return fail("not a JSON object");
  if (report["schemaVersion"] !== VERIFY_SCHEMA_VERSION) {
    return fail(`schemaVersion must be ${VERIFY_SCHEMA_VERSION} (provision-and-hand-off report), got ${JSON.stringify(report["schemaVersion"])}`);
  }
  const outcome = report["outcome"];
  if (!(VERIFY_OUTCOMES as readonly unknown[]).includes(outcome)) {
    return fail(`outcome must be one of ${VERIFY_OUTCOMES.join("|")}`);
  }
  // Non-passing outcomes only need an honest reason; outcomeGate already fails them.
  if (outcome !== "PROVISIONED") {
    return str(report["reason"]) === ""
      ? fail(`${String(outcome)} requires a non-empty "reason"`)
      : { ok: true };
  }
  const runId = runIdArg ?? str(report["run_id"]);
  if (runId === "") return fail("run_id missing — cannot check resource ownership");
  if (runIdArg !== undefined && str(report["run_id"]) !== "" && str(report["run_id"]) !== runIdArg) {
    return fail(`run_id "${String(report["run_id"])}" != this run "${runIdArg}"`);
  }

  if (!(CAPABILITIES as readonly unknown[]).includes(report["capability"])) {
    return fail(`capability must be one of ${CAPABILITIES.join("|")}`);
  }
  const isSource = report["capability"] === "source";
  // A source-only hand-off is a deliberate, per-case decision (no user-observable runtime
  // surface), never the default: it must say why a real runtime was not provisioned.
  if (isSource && str(report["sourceRationale"]) === "") {
    return fail(`capability "source" requires a non-empty "sourceRationale" — why a real runtime (docker/c8run) could not be provisioned for this change`);
  }
  const target = report["target"];
  if (!isObj(target) || target["kind"] !== "local-disposable") {
    return fail(`target.kind must be "local-disposable"`);
  }
  const host = str(target["host"]);
  if (!LOOPBACK.test(host)) {
    return fail(`target.host "${host}" is not loopback — never an ambient/remote endpoint`);
  }
  const owned = target["ownedResources"];
  if (!Array.isArray(owned)) return fail("target.ownedResources must be an array");
  if (isSource) {
    if (owned.length !== 0) return fail(`capability "source" provisions nothing — target.ownedResources must be empty`);
  } else {
    if (owned.length === 0) {
      return fail("target.ownedResources must be non-empty — record every container/network/image/volume/tempdir so a later cleanup needs no other memory");
    }
    const prefix = ownershipPrefix(runId);
    for (const r of owned) {
      if (!isObj(r) || !(RESOURCE_KINDS as readonly unknown[]).includes(r["kind"]) || str(r["name"]) === "") {
        return fail(`every ownedResources entry must be {kind: ${RESOURCE_KINDS.join("|")}, name}`);
      }
      const name = str(r["name"]);
      const leaf = r["kind"] === "tempdir" ? basename(name) : name;
      if (!leaf.startsWith(prefix)) {
        return fail(`ownedResources "${name}" does not carry the ownership prefix "${prefix}"`);
      }
    }
    const port = target["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      return fail("target.port (the host port the environment is reachable on) must be an integer 1-65535");
    }
    const ready = report["readiness"];
    if (!isObj(ready) || str(ready["command"]) === "" || str(ready["result"]) === "") {
      return fail("readiness {command, result} missing — an environment that was not probed as reachable is not PROVISIONED");
    }
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
  // as `git status --porcelain -uall` shows them NOW (compared via normalizeDirty) (also catches a
  // verifier that edited the worktree while provisioning). Cleanup re-checks the same list.
  const dirty = cand["dirtyFiles"];
  if (!Array.isArray(dirty) || !dirty.every((d) => typeof d === "string")) {
    return fail("candidate.dirtyFiles must be an array of paths from `git status --porcelain -uall` (empty when committed)");
  }
  if (wt.dirty !== null) {
    const reported = normalizeDirty(dirty as string[]);
    const actual = normalizeDirty(wt.dirty);
    if (JSON.stringify(reported) !== JSON.stringify(actual)) {
      const missing = actual.filter((p) => !reported.includes(p));
      const extra = reported.filter((p) => !actual.includes(p));
      return fail(`candidate.dirtyFiles does not match the worktree now (unreported: ${JSON.stringify(missing)}, reported but not dirty: ${JSON.stringify(extra)})`);
    }
  }
  if (str(cand["artifact"]) === "" || str(cand["artifactIdentity"]) === "") {
    return fail("candidate.artifact and candidate.artifactIdentity (digest/sha256) are required");
  }
  const teardown = report["teardown"];
  const wantTeardown = isSource ? "not-applicable" : "pending";
  if (!isObj(teardown) || teardown["status"] !== wantTeardown) {
    return fail(`teardown.status must be "${wantTeardown}" at provision time (the human's verdict triggers the teardown, not this node)`);
  }
  if (str(report["demoFile"]) === "") return fail("demoFile (manual verification steps for the human) missing");
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
    return validateVerifyReport(JSON.parse(readFileSync(path, "utf8")), wt, basename(runDir));
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

/** Sorted bare paths from `git status --porcelain -uall` (see normalizeDirty), or null when not a git checkout. */
export function gitDirtyPaths(worktreePath: string): string[] | null {
  try {
    return normalizeDirty(
      execFileSync(
        "git",
        ["-C", worktreePath, "status", "--porcelain", "-uall"],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .split("\n")
        .filter((l) => l.trim() !== ""),
    );
  } catch {
    return null;
  }
}
