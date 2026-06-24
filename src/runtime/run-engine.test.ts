/**
 * run-engine.test.ts — unit tests for pure exports only.
 *
 * Scope: pure exported helpers (makeRunId, makeBranchName, makePrTitlePrefix).
 * NOT orchestration — startRun, resumeRun, runDag, and their collaborators are
 * Tier C and owned by smoke. This file tests only the extracted pure functions
 * that have no orchestration dependencies. See DECISIONS.md § unit-test-backfill-2b.
 *
 * Run with:
 *   node --test --import tsx src/runtime/run-engine.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeRunId,
  makeBranchName,
  makePrTitlePrefix,
  formatVerifyRecommendation,
  findWorktreeScratch,
  worktreeArtifactPatterns,
  agentDecidable,
  hasConcerns,
  seedWorktreeSiblings,
  parseGateDecision,
  parseFrontmatter,
  severityForcesPause,
} from "./run-engine.js";

// ---------------------------------------------------------------------------
// makeRunId
// ---------------------------------------------------------------------------

test("makeRunId: extracts issue number from filename, first run returns {issueNum}-1", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "dr-runid-"));
  const result = makeRunId(
    "/plans/53856-single-job-priority-update-grpc-plan.md",
    runsDir,
  );
  assert.equal(result, "53856-1");
});

test("makeRunId: second run (runsDir has 53856-1) returns 53856-2", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "dr-runid-"));
  mkdirSync(join(runsDir, "53856-1"), { recursive: true });
  const result = makeRunId(
    "/plans/53856-single-job-priority-update-grpc-plan.md",
    runsDir,
  );
  assert.equal(result, "53856-2");
});

test("makeRunId: no issue number in filename falls back to 0-N", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "dr-runid-"));
  const result = makeRunId(
    "/plans/single-job-priority-update-grpc-plan.md",
    runsDir,
  );
  assert.equal(result, "0-1");
});

test("makeRunId: runsDir does not exist — count starts at 1 (no error)", () => {
  const result = makeRunId("/plans/53856-my-plan.md", "/nonexistent/runs/dir");
  assert.equal(result, "53856-1");
});

test("makeRunId: skips entries that don't match {issueNum}-N pattern", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "dr-runid-"));
  // An unrelated run dir should not affect the count
  mkdirSync(join(runsDir, "scaffold-fix-1234567890"), { recursive: true });
  mkdirSync(join(runsDir, "53856-1"), { recursive: true });
  const result = makeRunId("/plans/53856-my-plan.md", runsDir);
  assert.equal(result, "53856-2");
});

// ---------------------------------------------------------------------------
// makeBranchName
// ---------------------------------------------------------------------------

test("makeBranchName: standard feature plan → feat/{issueNum}-{slug}", () => {
  const result = makeBranchName(
    "feature",
    "/plans/53856-single-job-priority-update-grpc-plan.md",
  );
  assert.equal(result, "feat/53856-single-job-priority-update-grpc");
});

test("makeBranchName: fix workflow → fix/{issueNum}-{slug}", () => {
  const result = makeBranchName("fix", "/plans/12345-add-retry-logic-plan.md");
  assert.equal(result, "fix/12345-add-retry-logic");
});

test("makeBranchName: no leading digits in filename — falls back gracefully (no issue prefix)", () => {
  const result = makeBranchName(
    "feature",
    "/plans/single-job-priority-update-grpc-plan.md",
  );
  // No leading digits → issueNum is "0", slug is the full filename sans extension
  assert.ok(result.startsWith("feat/"), `expected feat/ prefix: ${result}`);
  assert.ok(
    result.includes("single-job-priority-update-grpc"),
    `expected slug in result: ${result}`,
  );
});

test("makeBranchName: unknown workflow type falls back to feat/", () => {
  const result = makeBranchName("unknown-type", "/plans/99-test-plan.md");
  assert.ok(result.startsWith("feat/"), `expected feat/ prefix: ${result}`);
});

// ---------------------------------------------------------------------------
// makePrTitlePrefix
// ---------------------------------------------------------------------------

test("makePrTitlePrefix: feature → 'feat:'", () => {
  assert.equal(makePrTitlePrefix("feature"), "feat:");
});

test("makePrTitlePrefix: fix → 'fix:'", () => {
  assert.equal(makePrTitlePrefix("fix"), "fix:");
});

test("makePrTitlePrefix: unknown workflow → 'feat:'", () => {
  assert.equal(makePrTitlePrefix("unknown"), "feat:");
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

test("findWorktreeScratch: directory pattern .claude/ matches ?? .claude/ (root-level dir)", () => {
  // git status --porcelain shows untracked dirs as "?? .claude/"
  const result = findWorktreeScratch(["?? .claude/"], [".claude/"]);
  assert.deepEqual(result, [".claude/"]);
});

test("findWorktreeScratch: **/target/ pattern matches nested build output dir", () => {
  // git status --porcelain collapses ignored dirs as "!! java/engine/target/"
  const result = findWorktreeScratch(
    ["!! java/engine/target/"],
    ["**/target/"],
  );
  assert.deepEqual(result, ["java/engine/target/"]);
});

