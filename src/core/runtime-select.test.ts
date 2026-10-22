import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRuntime,
  workflowRuntimes,
  copilotUnsupportedFields,
} from "./runtime-select.js";
import { loadWorkflow } from "../workflow/workflow.js";
import type { Node, Workflow } from "./types.js";

const n = (over: Partial<Node> = {}): Node => ({ id: "a", command: "/a", ...over });
const wf = (nodes: Node[], runtime?: unknown): Workflow =>
  ({ name: "w", nodes, ...(runtime !== undefined ? { runtime } : {}) }) as Workflow;

test("resolveRuntime: default claude; workflow overrides default; node overrides workflow", () => {
  assert.equal(resolveRuntime(n(), wf([n()])), "claude");
  assert.equal(resolveRuntime(n(), wf([n()], "copilot")), "copilot");
  assert.equal(resolveRuntime(n({ runtime: "claude" }), wf([n()], "copilot")), "claude");
  assert.equal(resolveRuntime(n({ runtime: "copilot" }), wf([n()], "claude")), "copilot");
  assert.equal(resolveRuntime(n({ runtime: "copilot" }), wf([n()])), "copilot");
});

test("workflowRuntimes: the set of runtimes the nodes actually resolve to", () => {
  assert.deepEqual([...workflowRuntimes(wf([n()]))], ["claude"]);
  const mixed = wf([n(), n({ id: "b", runtime: "copilot" })]);
  assert.deepEqual([...workflowRuntimes(mixed)].sort(), ["claude", "copilot"]);
  const allCopilot = wf([n(), n({ id: "b", runtime: "copilot" })], "copilot");
  assert.deepEqual([...workflowRuntimes(allCopilot)], ["copilot"]);
});

test("copilotUnsupportedFields: lists Claude-only node features", () => {
  assert.deepEqual(copilotUnsupportedFields(n()), []);
  assert.deepEqual(
    copilotUnsupportedFields(n({ gate: {}, formatCommand: "x", effort: "low" })).sort(),
    ["effort", "formatCommand", "gate"],
  );
});

test("loadWorkflow: unknown node runtime is a load error naming the node", () => {
  assert.throws(
    () => loadWorkflow(wf([n({ runtime: "gemini" as never })])),
    /node "a" has invalid runtime value "gemini"/,
  );
});

test("loadWorkflow: unknown workflow runtime is a load error", () => {
  assert.throws(() => loadWorkflow(wf([n()], "gemini")), /workflow "w" has invalid runtime value "gemini"/);
});

test("loadWorkflow: valid runtimes pass", () => {
  loadWorkflow(wf([n({ runtime: "copilot" })], "claude"));
});

test("loadWorkflow: copilot on a node using a Claude-only feature fails loud (node-level and workflow-level)", () => {
  assert.throws(
    () => loadWorkflow(wf([n({ runtime: "copilot", gate: {} })])),
    /node "a" resolves to runtime "copilot" but uses gate/,
  );
  // Workflow-level copilot hits every node that does not opt back to claude.
  assert.throws(
    () => loadWorkflow(wf([n({ formatCommand: "x" })], "copilot")),
    /node "a" resolves to runtime "copilot" but uses formatCommand/,
  );
  // Opting that node back to claude is fine.
  loadWorkflow(wf([n({ formatCommand: "x", runtime: "claude" }), n({ id: "b" })], "copilot"));
});
