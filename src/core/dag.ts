/**
 * dag.ts — DAG execution core for dagrunner.
 *
 * Three exports:
 *   computeReadyNodes — pure topological readiness check
 *   reconcileRunningNodes — crash-recovery state repair
 *   runDag — full orchestrator (Promise.all bounded by maxParallel)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node, Workflow, Ctx } from "./types.js";
import type { NodeStatus, RunState } from "./state.js";
import { writeState } from "./state.js";
import type { NodeExecutor } from "../runtime/mock-executor.js";

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
// outcomeGate — content-level pass/fail check on a produced JSON artifact
// ---------------------------------------------------------------------------

/**
 * Checked AFTER the produces-file-existence check passes. When `node.outcomeGate`
 * is absent, always ok (no expectation to violate). When present, reads
 * `outcomeGate.field` out of the JSON artifact at `runDir/nodeId/outcomeGate.file`;
 * any failure to locate/parse the file, or a value not in `passValues`, fails
 * loud with a clear message — never a silent pass. Shared by dag.ts's runDag
 * and run-engine.ts's rerunNode so the two produces/outcome checks never drift.
 */
export function checkOutcomeGate(
  runDir: string,
  nodeId: string,
  node: Node,
): { ok: true } | { ok: false; error: string } {
  const gate = node.outcomeGate;
  if (gate === undefined) return { ok: true };

  const fullPath = join(runDir, nodeId, gate.file);
  if (!existsSync(fullPath)) {
    return {
      ok: false,
      error: `outcome gate failed — ${gate.file} not found (expected field "${gate.field}")`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    return {
      ok: false,
      error: `outcome gate failed — ${gate.file} is not valid JSON`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `outcome gate failed — ${gate.file} is not a JSON object`,
    };
  }

  const value = (parsed as Record<string, unknown>)[gate.field];

  if (typeof value !== "string" || !gate.passValues.includes(value)) {
    const shown = value === undefined ? "undefined" : JSON.stringify(value);
    return {
      ok: false,
      error: `outcome gate failed — ${gate.field} = ${shown}, expected one of: ${gate.passValues.join(", ")}`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// noPlaceholders — mechanical scan for unresolved placeholder markers
// ---------------------------------------------------------------------------

/** Whole-word, case-sensitive placeholder markers a finished guide must not contain. */
const PLACEHOLDER_RE = /\b(TBD|TODO|FIXME|XXX)\b/;

/**
 * Checked AFTER the produces-file-existence check and checkOutcomeGate pass.
 * When `node.noPlaceholders` is absent or empty, always ok (no expectation to
 * violate). When present, for each named filename (relative to the node's
 * artifact dir): reads the file, blanks out fenced code-block content (a
 * guide may legitimately quote an existing `// TODO` from the codebase it
 * describes — that is not an unresolved placeholder authored by the guide),
 * then scans the remaining text for a whole-word match of TBD/TODO/FIXME/XXX.
 * A missing/unreadable file, or any match, fails loud with the filename,
 * matched token, and offending line — never a silent pass. Sibling to
 * checkOutcomeGate; same failure shape, same call site.
 */
export function checkNoPlaceholders(
  runDir: string,
  nodeId: string,
  node: Node,
): { ok: true } | { ok: false; error: string } {
  const files = node.noPlaceholders;
  if (files === undefined || files.length === 0) return { ok: true };

  for (const filename of files) {
    const fullPath = join(runDir, nodeId, filename);
    if (!existsSync(fullPath)) {
      return {
        ok: false,
        error: `noPlaceholders check failed — ${filename} not found`,
      };
    }

    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      return {
        ok: false,
        error: `noPlaceholders check failed — ${filename} could not be read`,
      };
    }

    // Blank fenced code-block content while preserving line numbers/newlines
    // (so the reported line number below matches the file on disk exactly).
    const stripped = content.replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/[^\n]/g, " "),
    );

    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const match = PLACEHOLDER_RE.exec(line);
      if (match !== null) {
        return {
          ok: false,
          error:
            `noPlaceholders check failed — ${filename} contains placeholder ` +
            `marker "${match[1] ?? ""}" at line ${String(i + 1)}: "${line.trim()}"`,
        };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Interrupt-retry cap
// ---------------------------------------------------------------------------

/** Max times a process-interrupted node is reset to pending before it stays failed. */
export const MAX_INTERRUPT_RETRIES = 2;

const INTERRUPT_ERROR = "process interrupted — reconciled on resume";

/**
 * For each node that failed with the interrupt-reconcile error, reset it to
 * pending (incrementing interruptRetries) if under cap, or leave it failed if
 * at/over cap. Ordinary failures are untouched.
 */
export function resetInterruptedNodes(
  state: RunState,
  maxRetries: number,
): RunState {
  let nodes = { ...state.nodes };
  let changed = false;
  for (const [id, ns] of Object.entries(nodes)) {
    if (ns.status !== "failed" || ns.error !== INTERRUPT_ERROR) continue;
    const retries = ns.interruptRetries ?? 0;
    if (retries < maxRetries) {
      // Omit error/endedAt — exactOptionalPropertyTypes forbids explicit undefined.
      const { error: _e, endedAt: _ea, ...nsRest } = ns;
      nodes = {
        ...nodes,
        [id]: { ...nsRest, status: "pending", interruptRetries: retries + 1 },
      };
      changed = true;
    }
    // else: cap hit — leave as failed
  }
  return changed
    ? { ...state, nodes, updatedAt: new Date().toISOString() }
    : state;
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
          const gateCheck = checkOutcomeGate(runDir, id, node);
          if (!gateCheck.ok) {
            updateNode(id, {
              status: "failed",
              error: gateCheck.error,
              endedAt: now,
            });
          } else {
            const placeholderCheck = checkNoPlaceholders(runDir, id, node);
            if (!placeholderCheck.ok) {
              updateNode(id, {
                status: "failed",
                error: placeholderCheck.error,
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
          }
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