test("findWorktreeScratch: **/target/ does NOT match an unrelated path with 'target' in name", () => {
  const result = findWorktreeScratch(
    ["?? src/target-config.json"],
    ["**/target/"],
  );
  assert.deepEqual(result, []);
});

test("findWorktreeScratch: existing basename tests still pass after signature change", () => {
  // guard: pre-existing basename test still works (subdir/guide.md matched by guide.md)
  const result = findWorktreeScratch(["!! subdir/guide.md"], ["guide.md"]);
  assert.deepEqual(result, ["subdir/guide.md"]);
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
  for (const p of [
    "*.tmp",
    "*-state.json",
    "pr-meta.json",
    ".gitignore",
    ".claude/",
    "**/target/",
  ]) {
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

// ---------------------------------------------------------------------------
// agentDecidable
// ---------------------------------------------------------------------------

test("agentDecidable: define is agent-decidable (Gate 1)", () => {
  assert.equal(agentDecidable("define"), true);
});

test("agentDecidable: fix is agent-decidable (Gate 2)", () => {
  assert.equal(agentDecidable("fix"), true);
});

test("agentDecidable: verify is NOT agent-decidable", () => {
  assert.equal(agentDecidable("verify"), false);
});

test("agentDecidable: pr is NOT agent-decidable", () => {
  assert.equal(agentDecidable("pr"), false);
});

test("agentDecidable: unknown node is NOT agent-decidable (safe default)", () => {
  assert.equal(agentDecidable("unknown-node"), false);
});

// ---------------------------------------------------------------------------
// hasConcerns
// ---------------------------------------------------------------------------

test("hasConcerns: ## heading present → true", () => {
  assert.equal(
    hasConcerns("## Concerns / plan challenges\n- Mock concern"),
    true,
  );
});

test("hasConcerns: # heading present → true", () => {
  assert.equal(
    hasConcerns("# Concerns / plan challenges\n- Mock concern"),
    true,
  );
});

test("hasConcerns: heading embedded in larger doc → true", () => {
  assert.equal(
    hasConcerns(
      "# Guide\n\nPlan looks good.\n\n## Concerns / plan challenges\n- Over-specified.",
    ),
    true,
  );
});

test("hasConcerns: clean content → false", () => {
  assert.equal(hasConcerns("# Guide\nClean plan with no concerns."), false);
});

test("hasConcerns: empty string → false", () => {
  assert.equal(hasConcerns(""), false);
});

test("hasConcerns: mock artifact content (no heading) → false", () => {
  assert.equal(
    hasConcerns("# Mock artifact: guide.md\nGenerated by mock executor."),
    false,
  );
});

// ---------------------------------------------------------------------------
// seedWorktreeSiblings
// ---------------------------------------------------------------------------

/**
 * Resolve the dagrunner repo root from the compiled test location.
 * Tests run from src/runtime/ so ../../ is the repo root.
 */
const dagrunnerRoot = new URL("../../", import.meta.url).pathname;

test("seedWorktreeSiblings: all 3 sibling .md files seeded into .claude/commands/", () => {
  const destClaude = mkdtempSync(join(tmpdir(), "dr-seed-sib-"));
  mkdirSync(join(destClaude, "commands"), { recursive: true });

  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  for (const name of ["ci-babysit.md", "pr-triage.md", "seed-data.md"]) {
    assert.ok(
      existsSync(join(destClaude, "commands", name)),
      `expected sibling command ${name} to exist after seeding`,
    );
  }
});

test("seedWorktreeSiblings: all 3 sibling script subdirs seeded into .claude/scripts/", () => {
  const destClaude = mkdtempSync(join(tmpdir(), "dr-seed-sib-scripts-"));
  mkdirSync(join(destClaude, "commands"), { recursive: true });

  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  for (const name of ["ci-babysit", "pr-triage", "seed-data"]) {
    assert.ok(
      existsSync(join(destClaude, "scripts", name)),
      `expected sibling scripts/${name}/ to exist after seeding`,
    );
  }
});

test("seedWorktreeSiblings: pr-triage scripts include gh-comment-capabilities.md (non-.sh file)", () => {
  const destClaude = mkdtempSync(join(tmpdir(), "dr-seed-sib-md-"));
  mkdirSync(join(destClaude, "commands"), { recursive: true });

  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  assert.ok(
    existsSync(
      join(destClaude, "scripts", "pr-triage", "gh-comment-capabilities.md"),
    ),
    "expected gh-comment-capabilities.md to be included (recursive copy must not filter by extension)",
  );
});

test("seedWorktreeSiblings: throws if payload/siblings/commands/ is missing", () => {
  // Point at a temp dir that has no payload/siblings — simulates a broken install.
  const fakeRoot = mkdtempSync(join(tmpdir(), "dr-seed-sib-broken-"));
  const destClaude = mkdtempSync(join(tmpdir(), "dr-seed-sib-dest-"));

  assert.throws(
    () => seedWorktreeSiblings(fakeRoot, destClaude),
    /siblings.*not found|payload\/siblings/i,
    "expected a loud throw when payload/siblings/commands/ is missing",
  );
});

// ---------------------------------------------------------------------------
// parseGateDecision
// ---------------------------------------------------------------------------

test("parseGateDecision: approve with no body → {decision:'approve', body:''}", () => {
  const result = parseGateDecision("decision: approve\n");
  assert.deepEqual(result, { decision: "approve", body: "" });
});

test("parseGateDecision: approve with trailing whitespace/blank lines → body empty", () => {
  const result = parseGateDecision("decision: approve\n\n  \n");
  assert.deepEqual(result, { decision: "approve", body: "" });
});

test("parseGateDecision: reject with multi-paragraph body → body extracted (no decision line)", () => {
  const content =
    "decision: reject\n\nThe function does not handle the edge case.\n\nPlease add null checks.\n";
  const result = parseGateDecision(content);
  assert.deepEqual(result, {
    decision: "reject",
    body: "The function does not handle the edge case.\n\nPlease add null checks.",
  });
});

test("parseGateDecision: reject with no body → {decision:'reject', body:''}", () => {
  // An empty-body reject is still a valid reject — route as reject with empty feedback.
  const result = parseGateDecision("decision: reject\n");
  assert.deepEqual(result, { decision: "reject", body: "" });
});

test("parseGateDecision: reject with blank separator line only → body empty", () => {
  const result = parseGateDecision("decision: reject\n\n");
  assert.deepEqual(result, { decision: "reject", body: "" });
});

test("parseGateDecision: case-insensitive decision value is accepted", () => {
  const approve = parseGateDecision("decision: Approve\n");
  assert.deepEqual(approve, { decision: "approve", body: "" });

  const reject = parseGateDecision("decision: Reject\n");
  assert.deepEqual(reject, { decision: "reject", body: "" });
});

test("parseGateDecision: extra whitespace around value is trimmed", () => {
  const result = parseGateDecision("decision:   approve   \n");
  assert.deepEqual(result, { decision: "approve", body: "" });
});

test("parseGateDecision: empty string → null", () => {
  assert.equal(parseGateDecision(""), null);
});

test("parseGateDecision: no decision: line → null", () => {
  assert.equal(parseGateDecision("approved by user\n"), null);
});

test("parseGateDecision: unknown decision value → null", () => {
  assert.equal(parseGateDecision("decision: maybe\n"), null);
});

test("parseGateDecision: malformed (decision: on second line, not first) → null", () => {
  // The decision: line must be the first non-empty line.
  assert.equal(parseGateDecision("some preamble\ndecision: approve\n"), null);
});

test("parseGateDecision: body of approve is always empty regardless of trailing content", () => {
  // approve is a terminal decision — any body text is ignored (not an error, just dropped).
  const result = parseGateDecision(
    "decision: approve\n\nThis was a well-written artifact.\n",
  );
  assert.deepEqual(result, { decision: "approve", body: "" });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

test("parseFrontmatter: full bugfix frontmatter → all fields extracted", () => {
  const content = [
    "---",
    "base_branch: release/1.x",
    "issue: https://github.com/camunda/camunda/issues/12345",
    "severity: critical",
    "backport-targets: [release/1.0, release/1.1]",
    "repo: camunda/camunda",
    "---",
    "",
    "# Bug fix plan",
  ].join("\n");
  const result = parseFrontmatter(content);
  assert.equal(result.base_branch, "release/1.x");
  assert.equal(result.issue, "https://github.com/camunda/camunda/issues/12345");
  assert.equal(result.severity, "critical");
  assert.equal(result.repo, "camunda/camunda");
});

test("parseFrontmatter: no frontmatter → empty object", () => {
  const content = "# Bug fix plan\nSome description";
  const result = parseFrontmatter(content);
  assert.equal(Object.keys(result).length, 0);
});

test("parseFrontmatter: empty string → empty object", () => {
  const result = parseFrontmatter("");
  assert.equal(Object.keys(result).length, 0);
});

test("parseFrontmatter: only closing --- (no opening) → empty object", () => {
  const content = "Some text\n---\nMore text";
  const result = parseFrontmatter(content);
  assert.equal(Object.keys(result).length, 0);
});

test("parseFrontmatter: partial fields — missing fields absent, present fields extracted", () => {
  const content = ["---", "severity: major", "---", "# Plan"].join("\n");
  const result = parseFrontmatter(content);
  assert.equal(result.severity, "major");
  assert.equal(result.base_branch, undefined);
  assert.equal(result.issue, undefined);
});

test("parseFrontmatter: values with colons in them — full value extracted", () => {
  const content = [
    "---",
    "issue: https://github.com/org/repo/issues/99",
    "---",
  ].join("\n");
  const result = parseFrontmatter(content);
  assert.equal(result.issue, "https://github.com/org/repo/issues/99");
});

test("parseFrontmatter: leading/trailing whitespace on values is trimmed", () => {
  const content = ["---", "base_branch:   main  ", "---"].join("\n");
  const result = parseFrontmatter(content);
  assert.equal(result.base_branch, "main");
});

// ---------------------------------------------------------------------------
// severityForcesPause
// ---------------------------------------------------------------------------

test("severityForcesPause: 'critical' → true", () => {
  assert.equal(severityForcesPause("critical"), true);
});

test("severityForcesPause: 'blocker' → true", () => {
  assert.equal(severityForcesPause("blocker"), true);
});

test("severityForcesPause: 'major' → false", () => {
  assert.equal(severityForcesPause("major"), false);
});

test("severityForcesPause: 'minor' → false", () => {
  assert.equal(severityForcesPause("minor"), false);
});

test("severityForcesPause: undefined → false (safe default)", () => {
  assert.equal(severityForcesPause(undefined), false);
});

test("severityForcesPause: case-insensitive — 'CRITICAL' → true", () => {
  assert.equal(severityForcesPause("CRITICAL"), true);
});

test("severityForcesPause: case-insensitive — 'BLOCKER' → true", () => {
  assert.equal(severityForcesPause("BLOCKER"), true);
});

// ---------------------------------------------------------------------------
// makeBranchName: bugfix workflow
// ---------------------------------------------------------------------------

test("makeBranchName: bugfix workflow → fix/{issueNum}-{slug}", () => {
  const result = makeBranchName(
    "bugfix",
    "/plans/12345-null-pointer-in-job-activation-fix-plan.md",
  );
  assert.equal(result, "fix/12345-null-pointer-in-job-activation");
});

test("makePrTitlePrefix: bugfix → 'fix:'", () => {
  assert.equal(makePrTitlePrefix("bugfix"), "fix:");
});
