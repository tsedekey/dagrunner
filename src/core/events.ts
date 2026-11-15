/**
 * events.ts — append-only run event log: <runDir>/events.jsonl.
 *
 * DERIVED history, never a second source of truth: state.json stays
 * authoritative. Events are computed by diffing the previous state.json on disk
 * against the state being written (see writeState in state.ts), so every engine
 * transition point (runDag, resumeRun, night mode, amend, abort …) is covered by
 * one choke point instead of scattered emit calls. Gate-opened (which needs the
 * gate revision, only known once the brief is built) is the one explicit emit.
 *
 * A write failure warns on stderr and is swallowed — observability must never
 * fail a run.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./state.js";

export type RunEvent = {
  ts: string;
  type: string;
  node?: string;
  iteration?: number;
  detail?: Record<string, unknown>;
};

export const EVENTS_FILE = "events.jsonl";

export function appendEvent(runDir: string, ev: RunEvent): void {
  try {
    appendFileSync(join(runDir, EVENTS_FILE), JSON.stringify(ev) + "\n", "utf8");
  } catch (e) {
    process.stderr.write(
      `dagrun: warning — could not append to ${join(runDir, EVENTS_FILE)}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/** All events, oldest first. Missing file (legacy run) = []. Unparseable lines are skipped. */
export function readEvents(runDir: string): RunEvent[] {
  const f = join(runDir, EVENTS_FILE);
  if (!existsSync(f)) return [];
  const out: RunEvent[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as RunEvent);
    } catch {
      // torn/garbled line — skip, never throw from a read-only observer
    }
  }
  return out;
}

export function lastEventAt(runDir: string): string | null {
  const evs = readEvents(runDir);
  return evs.length === 0 ? null : (evs[evs.length - 1] as RunEvent).ts;
}

/** Pure diff of two states into events. `prev === null` means the run is new. */
export function deriveEvents(prev: RunState | null, next: RunState, ts: string): RunEvent[] {
  const out: RunEvent[] = [];
  if (prev === null) {
    out.push({ ts, type: "run.started", detail: { runId: next.runId, workflow: next.workflow, status: next.status } });
  }
  for (const [id, ns] of Object.entries(next.nodes)) {
    const was = prev?.nodes[id];
    const wasStatus = was?.status ?? "pending";
    if (ns.status !== wasStatus) {
      if (ns.status === "running") {
        out.push({ ts, type: "node.started", node: id, iteration: ns.iteration });
      } else if (ns.status === "done" || ns.status === "failed" || ns.status === "skipped" || ns.status === "awaiting-gate") {
        const dur =
          ns.startedAt !== undefined && ns.endedAt !== undefined
            ? Date.parse(ns.endedAt) - Date.parse(ns.startedAt)
            : undefined;
        out.push({
          ts,
          type: "node.finished",
          node: id,
          iteration: ns.iteration,
          detail: {
            status: ns.status,
            ...(dur !== undefined && !Number.isNaN(dur) ? { durationMs: dur } : {}),
            cost: ns.cost,
            ...(ns.error !== undefined ? { error: ns.error } : {}),
          },
        });
      } else if (ns.status === "pending" && wasStatus === "running") {
        out.push({ ts, type: "node.retry", node: id, iteration: ns.iteration });
      } else if (ns.status === "pending") {
        out.push({ ts, type: "node.invalidated", node: id, iteration: ns.iteration, detail: { from: wasStatus } });
      }
    }
    const before = was?.gateHistory.length ?? 0;
    for (const h of ns.gateHistory.slice(before)) {
      out.push({
        ts,
        type: "gate.decision",
        node: id,
        iteration: ns.iteration,
        detail: {
          action: h.action ?? h.decision,
          ...(h.decisionId !== undefined ? { decisionId: h.decisionId } : {}),
          ...(h.target !== undefined ? { target: h.target } : {}),
          ...(h.revision !== undefined ? { revision: h.revision } : {}),
          ...(h.invalidated !== undefined ? { invalidated: h.invalidated } : {}),
        },
      });
    }
  }
  // Status change last, so a node finish and the run pausing/finishing in one write read in causal order.
  if (prev !== null && prev.status !== next.status) {
    out.push({ ts, type: "run.status", detail: { from: prev.status, to: next.status } });
  }
  return out;
}
