/**
 * dag.ts — DAG execution core for dagrunner.
 *
 * Three exports:
 *   computeReadyNodes — pure topological readiness check
 *   reconcileRunningNodes — crash-recovery state repair
 *   runDag — full orchestrator (Promise.all bounded by maxParallel)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Node, Workflow, Ctx } from "./types.js";
import type { NodeStatus, RunState } from "./state.js";
import { writeState } from "./state.js";
import type { NodeExecutor } from "./mock-executor.js";

// ---------------------------------------------------------------------------
// computeReadyNodes
// ---------------------------------------------------------------------------

/**
 * Returns the IDs of nodes eligible to run right now.
 *
 * A node is ready when:
 *   (a) status === 'pending'
 *   (b) when predicate (if present and ctx provided) returns true
 *   (c) all deps are terminal (done|skipped|failed|awaiting-gate)
 *   (d) no required dep is failed or skipped (skipped = not-done, blocks non-optional)
 *
 * joinRule 'none-failed-min-one-success': all deps terminal, ≥1 done, no required dep failed.
 */
export function computeReadyNodes(
  nodes: Node[],
  statuses: Record<string, NodeStatus>,
  ctx?: Ctx,
): string[] {
  // Build a quick id → node map for optional lookups.
  const nodeMap = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const terminal: ReadonlySet<NodeStatus> = new Set([
    "done",
    "skipped",
    "failed",
    "awaiting-gate",
  ]);

  const ready: string[] = [];

  for (const node of nodes) {
    const status = statuses[node.id];
    if (status !== "pending") continue;

    // Evaluate when predicate → skip (mark pending caller's job; just exclude from ready).
    if (node.when !== undefined && ctx !== undefined && !node.when(ctx))
      continue;

    const deps = node.dependsOn ?? [];

    if (node.joinRule === "none-failed-min-one-success") {
      // All deps must be terminal; ≥1 must be done; no required dep may be failed.
      const allTerminal = deps.every((d) =>
        terminal.has(statuses[d] ?? "pending"),
      );
      if (!allTerminal) continue;
      const atLeastOneDone = deps.some((d) => statuses[d] === "done");
      if (!atLeastOneDone) continue;
      const requiredFailed = deps.some((d) => {
        const depStatus = statuses[d];
        const depNode = nodeMap.get(d);
        return depStatus === "failed" && depNode?.optional !== true;
      });
      if (requiredFailed) continue;
    } else {
      // Default rule: every dep must be done; skipped/failed deps on non-optional block.
      let blocked = false;
      for (const depId of deps) {
        const depStatus = statuses[depId] ?? "pending";
        const depNode = nodeMap.get(depId);
        const isOptional = depNode?.optional === true;

        if (depStatus === "done") continue;
        if (depStatus === "failed" && isOptional) continue; // optional fail → treat as skipped, non-blocking for deps check
        if (depStatus === "skipped" && isOptional) continue; // optional skipped dep is terminal and non-blocking
        // Any other non-done status (pending, running, awaiting-gate, skipped, failed-required) blocks.
        blocked = true;
        break;
      }
      if (blocked) continue;
    }

    ready.push(node.id);
  }

  return ready;
}

// ---------------------------------------------------------------------------
// reconcileRunningNodes
// ---------------------------------------------------------------------------

/**
 * Set every 'running' node to 'failed' (crash recovery).
 * Does NOT touch lockfiles — caller's responsibility.
 */
