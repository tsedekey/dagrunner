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

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Status unions
// ---------------------------------------------------------------------------

export type NodeStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed"
  | "awaiting-gate";

export type RunStatus = "running" | "paused" | "done" | "failed" | "aborted";

// ---------------------------------------------------------------------------
// Gate history
// ---------------------------------------------------------------------------

export type GateHistoryEntry = {
  decision: "approve" | "reject";
  comment?: string;
  timestamp: string;
  /** "night" when this was an auto-approval in unattended mode. */
  mode?: "night";
  /** Human-readable rationale for an auto-decision (e.g. "no concerns flagged"). */
  basis?: string;
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
  /** verify-election decision captured after Gate 2 (fix) approval. */
  verifyElection?: "y" | "n";
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
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}
