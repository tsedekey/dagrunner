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

test("bugfixWorkflow: has exactly 7 nodes", () => {
  assert.equal(bugfixWorkflow.nodes.length, 7);
});

test("bugfixWorkflow: node ids are reproduce, implement, review, fix, verify, pr, digest", () => {
  const ids = bugfixWorkflow.nodes.map((n) => n.id);
  assert.deepEqual(ids, [
    "reproduce",
    "implement",
    "review",
    "fix",
    "verify",
    "pr",
    "digest",
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

test("bugfixWorkflow: verify is an OPTIONAL runtime demonstration decided at the fix gate", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined, "verify node must exist");
  assert.ok(node.dependsOn?.includes("fix"), "verify must depend on fix");
  assert.equal(node.gate, undefined, "verify must have no human gate");
  assert.equal(node.command, "/verify", "shared /verify prompt — no bugfix-only verify command");
  assert.ok(node.when !== undefined, "verify must be skippable via a `when` reading the fix-gate decision");
  assert.equal(
    bugfixWorkflow.nodes.find((n) => n.id === "fix")?.gate?.decidesNode,
    "verify",
    "the fix gate decides whether verify runs",
  );
  // Only a DEMONSTRATED report passes; NOT_DEMONSTRATED / BLOCKED_RUNTIME fail the node.
  assert.deepEqual(node.outcomeGate, {
    file: "verify-report.json",
    field: "outcome",
    passValues: ["DEMONSTRATED"],
  });
  assert.equal(node.evidenceCheck, "verify-runtime");
});

test("bugfixWorkflow: verify produces the report and the manual demo write-up", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined);
  assert.deepEqual(node.produces, ["verify-report.json", "demo.md"]);
});

test("bugfixWorkflow: pr and digest tolerate a skipped verify (joinRule) but a failed verify still blocks", () => {
  for (const id of ["pr", "digest"]) {
    const n = bugfixWorkflow.nodes.find((x) => x.id === id);
    assert.equal(n?.joinRule, "none-failed-min-one-success", id);
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

test("bugfixWorkflow: pr depends on fix and verify", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "pr");
  assert.ok(node !== undefined);
  assert.ok(node.dependsOn?.includes("fix"), "pr must depend on fix");
  assert.ok(node.dependsOn?.includes("verify"), "pr must depend on verify");
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

// ---------------------------------------------------------------------------
// digest node — terminal-adjacent, parallel with pr (see DECISIONS.md
// § digest-node)
// ---------------------------------------------------------------------------

test("bugfixWorkflow: digest depends on both fix and verify (same deps as pr, runs in parallel)", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "digest");
  assert.ok(node !== undefined, "digest node must exist");
  assert.ok(node.dependsOn?.includes("fix"), "digest must depend on fix");
  assert.ok(node.dependsOn?.includes("verify"), "digest must depend on verify");
});

test("bugfixWorkflow: digest uses sonnet, produces knowledge-map.md, and has no gate", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "digest");
  assert.ok(node !== undefined);
  assert.equal(node.model, "sonnet");
  assert.deepEqual(node.produces, ["knowledge-map.md"]);
  assert.equal(
    node.gate,
    undefined,
    "digest must have no human gate — informational/read-only, same pattern as review",
  );
});

test("bugfixWorkflow: digest is optional — a produces-contract failure must degrade to skipped, never fail a run whose pr already shipped", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "digest");
  assert.ok(node !== undefined);
  assert.equal(
    node.optional,
    true,
    "digest must be optional — unlike verify (deliberately required/blocking), digest is informational-only and nothing downstream depends on it",
  );
});
