/**
 * run-snapshot.ts — the read model `dagrun ui` renders a run from.
 *
 * Wraps `cli/status-json.ts`'s `buildStatusJson` (the same function `dagrun
 * status --json` uses) so the CLI and the UI can never drift on node status,
 * timing, cost, or the awaiting-gate computation — one function, two callers.
 * Layers on only what the timeline viewer needs and the CLI does not carry:
 * workflow node order + serializable node definitions (so bugfix and feature
 * both render from their own declared pipeline, nothing hardcoded here), the
 * raw run status, the hero fields (branch, base, issue URL, plan title), each
 * node's gate history / skip reason / on-disk files, and the gate CARD.
 *
 * Real-data quirks handled here (found by the mockup author on run 59478-2):
 *   - `gate.json` keeps `pendingDecision` after approval -> the gate card is
 *     built ONLY when the raw run status is `paused` AND a node is awaiting-gate,
 *     and only from a brief whose `gateNodeId` matches the awaiting node.
 *   - `issueUrl` is stored with literal surrounding quotes -> stripped; anything
 *     not http(s) is dropped (it ends up in an href).
 *   - two different ways a node becomes `skipped` -> the gate's
 *     `next-node-decision.json` (`run:false`) is read to tell "decision" apart.
 *   - a node's files can exist on disk before state registers them -> listing
 *     comes from disk (`status --json` artifacts), plus the engine bookkeeping
 *     files (gate.json, burn.json, gate-context.md) the CLI listing hides.
 *
 * Strictly read-only: reads state.json (via buildStatusJson) and a handful of
 * small files. Never calls `buildGateBrief`/`emitGateBrief` (git, writes) and
 * never writes anything — see DECISIONS.md § agent-driven-slice3-ui.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { buildStatusJson, type StatusJson } from "../cli/status-json.js";
import { readState } from "../core/state.js";
import type {
  GateHistoryEntry,
  NodeAttempt,
  RunStatus,
} from "../core/state.js";
import type { GateBrief } from "../core/gate.js";
import type { Node, Workflow } from "../core/types.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";

export type NodeDef = {
  command: string;
  model: string | null;
  effort: string | null;
  dependsOn: string[];
  produces: string[];
  joinRule: string | null;
  optional: boolean;
  /** `when` is a function and cannot be serialized — the viewer only needs to know one exists. */
  hasWhen: boolean;
  gate: {
    maxIterations: number;
    decidesNode: string | null;
    amendTargets: string[];
  } | null;
};

export type NodeFileView = {
  name: string;
  path: string;
  registered: boolean;
  /** Engine bookkeeping (gate.json, burn.json, gate-context.md) — on disk but not a declared deliverable. */
  bookkeeping: boolean;
  size: number | null;
  mtime: string | null;
};

export type SkipReason = "decision" | "optional" | "when";

export type GateCard = {
  nodeId: string;
  reason: string;
  since: string | null;
  /** null = the gate has not been opened yet (no persisted gate.json). */
  revision: string | null;
  openedAt: string | null;
  /** 1-based round shown to the human: brief.iteration + 1 (state.json's own number is `iteration`). */
  round: number;
  iteration: number;
  maxIterations: number;
  actions: string[];
  amendTargets: string[];
  decidesNode: string | null;
  approveContinuesTo: string[];
  evidence: { name: string; sha: string }[];
  validation: { nodeId: string; check: string; ok: boolean }[];
  upstream: string[];
  companion: {
    sessionId: string | null;
    status: string;
    reconstructed: boolean;
    cwd: string | null;
  } | null;
  /** The agent's own advice for the decided node, from `<gate>/summary.md` "## Verify recommendation". */
  advice: string | null;
  decisions: number;
};

export type RunSnapshot = Omit<StatusJson, "nodes"> & {
  /** Node ids: the workflow's declared pipeline order, then any legacy state-only nodes. */
  nodeOrder: string[];
  /** Serializable node definitions for nodes the CURRENT workflow defines. */
  defs: Record<string, NodeDef>;
  createdAt: string;
  updatedAt: string;
  /** Raw `state.status` — `status` above folds `paused` into `awaiting-gate`. */
  runStatus: RunStatus;
  branch: string;
  baseBranch: string | null;
  issueUrl: string | null;
  planTitle: string | null;
  totalCost: number;
  nodes: Record<
    string,
    StatusJson["nodes"][string] & {
      gateHistory: GateHistoryEntry[];
      model: string | null;
      sessionId: string | null;
      error: string | null;
      skipReason: SkipReason | null;
      files: NodeFileView[];
      attempts: NodeAttempt[];
    }
  >;
  /**
   * The persisted brief for the awaiting gate, read as-is from
   * `<gate>/gate.json` — never recomputed here. Null when no gate is
   * awaiting, or when one is but `dagrun gate show|open|decide` has never
   * been run against it yet (companion-gates runs only write it at that
   * point; legacy/no-companion gates never write it at all).
   */
  gateBrief: GateBrief | null;
  /** The gate card to show — null unless the run is `paused` AND a node is awaiting-gate. */
  gate: GateCard | null;
};

