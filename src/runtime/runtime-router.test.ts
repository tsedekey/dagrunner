import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRouterExecutor, makeDefaultExecutorFactory } from "./runtime-router.js";
import type { NodeExecutor, NodeExecResult } from "./mock-executor.js";
import type { Node, Workflow } from "../core/types.js";

const tag = (name: string, calls: string[]): NodeExecutor => async (id) => {
  calls.push(`${name}:${id}`);
  return { status: "done", artifacts: [], cost: 0, sessionId: name } as NodeExecResult;
};
const ctx = { runDir: "/r", artifactsDir: "/r/a", worktreePath: "/w" };
const nodes: Node[] = [
  { id: "a", command: "/a" },
  { id: "b", command: "/b", runtime: "copilot" },
  { id: "c", command: "/c", runtime: "claude" },
];

test("router: dispatches per node by resolved runtime (node > workflow > default)", async () => {
  const calls: string[] = [];
  const claudeWf: Workflow = { name: "w", nodes };
  const r1 = makeRouterExecutor(claudeWf, tag("claude", calls), tag("copilot", calls));
  for (const n of nodes) await r1(n.id, n, ctx);
  assert.deepEqual(calls, ["claude:a", "copilot:b", "claude:c"]);

  calls.length = 0;
  const copilotWf: Workflow = { name: "w", nodes, runtime: "copilot" };
  const r2 = makeRouterExecutor(copilotWf, tag("claude", calls), tag("copilot", calls));
  for (const n of nodes) await r2(n.id, n, ctx);
  assert.deepEqual(calls, ["copilot:a", "copilot:b", "claude:c"]);
});

test("default factory: all-claude workflow never touches the copilot runner", async () => {
  // makeDefaultExecutorFactory builds both runners lazily-safe: constructing is free,
  // and routing a claude node must not call the copilot builder.
  let copilotBuilt = 0;
  const calls: string[] = [];
  const factory = makeDefaultExecutorFactory(
    { name: "w", nodes: [{ id: "a", command: "/a" }] },
    undefined,
    {
      claude: () => tag("claude", calls),
      copilot: () => { copilotBuilt++; return tag("copilot", calls); },
    },
  );
  const ex = factory({ DEVHARNESS_SRC: "/s" }, "r", "/r", "/w", "/st");
  await ex("a", { id: "a", command: "/a" }, ctx);
  assert.deepEqual(calls, ["claude:a"]);
  assert.equal(copilotBuilt, 0, "copilot runner is built only when a node resolves to copilot");
});
