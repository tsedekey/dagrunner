/**
 * run-engine.test.ts — unit tests for pure exports only.
 *
 * Scope: pure exported helpers (makeRunId). NOT orchestration — startRun,
 * resumeRun, runDag, and their collaborators are Tier C and owned by smoke.
 * This file tests only the extracted pure functions that have no orchestration
 * dependencies. See DECISIONS.md § unit-test-backfill-2b.
 *
 * Run with:
 *   node --test --import tsx src/runtime/run-engine.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeRunId,
  formatVerifyRecommendation,
  findWorktreeScratch,
  worktreeArtifactPatterns,
} from "./run-engine.js";

// ---------------------------------------------------------------------------
// makeRunId
// ---------------------------------------------------------------------------

test("makeRunId: converts plan basename to slug and appends timestamp", () => {
  const result = makeRunId("/a/b/my-plan.md", 123);
  assert.equal(result, "my-plan-123");
});

test("makeRunId: special chars in filename are replaced with hyphens", () => {
  const result = makeRunId("/path/to/My Plan (v2).md", 456);
  // uppercase → lowercase, spaces and parens → hyphens
  assert.ok(result.endsWith("-456"), `expected to end with -456: ${result}`);
  assert.ok(
    /^[a-z0-9-]+-456$/.test(result),
    `slug must be lowercase alnum+hyphens: ${result}`,
  );
});

test("makeRunId: filename without .md extension — .md stripped only", () => {
  const result = makeRunId("/path/to/plan.md", 789);
  assert.equal(result, "plan-789");
});

test("makeRunId: timestamp zero produces slug-0", () => {
  const result = makeRunId("/x/simple.md", 0);
  assert.equal(result, "simple-0");
});

// ---------------------------------------------------------------------------
// formatVerifyRecommendation
// ---------------------------------------------------------------------------

const makeFindings = (
  recommended: boolean,
  surface: string,
  rationale: string,
) => ({
  run_id: "r",
  timestamp: "t",
  triage: {
    touches_public_api: false,
    touches_runtime: false,
    touches_schema_or_proto: false,
    performance_sensitive: false,
    touches_ui: false,
  },
  reviewers_run: [],
  reviewers_skipped: [],
  adversarial_verifier_run: false,
  manual_test_recommendation: { recommended, surface, rationale },
  findings: [],
});

test("formatVerifyRecommendation: api surface → recommended advisory with 'api'", () => {
  const result = formatVerifyRecommendation(
    makeFindings(true, "api", "adds a new REST endpoint"),
  );
  assert.ok(
    result.includes("recommended"),
    `expected 'recommended' in: ${result}`,
  );
  assert.ok(result.includes("api"), `expected 'api' in: ${result}`);
  assert.ok(
    result.includes("adds a new REST endpoint"),
    `expected rationale in: ${result}`,
  );
});

test("formatVerifyRecommendation: ui surface → recommended advisory with 'ui'", () => {
  const result = formatVerifyRecommendation(
    makeFindings(true, "ui", "modifies a user-facing component"),
  );
  assert.ok(
    result.includes("recommended"),
    `expected 'recommended' in: ${result}`,
  );
  assert.ok(result.includes("ui"), `expected 'ui' in: ${result}`);
});

test("formatVerifyRecommendation: none surface → not-recommended advisory", () => {
  const result = formatVerifyRecommendation(
    makeFindings(false, "none", "internal change only"),
  );
  assert.ok(
    result.includes("not recommended"),
    `expected 'not recommended' in: ${result}`,
  );
  assert.ok(
    result.includes("internal change only"),
    `expected rationale in: ${result}`,
  );
});

test("formatVerifyRecommendation: api and ui produce distinct strings (teeth)", () => {
  const api = formatVerifyRecommendation(makeFindings(true, "api", "endpoint"));
  const ui = formatVerifyRecommendation(makeFindings(true, "ui", "component"));
  assert.notEqual(
    api,
    ui,
    "api and ui paths must produce distinct advisory text",
  );
});

test("formatVerifyRecommendation: null input degrades to empty string", () => {
  assert.equal(formatVerifyRecommendation(null), "");
});

test("formatVerifyRecommendation: missing manual_test_recommendation degrades to empty string", () => {
  assert.equal(formatVerifyRecommendation({ run_id: "x" }), "");
});

test("formatVerifyRecommendation: malformed rec object (no recommended) degrades to empty string", () => {
  assert.equal(
    formatVerifyRecommendation({
      manual_test_recommendation: { surface: "api" },
    }),
    "",
  );
});

test("formatVerifyRecommendation: plain-text findings.json (mock executor output) degrades to empty string", () => {
  // The mock executor writes plain text, not JSON — simulate what happens after JSON.parse fails.
  // formatVerifyRecommendation receives a string (the result of parsing a non-JSON file would throw
  // before reaching this function; here we test the string-input degrade path directly).
  assert.equal(
    formatVerifyRecommendation("# Mock artifact: findings.json\n"),
    "",
  );
});

// ---------------------------------------------------------------------------
// findWorktreeScratch
// ---------------------------------------------------------------------------

test("findWorktreeScratch: ignored artifact filename is flagged (!! prefix)", () => {
  const result = findWorktreeScratch(["!! guide.md"], ["guide.md"]);
  assert.deepEqual(result, ["guide.md"]);
});

test("findWorktreeScratch: untracked artifact filename is flagged (?? prefix)", () => {
  const result = findWorktreeScratch(["?? guide.md"], ["guide.md"]);
  assert.deepEqual(result, ["guide.md"]);
});

test("findWorktreeScratch: clean worktree returns empty array", () => {
  const result = findWorktreeScratch([], ["guide.md", "summary.md"]);
  assert.deepEqual(result, []);
});

test("findWorktreeScratch: glob suffix pattern *.tmp matches", () => {
  const result = findWorktreeScratch(
    ["!! scratch.tmp", "?? other.ts"],
    ["*.tmp"],
  );
  assert.deepEqual(result, ["scratch.tmp"]);
});

test("findWorktreeScratch: glob suffix pattern *-state.json matches", () => {
  const result = findWorktreeScratch(["!! dag-state.json"], ["*-state.json"]);
  assert.deepEqual(result, ["dag-state.json"]);
});

test("findWorktreeScratch: non-matching untracked file is NOT flagged", () => {
  const result = findWorktreeScratch(
    ["?? src/legitimate-source.ts"],
    ["guide.md"],
  );
  assert.deepEqual(result, []);
});

test("findWorktreeScratch: nested path — basename is used for matching", () => {
  const result = findWorktreeScratch(["!! subdir/guide.md"], ["guide.md"]);
  assert.deepEqual(result, ["subdir/guide.md"]);
});

test("findWorktreeScratch: multiple matches returned together", () => {
  const result = findWorktreeScratch(
    ["!! guide.md", "!! summary.md", "?? source.ts"],
    ["guide.md", "summary.md"],
  );
  assert.deepEqual(result, ["guide.md", "summary.md"]);
});

test("findWorktreeScratch: malformed line without space is ignored (teeth)", () => {
  // A porcelain line must be "XY path" (two status chars + space). Without the
  // space, the parser should not crash and should return no matches.
  const result = findWorktreeScratch(["!!guide.md"], ["guide.md"]);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// worktreeArtifactPatterns
// ---------------------------------------------------------------------------

test("worktreeArtifactPatterns: includes all featureWorkflow produces filenames", () => {
  const patterns = worktreeArtifactPatterns();
  // All declared produces across featureWorkflow nodes.
  const expected = [
    "guide.md",
    "summary.md",
    "findings.json",
    "seeding-spec.json",
    "manual-test.md",
    "body.md",
    "camunda-knowledge.md",
    "dagrunner-proposals.md",
    "apply-summary.md",
  ];
  for (const name of expected) {
    assert.ok(
      patterns.includes(name),
      `expected pattern "${name}" in worktreeArtifactPatterns()`,
    );
  }
});

test("worktreeArtifactPatterns: includes secondary scratch patterns", () => {
  const patterns = worktreeArtifactPatterns();
  for (const p of ["*.tmp", "*-state.json", "pr-meta.json", ".gitignore"]) {
    assert.ok(patterns.includes(p), `expected secondary pattern "${p}"`);
  }
});

test("worktreeArtifactPatterns: no duplicates", () => {
  const patterns = worktreeArtifactPatterns();
  const unique = new Set(patterns);
  assert.equal(
    patterns.length,
    unique.size,
    `duplicate patterns found: ${patterns.filter((p, i) => patterns.indexOf(p) !== i).join(", ")}`,
  );
});
