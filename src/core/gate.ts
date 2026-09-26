/**
 * gate.ts — companion-gate contract: revision binding, request validation,
 * amend/invalidation planning, and originating-session lookup.
 *
 * Why this exists: a gate pause used to spawn a fresh `claude` session and
 * accept an unbound `--approve`. For workflows with `companionGates`, the human
 * decision instead comes from the ORIGINATING planning companion via
 * `dagrun gate show|decide`. Everything here is pure (or read-only fs) so the
 * routing/authorization semantics are unit-testable without a Claude session.
 *
 * Artifacts stay the only cross-node channel: the brief is derived from the
 * run's own artifacts; nothing competes with them as a case history.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Workflow } from "./types.js";
import type { RunState } from "./state.js";
import { checkNoPlaceholders, checkOutcomeGate } from "./dag.js";
import { gitHead } from "./verify-evidence.js";

export type GateAction = "approve" | "amend" | "hold";
export const GATE_ACTIONS: readonly GateAction[] = ["approve", "amend", "hold"];

export type GateRejectionCode =
  | "no-companion"
  | "session-unavailable"
  | "session-mismatch"
  | "wrong-run"
  | "not-awaiting"
  | "wrong-gate"
  | "stale-revision"
  | "invalid-action"
  | "bad-target"
  | "missing-comment"
  | "missing-run-next"
  | "unexpected-run-next";

export type GateRequest = {
  runId: string;
  gate: string;
  revision: string;
  action: string;
  target?: string;
  comment?: string;
  /** Approve at a gate with `decidesNode`: run (true) or skip (false) that node. */
  runNext?: boolean;
  /** CLAUDE_CODE_SESSION_ID of the caller, when it identified itself. */
  session?: string;
};

export type GateEvidenceFile = { path: string; sha256: string };

export type GateBrief = {
  schema: 1;
  runId: string;
  workflow: string;
  gateNodeId: string;
  iteration: number;
  /** `<runHash>.<contentHash>` — binds a decision to this exact run/gate/evidence. */
  revision: string;
  planSha256: string | null;
  worktreeHead: string | null;
  /** Files the gate node produced (what the human is being asked about). */
  gateArtifacts: GateEvidenceFile[];
  /** Files produced by completed ancestors (evidence for the decision). */
  upstreamArtifacts: { nodeId: string; files: GateEvidenceFile[] }[];
  /** Mechanical checks re-run at brief time — not agent judgment. */
  validation: { nodeId: string; check: string; ok: boolean; detail?: string }[];
  companion: {
    sessionId: string | null;
    reconstructed: boolean;
    status: "ok" | "blocked";
    blockedReason?: string;
    resumeHint?: string;
    /** Structured return path (used by `dagrun gate open`). */
    resume?: { sessionId: string; configDir: string; cwd: string | null; prompt: string };
  };
  pendingDecision: {
    actions: GateAction[];
    amendTargets: string[];
    /** Approving also decides whether this downstream node runs (--run-next yes|no). */
    decidesNode?: string;
    /** Nodes that will run if the gate is approved. */
    approveContinuesTo: string[];
  };
};

// ---------------------------------------------------------------------------
// Hashing / revision
// ---------------------------------------------------------------------------

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Short stable hash of a run id — the revision prefix that detects a wrong-run token. */
export function runHash(runId: string): string {
  return sha256(runId).slice(0, 8);
}

export function computeGateRevision(parts: {
  runId: string;
  gateNodeId: string;
  iteration: number;
  planSha256: string | null;
  worktreeHead: string | null;
  files: GateEvidenceFile[];
}): string {
  const canonical = JSON.stringify({
    g: parts.gateNodeId,
    i: parts.iteration,
    p: parts.planSha256,
    h: parts.worktreeHead,
    f: [...parts.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => [f.path, f.sha256]),
  });
  return `${runHash(parts.runId)}.${sha256(canonical).slice(0, 16)}`;
}

