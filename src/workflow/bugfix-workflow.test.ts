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

test("bugfixWorkflow: verify depends on fix, is required (non-optional), and has an outcomeGate", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined, "verify node must exist");
  assert.ok(node.dependsOn?.includes("fix"), "verify must depend on fix");
  assert.notEqual(
    node.optional,
    true,
    "verify must be required (non-optional) — it blocks pr on a bad outcome",
  );
  assert.equal(node.gate, undefined, "verify must have no human gate");
  // DEFERRED_TO_CI (added by the verify-defer-to-ci change, see DECISIONS.md
  // § verify-defer-to-ci-and-drop-diff-scoped-rerun) is a non-blocking outcome:
  // a confirmed pre-existing, diff-unrelated build break in Step 4 must not
  // hard-fail the node and block pr the way a genuine FAIL_BUILD does.
  assert.deepEqual(node.outcomeGate, {
    file: "verify-report.json",
    field: "outcome",
    passValues: ["PASS", "DEFERRED_TO_CI"],
  });
});

// Run 56962-1 forensic fix (bug 1): verify.md documents legitimate
// short-circuit paths (Docker unreachable at Step 0; unrecoverable stall
// with no usable report, ERROR_INFRA) where it explicitly instructs "Do NOT
// write a verify-plan.md — no authoring work happened." A hard produces
// requirement on verify-plan.md trips the DAG's produces-contract check even
// on these correct, prompt-following paths. verify-report.json remains
// load-bearing (already gated via outcomeGate above); only the unconditional
// verify-plan.md requirement is dropped.
test("bugfixWorkflow: verify's produces contract does not hard-require verify-plan.md (conditional per verify.md's short-circuit paths)", () => {
  const node = bugfixWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined);
  assert.deepEqual(node.produces, ["verify-report.json"]);
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
