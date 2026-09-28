/**
 * run-snapshot.ts — the read model `dagrun ui` renders a run from.
 *
 * Wraps `cli/status-json.ts`'s `buildStatusJson` (the same function `dagrun
 * status --json` uses) so the CLI and the UI can never drift on node status,
 * timing, cost, or the awaiting-gate computation — one function, two callers.
 * Adds only what a timeline viewer needs on top: workflow node order (so
 * bugfix and feature workflows both render in their own declared pipeline
 * order, with no node list hardcoded here), each node's gate decision
 * history, and — when a node is awaiting a gate — the gate brief already
 * persisted to disk at `<gate>/gate.json`.
 *
 * Strictly read-only: reads state.json (via buildStatusJson) and, at most,
 * one `gate.json` file. Never calls `buildGateBrief`/`emitGateBrief` (which
 * spawns git and needs companion config-dir resolution) and never writes
 * anything — see DECISIONS.md § agent-driven-slice3-ui.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStatusJson, type StatusJson } from "../cli/status-json.js";
import { readState } from "../core/state.js";
import type { GateHistoryEntry } from "../core/state.js";
import type { GateBrief } from "../core/gate.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";

export type RunSnapshot = Omit<StatusJson, "nodes"> & {
  /** Node ids in the workflow's own declared pipeline order. */
  nodeOrder: string[];
  createdAt: string;
  totalCost: number;
  nodes: Record<
    string,
    StatusJson["nodes"][string] & { gateHistory: GateHistoryEntry[] }
  >;
  /**
   * The persisted brief for the awaiting gate, read as-is from
   * `<gate>/gate.json` — never recomputed here. Null when no gate is
   * awaiting, or when one is but `dagrun gate show|open|decide` has never
   * been run against it yet (companion-gates runs only write it at that
   * point; legacy/no-companion gates never write it at all).
   */
  gateBrief: GateBrief | null;
};

function workflowFor(name: string): { nodes: { id: string }[] } | undefined {
  if (name === "bugfix") return bugfixWorkflow;
  if (name === "feature") return featureWorkflow;
  return undefined;
}

/** Build the full run-detail snapshot the UI serves at `/api/runs/:id`. Throws exactly as `buildStatusJson` does for a missing/invalid run. */
export function buildRunSnapshot(homeDir: string, runId: string): RunSnapshot {
  const statusJson = buildStatusJson(homeDir, runId);
  const runDir = join(homeDir, "runs", runId);
  const state = readState(join(runDir, "state.json"));

  const workflow = workflowFor(state.workflow);
  const nodeOrder =
    workflow !== undefined
      ? workflow.nodes.map((n) => n.id)
      : Object.keys(state.nodes);

  const totalCost = Object.values(state.nodes).reduce(
    (sum, ns) => sum + ns.cost,
    0,
  );

  const nodes: RunSnapshot["nodes"] = {};
  for (const [id, entry] of Object.entries(statusJson.nodes)) {
    nodes[id] = { ...entry, gateHistory: state.nodes[id]?.gateHistory ?? [] };
  }

  let gateBrief: GateBrief | null = null;
  if (statusJson.awaitingGate !== null) {
    const briefPath = join(runDir, statusJson.awaitingGate.nodeId, "gate.json");
    if (existsSync(briefPath)) {
      try {
        gateBrief = JSON.parse(readFileSync(briefPath, "utf8")) as GateBrief;
      } catch {
        gateBrief = null; // torn/garbled — degrade to the lighter awaitingGate banner, never throw
      }
    }
  }

  return {
    ...statusJson,
    nodeOrder,
    createdAt: state.createdAt,
    totalCost,
    nodes,
    gateBrief,
  };
}
