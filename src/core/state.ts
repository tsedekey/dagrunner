/**
 * RunState — persistent state for a dagrunner run.
 *
 * This module defines the full state shape (matching Architecture Spec Theme 2)
 * and provides real read/write helpers backed by fs.readFileSync/writeFileSync.
 *
 * readState / writeState are REAL implementations (not stubs): the tier-1
 * state round-trip test (test 5) requires them to work before the engine
 * is built. The engine may extend this module in Block 4.
 *
 * reconcileRunningNodes — a stub that documents the contract the engine must
 * satisfy. Calling it throws 'not implemented' until Block 4 fills it in.
 * It lives here so state.ts is self-contained; the tier-1 reconcile test
 * imports it from dag.ts (see dag.test.ts), not from here.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { appendEvent, deriveEvents } from "./events.js";

// ---------------------------------------------------------------------------
// Status unions
// ---------------------------------------------------------------------------

export type NodeStatus =
  "pending" | "running" | "done" | "skipped" | "failed" | "awaiting-gate";

export type RunStatus = "running" | "paused" | "done" | "failed" | "aborted";

// ---------------------------------------------------------------------------
// Gate history
// ---------------------------------------------------------------------------

export type GateHistoryEntry = {
  /** "hold" records a paused-with-reason decision; it never changes node status. */
  decision: "approve" | "reject" | "hold";
  comment?: string;
  timestamp: string;
  /** "night" when this was an auto-approval in unattended mode. */
  mode?: "night";
  /** Human-readable rationale for an auto-decision (e.g. "no concerns flagged"). */
  basis?: string;
  /** Companion-gate binding: the gate revision this decision was made against. */
  revision?: string;
  /** Companion-gate action as issued ("amend" is recorded as decision "reject"). */
  action?: "approve" | "amend" | "hold";
  /** Node re-run by an amend (the gate node itself, or a gated ancestor). */
  target?: string;
  /** Deterministic id of the decision — a repeat of the same id is a no-op. */
  decisionId?: string;
  /** Nodes reset to pending by this decision (evidence invalidated). */
  invalidated?: string[];
  /** Exact resume point after this decision, e.g. "run implement,review,fix". */
  resumePoint?: string;
};

// ---------------------------------------------------------------------------
// Originating companion association
// ---------------------------------------------------------------------------

/**
 * The planning-companion conversation that handed this run off. Gates return
 * to it (see core/gate.ts). Absent on legacy runs, which keep the old
 * fresh-session gate behavior.
 */
export type CompanionAssociation = {
  /** CLAUDE_CODE_SESSION_ID of the originating companion. */
  sessionId: string;
  associatedAt: string;
  /** Claude config dir that held the session transcript when it was recorded. */
  configDir?: string;
  /** How the association was made. */
  source: "handoff" | "attach";
  /** True when Eddie agreed to a reconstructed fallback session. */
  reconstructed: boolean;
};

// ---------------------------------------------------------------------------
// Per-node state
// ---------------------------------------------------------------------------

export type NodeState = {
  status: NodeStatus;
  startedAt?: string;
  endedAt?: string;
  /** Absolute paths to artifact files produced by this node. */
  artifacts: string[];
  /** Model tier actually used (or 'unpinned'). */
  model?: string;
  /** Current loop / gate iteration count. */
  iteration: number;
  /** Claude session ID, persisted for gate resume. */
  sessionId?: string;
  /** Cumulative cost in USD for this node's SDK session(s). */
  cost: number;
  /** History of gate decisions for this node. */
  gateHistory: GateHistoryEntry[];
  /** Last error message if status === 'failed'. */
  error?: string;
  /** Number of interrupt-driven retries consumed. Absent = 0. */
  interruptRetries?: number;
  /**
   * One entry per completed execution of this node (done / failed / paused at a
   * gate), in order. The top-level startedAt/endedAt/cost describe only the
   * latest execution; this keeps earlier iterations (amend / gate revise / rerun)
   * from being overwritten. Carried across resets by the engine.
   */
  attempts?: NodeAttempt[];
};

export type NodeAttempt = {
  iteration: number;
  status: NodeStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Cost of THIS execution only (not cumulative). */
  cost: number;
};

// ---------------------------------------------------------------------------
// Run-level state
// ---------------------------------------------------------------------------

export type RunState = {
  runId: string;
  workflow: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  worktreePath: string;
  branch: string;
  sourcePlanPath: string;
  /** Keyed by node id. */
  nodes: Record<string, NodeState>;
  /** Base branch from plan frontmatter (e.g. "release/1.x"). Defaults to "main" if absent. */
  baseBranch?: string;
  /** Bug severity from plan frontmatter (e.g. "critical", "blocker", "major", "minor"). */
  severity?: string;
  /** Issue URL from plan frontmatter. Used by pr node for "closes #" line. */
  issueUrl?: string;
  /** Originating companion conversation; presence switches gates to companion mode. */
  companion?: CompanionAssociation;
};

// ---------------------------------------------------------------------------
// I/O helpers (real implementations — required by tier-1 test 5)
// ---------------------------------------------------------------------------

/**
 * Read and parse state.json from the given path.
 * Throws if the file does not exist or is not valid JSON.
 */
export function readState(path: string): RunState {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as RunState;
}

/**
 * Serialise state to disk at the given path (pretty-printed, 2-space indent).
 * Overwrites atomically (single writeFileSync call).
 */
export function writeState(path: string, state: RunState): void {
  // Derive the run's event log from this transition (state.json only). Best
  // effort: an unreadable previous file or a failed append never blocks the write.
  let events: ReturnType<typeof deriveEvents> = [];
  if (basename(path) === "state.json") {
    try {
      const prev = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunState) : null;
      events = deriveEvents(prev, state, new Date().toISOString());
    } catch {
      events = [];
    }
  }
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  for (const ev of events) appendEvent(dirname(path), ev);
}
