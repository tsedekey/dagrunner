/**
 * bugfix-workflow.test.ts — schema-contract tests for bugfixWorkflow.
 *
 * Mirrors the pattern from feature-workflow.test.ts:
 *   bugfixWorkflow must pass loadWorkflow (valid dependsOn chain, node ids, model strings).
 *
 * Run with:
 *   node --test --import tsx src/workflow/bugfix-workflow.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { bugfixWorkflow } from "./bugfix-workflow.js";
import { loadWorkflow } from "./workflow.js";

// ---------------------------------------------------------------------------
// loadWorkflow contract
// ---------------------------------------------------------------------------

test("bugfixWorkflow: passes loadWorkflow (valid workflow)", () => {
  // loadWorkflow throws on invalid workflows — if this passes, the schema is valid.
  assert.doesNotThrow(() => loadWorkflow(bugfixWorkflow));
});

test("bugfixWorkflow: name is 'bugfix'", () => {
  assert.equal(bugfixWorkflow.name, "bugfix");
});

// ---------------------------------------------------------------------------
// Node shape
// ---------------------------------------------------------------------------

test("bugfixWorkflow: has exactly 5 nodes", () => {
  assert.equal(bugfixWorkflow.nodes.length, 5);
});

test("bugfixWorkflow: node ids are reproduce, implement, review, fix, pr", () => {
  const ids = bugfixWorkflow.nodes.map((n) => n.id);
  assert.deepEqual(ids, [
    "reproduce",
    "implement",
    "review",
    "fix",
    "pr",
  ]);
});

test("bugfixWorkflow: reproduce produces guide.md and has a gate", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "reproduce");
  assert.ok(node !== undefined, "reproduce node must exist");
  assert.deepEqual(node.produces, ["guide.md"]);
  assert.ok(node.gate !== undefined, "reproduce must have a gate");
});

test("bugfixWorkflow: implement depends on reproduce", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "implement");
  assert.ok(node !== undefined);
  assert.ok(
    node.dependsOn?.includes("reproduce"),
    "implement must depend on reproduce",
  );
});

test("bugfixWorkflow: review depends on implement", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "review");
  assert.ok(node !== undefined);
  assert.ok(
    node.dependsOn?.includes("implement"),
    "review must depend on implement",
  );
});

test("bugfixWorkflow: fix depends on review and has a gate", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "fix");
  assert.ok(node !== undefined);
  assert.ok(node.dependsOn?.includes("review"), "fix must depend on review");
  assert.ok(node.gate !== undefined, "fix must have a gate");
});

test("bugfixWorkflow: there is no verify node and no node declares decidesNode / joinRule / evidenceCheck", () => {
  assert.equal(bugfixWorkflow.nodes.find((n) => n.id === "verify"), undefined);
  for (const n of bugfixWorkflow.nodes) {
    assert.equal((n.gate as Record<string, unknown> | undefined)?.decidesNode, undefined, `${n.id}: no gate decides a downstream node`);
    assert.equal((n as Record<string, unknown>).joinRule, undefined, `${n.id}: no joinRule`);
    assert.equal((n as Record<string, unknown>).evidenceCheck, undefined, `${n.id}: no evidenceCheck`);
    assert.equal(n.when, undefined, `${n.id}: every node always runs`);
  }
});

test("bugfixWorkflow: every gate returns to the companion; pr is a pre-PR gate that can amend fix", () => {
  assert.equal(bugfixWorkflow.companionGates, true);
  const pr = bugfixWorkflow.nodes.find((n) => n.id === "pr");
  assert.ok(pr?.gate !== undefined, "pr must be gated (pre-PR decision)");
  assert.deepEqual(pr.gate.amendTargets, ["fix"]);
  assert.deepEqual(
    bugfixWorkflow.nodes.filter((n) => n.gate !== undefined).map((n) => n.id),
    ["reproduce", "fix", "pr"],
  );
});

test("bugfixWorkflow: pr depends on fix only", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "pr");
  assert.ok(node !== undefined);
  assert.deepEqual(node.dependsOn, ["fix"]);
});

test("bugfixWorkflow: pr uses haiku model", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "pr");
  assert.ok(node !== undefined);
  assert.equal(node.model, "haiku");
});

test("bugfixWorkflow: fix has revisionInstruction", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "fix");
  assert.ok(node !== undefined);
  assert.ok(
    typeof node.revisionInstruction === "string" &&
      node.revisionInstruction.length > 0,
    "fix must have revisionInstruction",
  );
});

test("bugfixWorkflow: implement and fix have formatCommand", () => {
  for (const nodeId of ["implement", "fix"] as const) {
    const node = bugfixWorkflow.nodes.find((n) => n.id === nodeId);
    assert.ok(node !== undefined);
    assert.ok(
      typeof node.formatCommand === "string" && node.formatCommand.length > 0,
      `${nodeId} must have formatCommand`,
    );
  }
});

// ---------------------------------------------------------------------------
// implement/fix effort — pinned to "medium" (see DECISIONS.md
// § effort-tuning-implement-fix)
// ---------------------------------------------------------------------------

test("bugfixWorkflow: implement and fix pin effort to 'medium'", () => {
  for (const nodeId of ["implement", "fix"] as const) {
    const node = bugfixWorkflow.nodes.find((n) => n.id === nodeId);
    assert.ok(node !== undefined, `${nodeId} node must exist`);
    assert.equal(
      node.effort,
      "medium",
      `${nodeId} must pin effort to "medium"`,
    );
  }
});

// digest node removed (DECISIONS.md § digest-removed-folded-into-companion) —
// its two-section content (deferred findings/risks, open reviewer questions)
// is now folded into the companion's gate-reading step at the fix/pr gates;
// the companion gate conversation it used to duplicate now covers it live.