export function reconcileRunningNodes(state: RunState): RunState {
  const nodes = { ...state.nodes };
  for (const [id, ns] of Object.entries(nodes)) {
    if (ns.status === "running") {
      nodes[id] = {
        ...ns,
        status: "failed",
        error: "process interrupted — reconciled on resume",
      };
    }
  }
  return { ...state, nodes, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// runDag
// ---------------------------------------------------------------------------

/**
 * Orchestrate the DAG: run ready nodes with Promise.all bounded by maxParallel.
 * Writes state after every node completion.
 *
 * Completion semantics:
 *   done     → verify produces → done (or failed if files missing)
 *   failed + optional          → skipped
 *   failed + retryable + retry remaining → retry once
 *   failed + non-optional (terminal) → halt run as 'failed', return
 *   awaiting-gate              → checkpoint: write state, return early
 */
export async function runDag(
  workflow: Workflow,
  executor: NodeExecutor,
  state: RunState,
  opts: { maxParallel?: number; ctx: Ctx; stateFile: string },
): Promise<RunState> {
  const parallel = opts.maxParallel ?? workflow.maxParallel ?? 6;
  const { ctx, stateFile } = opts;

  const nodeMap = new Map<string, Node>(workflow.nodes.map((n) => [n.id, n]));

  // Mutable state copy we update as nodes complete.
  let run = { ...state, nodes: { ...state.nodes } };

  // Track retries: nodeId → retry count used.
  const retries = new Map<string, number>();

  // Build per-node artifact dirs from the stateFile path (parent = run dir).
  const runDir = stateFile.replace(/\/state\.json$/, "");

  function statusMap(): Record<string, NodeStatus> {
    const m: Record<string, NodeStatus> = {};
    for (const [id, ns] of Object.entries(run.nodes)) {
      m[id] = ns.status;
    }
    return m;
  }

  function allTerminal(): boolean {
    return Object.values(run.nodes).every((ns) =>
      ["done", "skipped", "failed", "awaiting-gate"].includes(ns.status),
    );
  }

  function updateNode(
    id: string,
    patch: Partial<(typeof run.nodes)[string]>,
  ): void {
    const existing = run.nodes[id];
    if (existing === undefined) return;
    run = {
      ...run,
      nodes: { ...run.nodes, [id]: { ...existing, ...patch } },
      updatedAt: new Date().toISOString(),
    };
  }

  function save(): void {
    writeState(stateFile, run);
  }

  // Main scheduling loop.
  while (!allTerminal()) {
    // Evaluate when predicates: skip pending nodes whose predicate returns false.
    // Only evaluate when all deps are terminal — ctx.json() may not be safe otherwise.
    const terminalStatuses: ReadonlySet<NodeStatus> = new Set([
      "done",
      "skipped",
      "failed",
      "awaiting-gate",
    ]);
    for (const node of workflow.nodes) {
      const ns = run.nodes[node.id];
      if (ns?.status !== "pending" || node.when === undefined) continue;
      // Guard: all deps must be terminal before evaluating the when predicate.
      const deps = node.dependsOn ?? [];
      const depsTerminal = deps.every((d) =>
        terminalStatuses.has(statusMap()[d] ?? "pending"),
      );
      if (!depsTerminal) continue;
      if (!node.when(ctx)) {
        updateNode(node.id, {
          status: "skipped",
          endedAt: new Date().toISOString(),
        });
        save();
      }
    }

    const ready = computeReadyNodes(workflow.nodes, statusMap(), ctx).filter(
      (id) => {
        const ns = run.nodes[id];
        return ns?.status === "pending";
      },
    );

    if (ready.length === 0) break; // Nothing to do (deadlock or all done).

    // Take up to parallel slots.
    const batch = ready.slice(0, parallel);

    // Mark all batch nodes as running.
    for (const id of batch) {
      updateNode(id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
    save();

    // Execute batch concurrently.
    const results = await Promise.all(
      batch.map(async (id) => {
        const node = nodeMap.get(id);
        if (node === undefined)
          throw new Error(`runDag: node "${id}" not in workflow`);
        const artifactsDir = join(runDir, id);
        const priorSessionId = run.nodes[id]?.sessionId;
        const execCtx = {
          runDir,
          artifactsDir,
          worktreePath: run.worktreePath,
          ...(priorSessionId !== undefined
            ? { sessionId: priorSessionId }
            : {}),
        };
        const result = await executor(id, node, execCtx);
        return { id, node, result };
      }),
    );

    // Process results in two passes to avoid losing sibling results when a gate is hit.
    // Pass 1: process all non-gate results (done, failed, retry); also short-circuit on hard failures.
    let gateResult: (typeof results)[number] | undefined;
    for (const { id, node, result } of results) {
      const now = new Date().toISOString();

      if (result.status === "awaiting-gate") {
        // Defer gate handling to pass 2; continue processing siblings.
        gateResult = { id, node, result };
        continue;
      }

      if (result.status === "done") {
        // Verify produces files exist.
        const missing = (node.produces ?? []).filter((f) => {
          const full = join(runDir, id, f);
          return !existsSync(full);
        });

        if (missing.length > 0) {
          updateNode(id, {
            status: "failed",
            error: `produces contract violated — missing: ${missing.join(", ")}`,
            endedAt: now,
          });
        } else {
          updateNode(id, {
            status: "done",
            artifacts: result.artifacts,
            cost: result.cost,
            sessionId: result.sessionId,
            endedAt: now,
          });
        }
      } else {
        // result.status === 'failed'
        const retryCount = retries.get(id) ?? 0;
        const maxRetries = node.maxRetries ?? 2;

        if (result.retryable && retryCount < maxRetries) {
          // Retry: reset to pending, increment retry counter.
          retries.set(id, retryCount + 1);
          updateNode(id, { status: "pending" });
        } else if (node.optional === true) {
          updateNode(id, {
            status: "skipped",
            error: result.error,
            endedAt: now,
          });
        } else {
          // Non-optional, terminal failure — short-circuit immediately.
          updateNode(id, {
            status: "failed",
            error: result.error,
            endedAt: now,
          });
          run = { ...run, status: "failed" };
          save();
          return run;
        }
      }

      save();
    }

    // Pass 2: if any awaiting-gate result was found, checkpoint-and-exit now.
    if (gateResult !== undefined) {
      const { id, result } = gateResult;
      const now = new Date().toISOString();
      // result is narrowed to awaiting-gate by the gateResult assignment above.
      const gateRes = result as Extract<
        typeof result,
        { status: "awaiting-gate" }
      >;
      updateNode(id, {
        status: "awaiting-gate",
        sessionId: gateRes.sessionId,
        iteration: gateRes.iteration,
        cost: (run.nodes[id]?.cost ?? 0) + gateRes.cost,
        endedAt: now,
      });
      run = { ...run, status: "paused" };
      save();
      return run; // Checkpoint-and-exit.
    }
  }

  // Bug 2: mark any remaining pending nodes as skipped (blocked-by-skipped-dep chains).
  // These are nodes that can never become ready because their only path was cut off.
  for (const [id, ns] of Object.entries(run.nodes)) {
    if (ns.status === "pending") {
      updateNode(id, {
        status: "skipped",
        endedAt: new Date().toISOString(),
      });
    }
  }
  save();

  // Check final run status.
  const anyFailed = Object.values(run.nodes).some(
    (ns) => ns.status === "failed",
  );
  run = {
    ...run,
    status: anyFailed ? "failed" : "done",
    updatedAt: new Date().toISOString(),
  };
  save();
  return run;
}