/** Deterministic id for a specific (run, gate, revision, action, target, comment) decision. */
export function decisionId(req: {
  runId: string;
  gate: string;
  revision: string;
  action: string;
  target?: string;
  comment?: string;
  runNext?: boolean;
}): string {
  return sha256(
    JSON.stringify([
      req.runId,
      req.gate,
      req.revision,
      req.action,
      req.target ?? "",
      req.comment ?? "",
      req.runNext === undefined ? "" : String(req.runNext),
    ]),
  ).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function depsOf(workflow: Workflow, id: string): string[] {
  return workflow.nodes.find((n) => n.id === id)?.dependsOn ?? [];
}

export function ancestorsOf(workflow: Workflow, id: string): string[] {
  const seen = new Set<string>();
  const stack = [...depsOf(workflow, id)];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...depsOf(workflow, cur));
  }
  return [...seen];
}

/** Transitive dependents of `id` (not including `id`). */
export function downstreamOf(workflow: Workflow, id: string): string[] {
  return workflow.nodes
    .filter((n) => ancestorsOf(workflow, n.id).includes(id))
    .map((n) => n.id);
}

/**
 * Nodes an amendment may re-run: the gate node itself, plus the gated ancestors
 * the workflow explicitly declares in `gate.amendTargets` (their feedback-N.md
 * revision path is the existing, tested mechanism). No generic transition.
 */
export function amendTargets(workflow: Workflow, gateNodeId: string): string[] {
  const declared =
    workflow.nodes.find((n) => n.id === gateNodeId)?.gate?.amendTargets ?? [];
  return [gateNodeId, ...declared];
}

/** Nodes that run after approving `gateNodeId` (its transitive dependents, in workflow order). */
export function approveContinuesTo(
  workflow: Workflow,
  gateNodeId: string,
): string[] {
  const down = new Set(downstreamOf(workflow, gateNodeId));
  return workflow.nodes.filter((n) => down.has(n.id)).map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Originating-session lookup (read-only)
// ---------------------------------------------------------------------------

/**
 * Find the on-disk transcript of a Claude Code session, searching the given
 * config dirs' `projects/<slug>/<sessionId>.jsonl`. This proves the session
 * EXISTS and is resumable-in-principle — not that it is idle or that resume
 * preserves the id; that is a harness property recorded as unverified.
 * Returns the owning config dir, or null.
 */
export function findSessionFile(
  sessionId: string,
  configDirs: string[],
): { dir: string; file: string } | null {
  if (!/^[A-Za-z0-9-]{8,}$/.test(sessionId)) return null;
  for (const dir of configDirs) {
    const projects = join(dir, "projects");
    if (!existsSync(projects)) continue;
    for (const slug of readdirSync(projects)) {
      const file = join(projects, slug, `${sessionId}.jsonl`);
      if (existsSync(file)) return { dir, file };
    }
  }
  return null;
}

export function findSessionConfigDir(
  sessionId: string,
  configDirs: string[],
): string | null {
  return findSessionFile(sessionId, configDirs)?.dir ?? null;
}

/**
 * Directories the session has run in, MOST RECENT FIRST (read from the transcript
 * tail, then head). A session outlives renames/moves of its directory, so the
 * first record's cwd can be stale; `claude --resume <id>` must run from a
 * directory that exists. Empty when none is recorded.
 */
export function readSessionCwds(file: string): string[] {
  const out: string[] = [];
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const chunk = (pos: number, len: number): string => {
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, pos);
        return buf.subarray(0, n).toString("utf8");
      };
      const tailLen = Math.min(size, 262144);
      const text = chunk(size - tailLen, tailLen) + "\n" + chunk(0, Math.min(size, 65536));
      const re = /"cwd":"((?:[^"\\]|\\.)*)"/g;
      const found: string[] = [];
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        try {
          found.push(JSON.parse(`"${m[1] ?? ""}"`) as string);
        } catch {
          /* skip a torn record */
        }
      }
      // tail records come first in `text` (chronological), head after: newest = last of the tail part.
      const seen = new Set<string>();
      for (const c of found.reverse()) if (!seen.has(c)) { seen.add(c); out.push(c); }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* unreadable → none */
  }
  return out;
}

/** Most recent recorded directory, or null. */
export function readSessionCwd(file: string): string | null {
  return readSessionCwds(file)[0] ?? null;
}

/**
 * The opening message that makes a resumed companion conversation aware a gate
 * is waiting (a bare `claude --resume` reopens the chat with no such context).
 * Deliberately excludes revision/evidence: the agent must fetch those live via
 * `dagrun gate show`, so a stale prompt can never carry stale facts.
 */
