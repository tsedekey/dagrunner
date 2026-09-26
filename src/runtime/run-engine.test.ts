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
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeRunId,
  makeBranchName,
  makePrTitlePrefix,
  findWorktreeScratch,
  worktreeArtifactPatterns,
  agentDecidable,
  hasConcerns,
  seedWorktreeSiblings,
  parseGateDecision,
  parseFrontmatter,
  severityForcesPause,
  archivePriorAttempt,
  archiveInterruptedNodeArtifacts,
} from "./run-engine.js";
import type { RunState, NodeState } from "../core/state.js";

// ---------------------------------------------------------------------------
// Minimal RunState/NodeState fixture helper (archiveInterruptedNodeArtifacts
// tests below only care about .nodes[id].status — everything else is filler
// to satisfy the types).
// ---------------------------------------------------------------------------

function nodeState(status: NodeState["status"]): NodeState {
  return { status, artifacts: [], iteration: 0, cost: 0, gateHistory: [] };
}

function runState(nodes: Record<string, NodeState>): RunState {
  return {
    runId: "test-run",
    workflow: "bugfix",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/does-not-matter",
    branch: "fix/test",
    sourcePlanPath: "/tmp/plan.md",
    nodes,
  };
}

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
  // All declared produces across featureWorkflow nodes, plus verify-plan.md —
  // which is no longer in verify's `produces` (run 56962-1 forensics,
  // DECISIONS.md § verify-run-56962-1-forensics: it's conditional, written on
  // the normal path but explicitly skipped on verify.md's documented
  // short-circuit paths) but is still expected here via the SECONDARY scratch
  // pattern list, since it can still legitimately land in the worktree.
  const expected = [
    "guide.md",
    "summary.md",
    "findings.json",
    "verify-plan.md",
    "verify-report.json",
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

test("agentDecidable: pr (bugfix pre-PR gate) is night-decidable — preserves prior unattended behavior", () => {
  assert.equal(agentDecidable("pr"), true);
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

test("seedWorktreeSiblings: sibling .md files (including manual-smoke, D7) seeded into .claude/commands/", () => {
  const destClaude = mkdtempSync(join(tmpdir(), "dr-seed-sib-"));
  mkdirSync(join(destClaude, "commands"), { recursive: true });

  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  for (const name of [
    "ci-babysit.md",
    "pr-triage.md",
    "seed-data.md",
    "manual-smoke.md",
  ]) {
    assert.ok(
      existsSync(join(destClaude, "commands", name)),
      `expected sibling command ${name} to exist after seeding`,
    );
  }
});

test("seedWorktreeSiblings: sibling script subdirs (including manual-smoke, D7) seeded into .claude/scripts/", () => {
  const destClaude = mkdtempSync(join(tmpdir(), "dr-seed-sib-scripts-"));
  mkdirSync(join(destClaude, "commands"), { recursive: true });

  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  for (const name of ["ci-babysit", "pr-triage", "seed-data", "manual-smoke"]) {
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

// ---------------------------------------------------------------------------
// archivePriorAttempt
// ---------------------------------------------------------------------------

test("archivePriorAttempt: no-op when artifactsDir does not exist", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-"));
  const artifactsDir = join(runDir, "verify");

  archivePriorAttempt(runDir, "verify", artifactsDir);

  assert.equal(existsSync(join(runDir, "verify-attempts")), false);
});

test("archivePriorAttempt: no-op when artifactsDir exists but is empty", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-"));
  const artifactsDir = join(runDir, "verify");
  mkdirSync(artifactsDir);

  archivePriorAttempt(runDir, "verify", artifactsDir);

  assert.equal(existsSync(join(runDir, "verify-attempts")), false);
  assert.equal(existsSync(artifactsDir), true); // left untouched, not renamed away
});

test("archivePriorAttempt: first archive lands at attempt-1 with content preserved", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-"));
  const artifactsDir = join(runDir, "verify");
  mkdirSync(artifactsDir);
  writeFileSync(join(artifactsDir, "transcript.log"), "attempt one log");
  writeFileSync(join(artifactsDir, "reflections.md"), "ERROR_INFRA: no docker");

  archivePriorAttempt(runDir, "verify", artifactsDir);

  const dest = join(runDir, "verify-attempts", "attempt-1");
  assert.equal(
    readFileSync(join(dest, "transcript.log"), "utf8"),
    "attempt one log",
  );
  assert.equal(
    readFileSync(join(dest, "reflections.md"), "utf8"),
    "ERROR_INFRA: no docker",
  );
  // The original path no longer exists — rerunNode recreates it fresh after.
  assert.equal(existsSync(artifactsDir), false);
});

test("archivePriorAttempt: sequential numbering across repeated reruns (mirrors run 54177-1's 7 verify attempts)", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-"));
  const nodeId = "verify";
  const artifactsDir = join(runDir, nodeId);

  // Simulate 3 prior attempts, each archived then a fresh artifactsDir recreated
  // (mirroring exactly what rerunNode does: archive, wipe, mkdir, execute).
  for (let i = 1; i <= 3; i++) {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "burn.json"), `{"attempt":${i}}`);
    archivePriorAttempt(runDir, nodeId, artifactsDir);
  }

  const attemptsDir = join(runDir, `${nodeId}-attempts`);
  const attempts = readdirSync(attemptsDir).sort();
  assert.deepEqual(attempts, ["attempt-1", "attempt-2", "attempt-3"]);
  assert.equal(
    readFileSync(join(attemptsDir, "attempt-2", "burn.json"), "utf8"),
    '{"attempt":2}',
  );
});

