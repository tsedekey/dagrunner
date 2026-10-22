/**
 * runtime-router.ts — per-node executor dispatch by resolved runtime.
 *
 * The engine's `ExecutorFactory` seam is unchanged: an injected
 * `executorFactory` (mock runs, smoke) still replaces everything. Only the
 * DEFAULT factory changes — from "always makeSDKRunner" to "router that picks
 * makeSDKRunner or makeCopilotRunner per node" (node > workflow > "claude").
 * The copilot runner is constructed lazily, so an all-claude workflow never
 * touches it (and `@github/copilot-sdk` is only dynamic-imported inside it); the
 * claude runner is likewise built only when a node resolves to it.
 */

import type { DagrunnerConfig } from "../config/xdg.js";
import type { Workflow } from "../core/types.js";
import { resolveRuntime } from "../core/runtime-select.js";
import type { NodeExecutor } from "./mock-executor.js";
import { makeSDKRunner } from "./sdk-runner.js";
import { makeCopilotRunner } from "./copilot-runner.js";

export type ExecutorFactory = (
  config: DagrunnerConfig,
  runId: string,
  runDir: string,
  worktreePath: string,
  storeDir: string,
) => NodeExecutor;

export function makeRouterExecutor(
  workflow: Pick<Workflow, "runtime">,
  claude: NodeExecutor,
  copilot: NodeExecutor,
): NodeExecutor {
  return (nodeId, node, ctx) =>
    (resolveRuntime(node, workflow) === "copilot" ? copilot : claude)(
      nodeId,
      node,
      ctx,
    );
}

export function makeDefaultExecutorFactory(
  workflow: Workflow,
  nightMode?: boolean,
  builders: {
    claude: ExecutorFactory;
    copilot: ExecutorFactory;
  } = {
    claude: (c, rid, rdir, wt, sd) =>
      makeSDKRunner(c, rid, rdir, wt, sd, nightMode),
    copilot: makeCopilotRunner,
  },
): ExecutorFactory {
  return (config, runId, runDir, worktreePath, storeDir) => {
    // Both runners are built lazily, once, the first time a node resolves to them.
    let claude: NodeExecutor | undefined;
    let copilot: NodeExecutor | undefined;
    return makeRouterExecutor(
      workflow,
      (nodeId, node, ctx) => {
        claude ??= builders.claude(config, runId, runDir, worktreePath, storeDir);
        return claude(nodeId, node, ctx);
      },
      (nodeId, node, ctx) => {
        copilot ??= builders.copilot(config, runId, runDir, worktreePath, storeDir);
        return copilot(nodeId, node, ctx);
      },
    );
  };
}