function workflowFor(name: string): Workflow | undefined {
  if (name === "bugfix") return bugfixWorkflow;
  if (name === "feature") return featureWorkflow;
  return undefined;
}

function defOf(n: Node): NodeDef {
  return {
    command: n.command,
    model: n.model ?? null,
    effort: n.effort ?? null,
    dependsOn: n.dependsOn ?? [],
    produces: n.produces ?? [],
    joinRule: n.joinRule ?? null,
    optional: n.optional === true,
    hasWhen: n.when !== undefined,
    gate:
      n.gate !== undefined
        ? {
            maxIterations: n.gate.maxIterations ?? 10,
            decidesNode: n.gate.decidesNode ?? null,
            amendTargets: n.gate.amendTargets ?? [],
          }
        : null,
  };
}

/** `"https://…"` (quoted, as state.json stores it) -> `https://…`; anything that is not http(s) -> null. */
export function cleanIssueUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : null;
}

function readPlanTitle(runDir: string): string | null {
  try {
    const text = readFileSync(join(runDir, "plan", "plan.md"), "utf8");
    const m =
      /^title:\s*"(.*)"\s*$/m.exec(text) ?? /^title:\s*(.+?)\s*$/m.exec(text);
    const t = m?.[1]?.replace(/\s+—\s+Fix Plan$/, "").trim();
    return t !== undefined && t !== "" ? t : null;
  } catch {
    return null;
  }
}

const BOOKKEEPING = ["gate.json", "burn.json", "gate-context.md"];

function nodeFiles(
  runDir: string,
  id: string,
  listed: StatusJson["nodes"][string]["artifacts"],
): NodeFileView[] {
  const out: NodeFileView[] = listed.map((a) => ({
    name: basename(a.path),
    path: a.path,
    registered: a.registered,
    bookkeeping: false,
    size: a.size,
    mtime: a.mtime,
  }));
  const have = new Set(out.map((f) => f.name));
  for (const name of BOOKKEEPING) {
    const path = join(runDir, id, name);
    if (have.has(name) || !existsSync(path)) continue;
    try {
      const s = statSync(path);
      out.push({
        name,
        path,
        registered: false,
        bookkeeping: true,
        size: s.size,
        mtime: s.mtime.toISOString(),
      });
    } catch {
      // vanished mid-listing — skip
    }
  }
  return out;
}

function skipReasonFor(
  runDir: string,
  id: string,
  defs: Record<string, NodeDef>,
): SkipReason | null {
  const gateNode = Object.entries(defs).find(
    ([, d]) => d.gate?.decidesNode === id,
  )?.[0];
  if (gateNode !== undefined) {
    try {
      const d = JSON.parse(
        readFileSync(join(runDir, gateNode, "next-node-decision.json"), "utf8"),
      ) as {
        node?: unknown;
        run?: unknown;
      };
      if (d.node === id && d.run === false) return "decision";
    } catch {
      // no / unreadable decision file — fall through
    }
  }
  const def = defs[id];
  if (def === undefined) return null;
  return def.optional ? "optional" : "when";
}

function readAdvice(runDir: string, gateNode: string): string | null {
  try {
    const md = readFileSync(join(runDir, gateNode, "summary.md"), "utf8");
    const m = /## Verify recommendation\s+([\s\S]*?)(\n## |$)/.exec(md);
    const t = m?.[1]?.trim();
    return t !== undefined && t !== "" ? t : null;
  } catch {
    return null;
  }
}