export function gateResumePrompt(runId: string, gateNodeId: string): string {
  return (
    `DagRunner run ${runId} is paused at its "${gateNodeId}" gate: the preceding node has finished and is ` +
    `waiting for our decision. Use the bug-fix-companion skill (references/dagrunner-gates.md). ` +
    `First run: dagrun gate show ${runId} — then review the actual artifacts against our agreed plan and ` +
    `explain the meaningful findings one increment at a time. Do not decide or confirm anything until I ` +
    `explicitly tell you the action; understanding is not approval.`
  );
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type GateValidation =
  | { ok: true; action: GateAction; target: string }
  | { ok: false; code: GateRejectionCode; message: string };

const reject = (code: GateRejectionCode, message: string): GateValidation => ({
  ok: false,
  code,
  message,
});

/**
 * Validate a gate request against the CURRENT recomputed brief. Order matters:
 * association and identity first, then staleness, then the action itself.
 * Nothing here mutates state.
 */
export function validateGateRequest(args: {
  state: RunState;
  workflow: Workflow;
  brief: GateBrief;
  req: GateRequest;
}): GateValidation {
  const { state, workflow, brief, req } = args;

  if (state.companion === undefined) {
    return reject(
      "no-companion",
      `run "${state.runId}" has no originating companion session recorded — attach one with ` +
        `\`dagrun gate attach ${state.runId} --session <id>\` (add --reconstructed for a fallback session)`,
    );
  }
  if (brief.companion.status === "blocked") {
    return reject(
      "session-unavailable",
      brief.companion.blockedReason ?? "originating session unavailable",
    );
  }
  if (req.session !== undefined && req.session !== state.companion.sessionId) {
    return reject(
      "session-mismatch",
      `caller session "${req.session}" is not the recorded originating companion "${state.companion.sessionId}" — ` +
        `only that conversation may decide this gate`,
    );
  }
  if (
    req.runId !== state.runId ||
    !req.revision.startsWith(runHash(state.runId) + ".")
  ) {
    return reject(
      "wrong-run",
      `revision "${req.revision}" was not issued for run "${state.runId}"`,
    );
  }
  if (state.nodes[req.gate]?.status !== "awaiting-gate") {
    return reject(
      "not-awaiting",
      `gate "${req.gate}" is not awaiting a decision (already decided, or the run moved on)`,
    );
  }
  if (req.gate !== brief.gateNodeId) {
    return reject(
      "wrong-gate",
      `run is paused at gate "${brief.gateNodeId}", not "${req.gate}"`,
    );
  }
  if (req.revision !== brief.revision) {
    return reject(
      "stale-revision",
      `revision "${req.revision}" is stale — current is "${brief.revision}". Re-read \`dagrun gate show\`; understanding of the old evidence does not carry over`,
    );
  }
  if (!(GATE_ACTIONS as readonly string[]).includes(req.action)) {
    return reject(
      "invalid-action",
      `action must be one of ${GATE_ACTIONS.join("|")} (got "${req.action}")`,
    );
  }
  const action = req.action as GateAction;
  const comment = (req.comment ?? "").trim();
  if ((action === "amend" || action === "hold") && comment === "") {
    return reject(
      "missing-comment",
      `${action} requires --comment (the amendment feedback / the reason and evidence wanted)`,
    );
  }
  const decides = workflow.nodes.find((n) => n.id === brief.gateNodeId)?.gate
    ?.decidesNode;
  if (action === "approve" && decides !== undefined && req.runNext === undefined) {
    return reject(
      "missing-run-next",
      `approving gate "${brief.gateNodeId}" also decides whether "${decides}" runs — pass --run-next yes|no explicitly`,
    );
  }
  if (req.runNext !== undefined && !(action === "approve" && decides !== undefined)) {
    return reject(
      "unexpected-run-next",
      `--run-next only applies to approving a gate that decides a downstream node`,
    );
  }
  let target = brief.gateNodeId;
  if (action === "amend" && req.target !== undefined) {
    if (!amendTargets(workflow, brief.gateNodeId).includes(req.target)) {
      return reject(
        "bad-target",
        `cannot amend "${req.target}" from gate "${brief.gateNodeId}" — allowed: ${amendTargets(workflow, brief.gateNodeId).join(", ")}`,
      );
    }
    target = req.target;
  }
  return { ok: true, action, target };
}

// ---------------------------------------------------------------------------
// Evidence collection (read-only fs + git)
// ---------------------------------------------------------------------------

function hashFile(path: string): GateEvidenceFile | null {
  return existsSync(path) ? { path, sha256: sha256(readFileSync(path)) } : null;
}

/**
 * Snapshot the revision-relevant evidence for a paused gate: the plan, the
 * gate node's declared artifacts, completed ancestors' declared artifacts, and
 * the worktree HEAD. Any change to these yields a new revision.
 */
export function collectGateEvidence(
  runDir: string,
  state: RunState,
  workflow: Workflow,
  gateNodeId: string,
): Pick<
  GateBrief,
  | "planSha256"
  | "worktreeHead"
  | "gateArtifacts"
  | "upstreamArtifacts"
  | "revision"
> {
  const node = workflow.nodes.find((n) => n.id === gateNodeId);
  const filesFor = (id: string): GateEvidenceFile[] =>
    (workflow.nodes.find((n) => n.id === id)?.produces ?? [])
      .map((f) => hashFile(join(runDir, id, f)))
      .filter((f): f is GateEvidenceFile => f !== null);

  const gateArtifacts = node === undefined ? [] : filesFor(gateNodeId);
  const upstreamArtifacts = ancestorsOf(workflow, gateNodeId)
    .filter((id) => state.nodes[id]?.status === "done")
    .map((id) => ({ nodeId: id, files: filesFor(id) }))
    .filter((u) => u.files.length > 0);
  const plan = hashFile(join(runDir, "plan", "plan.md"));
  const planSha256 = plan?.sha256 ?? null;
  const worktreeHead = gitHead(state.worktreePath);
  const iteration = state.nodes[gateNodeId]?.iteration ?? 0;
  const revision = computeGateRevision({
    runId: state.runId,
    gateNodeId,
    iteration,
    planSha256,
    worktreeHead,
    files: [...gateArtifacts, ...upstreamArtifacts.flatMap((u) => u.files)],
  });
  return {
    planSha256,
    worktreeHead,
    gateArtifacts,
    upstreamArtifacts,
    revision,
  };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/**
 * Build the brief the originating companion reads at a gate: correct run,
 * gate, revision, evidence, mechanical validation and the pending decision.
 * `configDirs` are searched for the originating session's transcript.
 */
export function buildGateBrief(args: {
  runDir: string;
  state: RunState;
  workflow: Workflow;
  gateNodeId: string;
  configDirs: string[];
}): GateBrief {
  const { runDir, state, workflow, gateNodeId, configDirs } = args;
  const ev = collectGateEvidence(runDir, state, workflow, gateNodeId);

  const validation: GateBrief["validation"] = [];
  const checked = [gateNodeId, ...ancestorsOf(workflow, gateNodeId)];
  for (const id of checked) {
    const node = workflow.nodes.find((n) => n.id === id);
    if (node === undefined) continue;
    // Ancestors only contribute when they actually completed.
    if (id !== gateNodeId && state.nodes[id]?.status !== "done") continue;
    if (node.outcomeGate !== undefined) {
      const r = checkOutcomeGate(runDir, id, node);
      validation.push({
        nodeId: id,
        check: "outcomeGate",
        ok: r.ok,
        ...(r.ok ? {} : { detail: r.error }),
      });
    }
    if (node.noPlaceholders !== undefined) {
      const r = checkNoPlaceholders(runDir, id, node);
      validation.push({
        nodeId: id,
        check: "noPlaceholders",
        ok: r.ok,
        ...(r.ok ? {} : { detail: r.error }),
      });
    }
  }

  const assoc = state.companion;
  const sessionId = assoc?.sessionId ?? null;
  let status: "ok" | "blocked" = "ok";
  let blockedReason: string | undefined;
  let resumeHint: string | undefined;
  let resume: GateBrief["companion"]["resume"];
  if (assoc === undefined) {
    status = "blocked";
    blockedReason =
      "no originating companion session recorded for this run. Recovery: (1) attach the original session " +
      `(\`dagrun gate attach ${state.runId} --session <id>\`), or (2) attach a reconstructed session with Eddie's ` +
      "agreement (add --reconstructed), or (3) stay paused.";
  } else {
    const found = findSessionFile(assoc.sessionId, configDirs);
    const dir = found?.dir ?? null;
    if (found === null || dir === null) {
      status = "blocked";
      blockedReason =
        `originating session "${assoc.sessionId}" has no transcript in any known Claude config dir ` +
        `(${configDirs.join(", ")}). Recovery: locate it, or attach a reconstructed session with Eddie's ` +
        `agreement (\`dagrun gate attach ${state.runId} --session <id> --reconstructed\`), or stay paused.`;
    } else {
      // Newest recorded directory that still exists (a rename must not strand the session).
      const cwds = readSessionCwds(found.file);
      const cwd = cwds.find((c) => existsSync(c)) ?? cwds[0] ?? null;
      const prompt = gateResumePrompt(state.runId, gateNodeId);
      resume = { sessionId: assoc.sessionId, configDir: dir, cwd, prompt };
      resumeHint =
        `${cwd !== null ? `cd ${shq(cwd)} && ` : ""}CLAUDE_CONFIG_DIR=${shq(dir)} ` +
        `claude --resume ${assoc.sessionId} ${shq(prompt)}`;
    }
  }

  return {
    schema: 1,
    runId: state.runId,
    workflow: state.workflow,
    gateNodeId,
    iteration: state.nodes[gateNodeId]?.iteration ?? 0,
    ...ev,
    validation,
    companion: {
      sessionId,
      reconstructed: assoc?.reconstructed ?? false,
      status,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
      ...(resumeHint !== undefined ? { resumeHint } : {}),
      ...(resume !== undefined ? { resume } : {}),
    },
    pendingDecision: {
      actions: [...GATE_ACTIONS],
      ...(workflow.nodes.find((n) => n.id === gateNodeId)?.gate?.decidesNode !==
      undefined
        ? {
            decidesNode: workflow.nodes.find((n) => n.id === gateNodeId)?.gate
              ?.decidesNode as string,
          }
        : {}),
      amendTargets: amendTargets(workflow, gateNodeId),
      approveContinuesTo: approveContinuesTo(workflow, gateNodeId),
    },
  };
}

// ---------------------------------------------------------------------------
// Next-node decision (gate.decidesNode)
// ---------------------------------------------------------------------------

/** Artifact a gate writes when it decides whether a downstream node runs. */
export const NEXT_NODE_DECISION_FILE = "next-node-decision.json";

/**
 * Parse `<gate>/next-node-decision.json` for a `when` predicate. Fails loud on
 * malformed content — a missing/garbled decision must never silently run or
 * skip the node. (A missing FILE throws from ctx.read.)
 */
export function readNextNodeDecision(raw: string, nodeId: string): boolean {
  const d = JSON.parse(raw) as { node?: unknown; run?: unknown };
  if (d.node !== nodeId || typeof d.run !== "boolean") {
    throw new Error(
      `${NEXT_NODE_DECISION_FILE} malformed — expected {"node":"${nodeId}","run":<boolean>}`,
    );
  }
  return d.run;
}

// ---------------------------------------------------------------------------
// Idempotence + amend planning
// ---------------------------------------------------------------------------

/** The node whose gateHistory already records this decision id, if any. */
export function findAppliedDecision(
  state: RunState,
  id: string,
): { nodeId: string; action?: string } | null {
  for (const [nodeId, ns] of Object.entries(state.nodes)) {
    const hit = ns.gateHistory.find((h) => h.decisionId === id);
    if (hit !== undefined) {
      return { nodeId, ...(hit.action !== undefined ? { action: hit.action } : {}) };
    }
  }
  return null;
}

/**
 * Which nodes an amend invalidates. Amending the gate node itself re-runs only
 * it (existing revise-self). Amending an ancestor `target` re-runs it with the
 * feedback and resets EVERYTHING downstream of it — including the gate node and
 * any already-finished sibling — to a fresh pending state, so no stale evidence
 * is reused.
 */
export function planAmend(
  workflow: Workflow,
  gateNodeId: string,
  target: string,
): { revise: string; reset: string[] } {
  if (target === gateNodeId) return { revise: gateNodeId, reset: [] };
  return { revise: target, reset: downstreamOf(workflow, target) };
}