test("archivePriorAttempt: different node ids get independent attempt sequences", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-"));

  const verifyDir = join(runDir, "verify");
  mkdirSync(verifyDir);
  writeFileSync(join(verifyDir, "burn.json"), "verify attempt");
  archivePriorAttempt(runDir, "verify", verifyDir);

  const reviewDir = join(runDir, "review");
  mkdirSync(reviewDir);
  writeFileSync(join(reviewDir, "burn.json"), "review attempt");
  archivePriorAttempt(runDir, "review", reviewDir);

  assert.equal(existsSync(join(runDir, "verify-attempts", "attempt-1")), true);
  assert.equal(existsSync(join(runDir, "review-attempts", "attempt-1")), true);
});

// ---------------------------------------------------------------------------
// archiveInterruptedNodeArtifacts — the resumeRun/resetInterruptedNodes half
// of the same class of gap archivePriorAttempt closes for rerunNode. See
// DECISIONS.md § resume-interrupt-artifact-archiving.
// ---------------------------------------------------------------------------

test("archiveInterruptedNodeArtifacts: archives and clears a node reset from interrupted-failed to pending", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-interrupt-"));
  const artifactsDir = join(runDir, "implement");
  mkdirSync(artifactsDir);
  writeFileSync(
    join(artifactsDir, "transcript.log"),
    "partial — interrupted mid-attempt",
  );
  writeFileSync(
    join(artifactsDir, "reflections.md"),
    "STALE TIP from the interrupted attempt",
  );

  const stateBefore = runState({
    reproduce: nodeState("done"),
    implement: nodeState("failed"),
  });
  const stateAfter = runState({
    reproduce: nodeState("done"),
    implement: nodeState("pending"),
  });

  archiveInterruptedNodeArtifacts(runDir, stateBefore, stateAfter);

  assert.equal(
    readFileSync(
      join(runDir, "implement-attempts", "attempt-1", "transcript.log"),
      "utf8",
    ),
    "partial — interrupted mid-attempt",
    "prior attempt's transcript.log must be archived, not lost",
  );
  assert.equal(
    readFileSync(
      join(runDir, "implement-attempts", "attempt-1", "reflections.md"),
      "utf8",
    ),
    "STALE TIP from the interrupted attempt",
    "prior attempt's reflections.md must be archived, not lost",
  );
  assert.equal(
    existsSync(join(artifactsDir, "transcript.log")),
    false,
    "the live artifacts dir must be cleared, not left with stale content for the retry to silently overwrite/append onto",
  );
  assert.equal(
    existsSync(artifactsDir),
    true,
    "the live artifacts dir must exist (fresh, empty) for the retry to write into",
  );
});

test("archiveInterruptedNodeArtifacts: no-op for a node that did not transition failed->pending", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-interrupt-"));
  const artifactsDir = join(runDir, "review");
  mkdirSync(artifactsDir);
  writeFileSync(join(artifactsDir, "findings.json"), "{}");

  // review stayed "done" in both before/after — untouched by resetInterruptedNodes.
  const stateBefore = runState({ review: nodeState("done") });
  const stateAfter = runState({ review: nodeState("done") });

  archiveInterruptedNodeArtifacts(runDir, stateBefore, stateAfter);

  assert.equal(existsSync(join(runDir, "review-attempts")), false);
  assert.equal(
    readFileSync(join(artifactsDir, "findings.json"), "utf8"),
    "{}",
    "an untouched node's artifacts must survive completely unmodified",
  );
});

test("archiveInterruptedNodeArtifacts: no-op when the reset node has no prior artifacts", () => {
  const runDir = mkdtempSync(join(tmpdir(), "dr-archive-interrupt-"));

  const stateBefore = runState({ implement: nodeState("failed") });
  const stateAfter = runState({ implement: nodeState("pending") });

  archiveInterruptedNodeArtifacts(runDir, stateBefore, stateAfter);

  assert.equal(existsSync(join(runDir, "implement-attempts")), false);
  assert.equal(
    existsSync(join(runDir, "implement")),
    true,
    "a clean artifacts dir must still exist for the retry to write into",
  );
});