/** Build the full run-detail snapshot the UI serves at `/api/runs/:id`. Throws exactly as `buildStatusJson` does for a missing/invalid run. */
export function buildRunSnapshot(homeDir: string, runId: string): RunSnapshot {
  const statusJson = buildStatusJson(homeDir, runId);
  const runDir = join(homeDir, "runs", runId);
  const state = readState(join(runDir, "state.json"));

  const workflow = workflowFor(state.workflow);
  const defs: Record<string, NodeDef> = {};
  for (const n of workflow?.nodes ?? []) defs[n.id] = defOf(n);
  const wfIds = workflow !== undefined ? workflow.nodes.map((n) => n.id) : [];
  const nodeOrder = [
    ...wfIds,
    ...Object.keys(state.nodes).filter((id) => !wfIds.includes(id)),
  ];

  const totalCost = Object.values(state.nodes).reduce(
    (sum, ns) => sum + ns.cost,
    0,
  );

  const nodes: RunSnapshot["nodes"] = {};
  for (const id of nodeOrder) {
    const ns = state.nodes[id];
    const entry = statusJson.nodes[id];
    if (ns === undefined || entry === undefined) {
      // In the workflow but not (yet) in this run's state — render as untouched, never throw.
      nodes[id] = {
        status: "pending",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [],
        attempts: [],
        gateHistory: [],
        model: null,
        sessionId: null,
        error: null,
        skipReason: null,
        files: nodeFiles(runDir, id, []),
      };
      continue;
    }
    nodes[id] = {
      ...entry,
      gateHistory: ns.gateHistory,
      model: ns.model ?? null,
      sessionId: ns.sessionId ?? null,
      error: ns.error ?? null,
      skipReason:
        ns.status === "skipped" ? skipReasonFor(runDir, id, defs) : null,
      files: nodeFiles(runDir, id, entry.artifacts),
    };
  }

  // The gate card exists only while the run is genuinely paused at a gate.
  let gateBrief: GateBrief | null = null;
  let gate: GateCard | null = null;
  const ag = statusJson.awaitingGate;
  if (ag !== null && state.status === "paused") {
    const briefPath = join(runDir, ag.nodeId, "gate.json");
    if (existsSync(briefPath)) {
      try {
        const parsed = JSON.parse(readFileSync(briefPath, "utf8")) as GateBrief;
        // A brief left behind by a different gate is not THIS gate's brief.
        if (parsed.gateNodeId === ag.nodeId) gateBrief = parsed;
      } catch {
        gateBrief = null; // torn/garbled — degrade to the lighter card, never throw
      }
    }
    const def = defs[ag.nodeId];
    const pd = gateBrief?.pendingDecision;
    const decides = pd?.decidesNode ?? def?.gate?.decidesNode ?? null;
    const comp = gateBrief?.companion;
    const sessionId = comp?.sessionId ?? state.companion?.sessionId ?? null;
    gate = {
      nodeId: ag.nodeId,
      reason: ag.reason,
      since: ag.since,
      revision: gateBrief?.revision ?? null,
      openedAt: gateBrief?.openedAt ?? null,
      round:
        (gateBrief?.iteration ?? state.nodes[ag.nodeId]?.iteration ?? 0) + 1,
      iteration: gateBrief?.iteration ?? state.nodes[ag.nodeId]?.iteration ?? 0,
      maxIterations: def?.gate?.maxIterations ?? 10,
      actions: pd?.actions ?? ["approve", "amend", "hold"],
      amendTargets: pd?.amendTargets ?? def?.gate?.amendTargets ?? [],
      decidesNode: decides,
      approveContinuesTo: pd?.approveContinuesTo ?? [],
      evidence: (gateBrief?.gateArtifacts ?? []).map((a) => ({
        name: basename(a.path),
        sha: a.sha256.slice(0, 12),
      })),
      validation: (gateBrief?.validation ?? []).map((v) => ({
        nodeId: v.nodeId,
        check: v.check,
        ok: v.ok,
      })),
      upstream: (gateBrief?.upstreamArtifacts ?? []).map((u) => u.nodeId),
      companion:
        comp !== undefined || sessionId !== null
          ? {
              sessionId,
              status: comp?.status ?? "ok",
              reconstructed:
                comp?.reconstructed ?? state.companion?.reconstructed ?? false,
              cwd: comp?.resume?.cwd ?? null,
            }
          : null,
      advice: decides !== null ? readAdvice(runDir, ag.nodeId) : null,
      decisions: Object.values(state.nodes).reduce(
        (n, ns) => n + ns.gateHistory.length,
        0,
      ),
    };
  }

  return {
    ...statusJson,
    nodeOrder,
    defs,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    runStatus: state.status,
    branch: state.branch,
    baseBranch: state.baseBranch ?? null,
    issueUrl: cleanIssueUrl(state.issueUrl),
    planTitle: readPlanTitle(runDir),
    totalCost,
    nodes,
    gateBrief,
    gate,
  };
}

/** Names of node directories on disk — used by the artifact endpoint to bound what a URL may name. */
export function nodeDirNames(runDir: string): string[] {
  try {
    return readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
