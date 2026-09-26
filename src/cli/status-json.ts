/**
 * status-json.ts — `dagrun status [<run>] --json`.
 *
 * Strictly READ-ONLY view for agents/viewers: derived from state.json, the run
 * lock (the only liveness mechanism) and events.jsonl. Never emits a gate brief
 * (that writes files) and never touches the lock.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readState } from "../core/state.js";
import type { NodeAttempt, RunStatus } from "../core/state.js";
import { isPidAlive, readLock } from "../core/lock.js";
import { readEvents } from "../core/events.js";
import { listNodeFiles, type NodeFile } from "../core/node-files.js";

export type StatusJson = {
  runId: string;
  workflow: string;
  status: RunStatus | "awaiting-gate";
  /** status is "running" but no live process holds this run's lock (crashed / killed driver). */
  stale: boolean;
  currentNodes: string[];
  awaitingGate: { nodeId: string; revision: string | null; since: string | null; reason: string } | null;
  nodes: Record<
    string,
    {
      status: string;
      iteration: number;
      startedAt: string | null;
      endedAt: string | null;
      durationMs: number | null;
      cost: number;
      /** Registered artifacts first, then unregistered on-disk files (registered:false). */
      artifacts: NodeFile[];
      attempts: NodeAttempt[];
    }
  >;
  companion: { sessionId: string } | null;
  lastEventAt: string | null;
  /** Live lock holder for this run, or null. */
  driver: { pid: number; startedAt: string } | null;
};

export function buildStatusJson(homeDir: string, runId: string): StatusJson {
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) {
    if (existsSync(join(runDir, "driver.log"))) {
      throw new Error(
        `run "${runId}" has no state.json yet — its detached driver is still starting or died early; see ${join(runDir, "driver.log")}`,
      );
    }
    throw new Error(`run "${runId}" not found at ${stateFile}`);
  }
  const state = readState(stateFile);
  const events = readEvents(runDir);

  const lock = readLock(homeDir);
  const driver =
    lock !== null && lock.runId === runId && isPidAlive(lock.pid)
      ? { pid: lock.pid, startedAt: lock.startedAt }
      : null;

  const gateEntry = Object.entries(state.nodes).find(([, ns]) => ns.status === "awaiting-gate");
  const terminal = state.status === "done" || state.status === "failed" || state.status === "aborted";
  const status: StatusJson["status"] = terminal
    ? state.status
    : gateEntry !== undefined
      ? "awaiting-gate"
      : state.status;

  let awaitingGate: StatusJson["awaitingGate"] = null;
  if (gateEntry !== undefined && !terminal) {
    const [nodeId, ns] = gateEntry;
    const opened = [...events].reverse().find((e) => e.type === "gate.opened" && e.node === nodeId);
    const rev = opened?.detail?.["revision"];
    const last = ns.gateHistory[ns.gateHistory.length - 1];
    awaitingGate = {
      nodeId,
      revision: typeof rev === "string" ? rev : null,
      since: opened?.ts ?? ns.endedAt ?? null,
      reason:
        last?.decision === "hold"
          ? `held: ${last.comment ?? ""}`.trim()
          : `awaiting ${state.companion !== undefined ? "companion" : "human"} decision at gate "${nodeId}"`,
    };
  }

  const nodes: StatusJson["nodes"] = {};
  for (const [id, ns] of Object.entries(state.nodes)) {
    const dur =
      ns.startedAt !== undefined && ns.endedAt !== undefined ? Date.parse(ns.endedAt) - Date.parse(ns.startedAt) : NaN;
    nodes[id] = {
      status: ns.status,
      iteration: ns.iteration,
      startedAt: ns.startedAt ?? null,
      endedAt: ns.endedAt ?? null,
      durationMs: Number.isNaN(dur) ? null : dur,
      cost: ns.cost,
      artifacts: listNodeFiles(runDir, id, ns.artifacts),
      attempts: ns.attempts ?? [],
    };
  }

  return {
    runId: state.runId,
    workflow: state.workflow,
    status,
    stale: state.status === "running" && driver === null && gateEntry === undefined,
    currentNodes: Object.entries(state.nodes).filter(([, ns]) => ns.status === "running").map(([id]) => id),
    awaitingGate,
    nodes,
    companion: state.companion !== undefined ? { sessionId: state.companion.sessionId } : null,
    lastEventAt: events.length > 0 ? (events[events.length - 1] as { ts: string }).ts : state.updatedAt,
    driver,
  };
}
