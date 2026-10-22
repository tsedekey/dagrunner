/**
 * runtime-select.ts — pure agent-runtime resolution (no SDK, no fs).
 *
 * `runtime` is settable per node AND per workflow; precedence is
 * node > workflow > "claude". Shared by loadWorkflow (validation), the router
 * executor (dispatch) and preflight (which prerequisites to check) so all three
 * agree on one answer. See DECISIONS.md § copilot-runtime.
 */

import type { Node, Runtime, Workflow } from "./types.js";

export const RUNTIMES: ReadonlyArray<Runtime> = ["claude", "copilot"];

export const DEFAULT_RUNTIME: Runtime = "claude";

export function resolveRuntime(
  node: Pick<Node, "runtime">,
  workflow: Pick<Workflow, "runtime">,
): Runtime {
  return node.runtime ?? workflow.runtime ?? DEFAULT_RUNTIME;
}

/** The set of runtimes the workflow's nodes actually resolve to. */
export function workflowRuntimes(workflow: Workflow): Set<Runtime> {
  return new Set(workflow.nodes.map((n) => resolveRuntime(n, workflow)));
}

/**
 * Node fields only the Claude runner implements (they ride Claude Code
 * settings.json hooks, `claude --resume` gate reopen, or Claude-only SDK
 * options). A copilot-resolved node using one would have it silently ignored,
 * so loadWorkflow rejects the combination instead ("fail loud").
 */
export const COPILOT_UNSUPPORTED_NODE_FIELDS = [
  "gate",
  "loop",
  "hooks",
  "formatCommand",
  "allowedTools",
  "maxBudget",
  "effort",
] as const satisfies ReadonlyArray<keyof Node>;

export function copilotUnsupportedFields(node: Node): string[] {
  return COPILOT_UNSUPPORTED_NODE_FIELDS.filter((f) => node[f] !== undefined);
}
