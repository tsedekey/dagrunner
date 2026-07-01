/**
 * run-engine.ts — high-level run orchestrator.
 *
 * startRun:  create run dir + git worktree, lock, run DAG, checkpoint or finish.
 * resumeRun: reconcile stale state, handle gate decision, re-run DAG.
 *
 * Lock discipline (logged in DECISIONS.md block7):
 *   - A paused run releases the lock on checkpoint-and-exit so another
 *     dagrun start can be issued while waiting for review. Resume re-acquires.
 *   - A running run holds the lock for the full DAG execution.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";

// Mutable ref so the SIGINT handler in cli.ts can find the active run dir and
// release the lock cleanly. Mutated (not reassigned) so the export stays stable.
export const activeRun: { runDir?: string; homeDir?: string } = {};
import { join, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Workflow } from "../core/types.js";
import type { DagrunnerConfig } from "../config/xdg.js";
import { readState, writeState } from "../core/state.js";
import type { RunState, NodeState, NodeStatus } from "../core/state.js";
import type { ExecutionCtx, NodeExecutor } from "./mock-executor.js";

type ExecutorFactory = (
  config: DagrunnerConfig,
  runId: string,
  runDir: string,
  worktreePath: string,
  storeDir: string,
) => NodeExecutor;

/**
 * Format the advisory text shown at the verify-election from a parsed findings
 * object. Returns "" on any degrade path (missing file, bad JSON, missing field)
 * so the caller always degrades to the bare prompt rather than crashing.
 * Exported for unit testing.
 */
export function formatVerifyRecommendation(findings: unknown): string {
  if (typeof findings !== "object" || findings === null) return "";
  const f = findings as Record<string, unknown>;
  if (
    typeof f["manual_test_recommendation"] !== "object" ||
    f["manual_test_recommendation"] === null
  )
    return "";
  const rec = f["manual_test_recommendation"] as Record<string, unknown>;
  if (typeof rec["recommended"] !== "boolean") return "";
  const surface = typeof rec["surface"] === "string" ? rec["surface"] : "none";
  const rationale =
    typeof rec["rationale"] === "string" ? rec["rationale"] : "";
  if (rec["recommended"] === true) {
    return `Observability advisory: manual test recommended — surface: ${surface}. ${rationale}`;
  }
  return `Observability advisory: manual test not recommended — ${rationale || "change has no observable UI or API surface"}`;
}

/**
 * Parse the content of a `gate-decision.md` file written by the /gate-conclude
 * slash command inside an interactive Claude Code dialogue session.
 *
 * Expected format:
 *   decision: approve
 * or:
 *   decision: reject
 *
 *   <multi-paragraph feedback body>
 *
 * Returns null when the content is missing, the decision: line is absent,
 * or the decision value is not "approve" or "reject".
 * Dagrunner treats null the same as an absent file (no decision recorded).
 *
 * Exported for unit testing. Pure function — no I/O.
 */
export function parseGateDecision(
  content: string,
): { decision: "approve" | "reject"; body: string } | null {
  if (!content || content.trim() === "") return null;

  const lines = content.split("\n");
  // First non-empty line must be the decision: line.
  const firstNonEmpty = lines.find((l) => l.trim() !== "");
  if (firstNonEmpty === undefined) return null;

  const match = /^decision:\s*(.+?)\s*$/i.exec(firstNonEmpty);
  if (match === null || match[1] === undefined) return null;

  const value = match[1].toLowerCase();
  if (value !== "approve" && value !== "reject") return null;

  // Body = everything after the decision: line, with the leading blank line stripped.
  // For approve, body is always empty (no feedback needed).
  let body = "";
  if (value === "reject") {
    // Skip the decision: line and any immediately following blank line.
    const restLines = lines.slice(lines.indexOf(firstNonEmpty) + 1);
    // Drop leading blank lines.
    let start = 0;
    while (start < restLines.length && (restLines[start] ?? "").trim() === "")
      start++;
    body = restLines.slice(start).join("\n").trimEnd();
  }

  return { decision: value, body };
}

/** Node IDs that night-mode may auto-approve (Gate 1 + Gate 2). */
const AGENT_DECIDABLE_GATES = new Set(["define", "reproduce", "fix"]);

/**
 * True when night-mode may auto-decide the gate for nodeId.
 * Expand (Gate 1) and fix (Gate 2) are agent-decidable; verify-election and
 * all others are human-only. Exported for unit testing.
 */
export function agentDecidable(nodeId: string): boolean {
  return AGENT_DECIDABLE_GATES.has(nodeId);
}

/**
 * True if the artifact content contains a "Concerns / plan challenges" heading.
 * Heading level 1–6; case-insensitive. Returns false on empty/missing content
 * (no concerns = safe to proceed). Exported for unit testing.
 */
export function hasConcerns(content: string): boolean {
  return /^#{1,6}\s+Concerns\s*\/\s*plan challenges/im.test(content);
}

/**
 * Extract the leading issue number from a plan filename.
 * e.g. "53856-single-job-priority-update-grpc-plan.md" → "53856"
 * Falls back to "0" if the filename has no leading digits.
 */
function issueNumFromPlanPath(planPath: string): string {
  const name = basename(planPath, ".md");
  const match = /^(\d+)-/.exec(name);
  return match ? (match[1] ?? "0") : "0";
}

/**
 * Extract the slug segment from a plan filename.
 * Strips the leading "{issueNum}-" prefix and the "-fix-plan" or "-plan" suffix.
 * e.g. "53856-null-pointer-fix-plan.md" → "null-pointer"
 * e.g. "53856-single-job-priority-update-grpc-plan.md" → "single-job-priority-update-grpc"
 * Falls back to the full filename (without extension) if no prefix/suffix found.
 */
function slugFromPlanPath(planPath: string): string {
  const name = basename(planPath, ".md");
  // Strip leading "{digits}-" prefix if present.
  const withoutPrefix = name.replace(/^\d+-/, "");
  // Strip trailing "-fix-plan" suffix first (more specific), then "-plan".
  const withoutSuffix = withoutPrefix
    .replace(/-fix-plan$/, "")
    .replace(/-plan$/, "");
  return withoutSuffix !== "" ? withoutSuffix : name;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML-like frontmatter block (between --- delimiters) from plan content.
 * Supports simple `key: value` pairs only — no nested objects or arrays.
 * Returns a record of string key → string value for all parsed lines.
 * Returns an empty record when no frontmatter is present.
 * Exported for unit testing. Pure function — no I/O.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  if (content === "" || !content.startsWith("---")) return {};
  const lines = content.split("\n");
  // Find closing --- (must be after line 0)
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (closeIdx === -1) return {};

  const result: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i] ?? "";
    // key: value — split on first colon only
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key !== "") result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Severity-aware night-mode
// ---------------------------------------------------------------------------

/**
 * True when bug severity forces night-mode to pause regardless of concern flags.
 * Critical and blocker severity bugs always require a human gate — even in unattended mode.
 * Accepts undefined (returns false — safe default, no pause forced).
 * Exported for unit testing. Pure function — no I/O.
 */
export function severityForcesPause(severity: string | undefined): boolean {
  if (severity === undefined) return false;
  const lower = severity.toLowerCase();
  return lower === "critical" || lower === "blocker";
}

/**
 * Build a run ID from the plan path and the runs directory.
 * Format: {issueNum}-{runCount}  e.g. "53856-1", "53856-2"
 *
 * Scans runsDir for entries matching ^{issueNum}-\d+$, finds max N, returns N+1.
 * Starts at 1 if no matching entries found. Returns "0-1" if filename has no
 * leading issue number.
 *
 * Exported for unit testing.
 */
export function makeRunId(planPath: string, runsDir: string): string {
  const issueNum = issueNumFromPlanPath(planPath);
  const pattern = new RegExp(`^${issueNum}-\\d+$`);
  let maxN = 0;
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && pattern.test(entry.name)) {
        const n = parseInt(entry.name.split("-").pop() ?? "0", 10);
        if (n > maxN) maxN = n;
      }
    }
  }
  return `${issueNum}-${maxN + 1}`;
}

// ---------------------------------------------------------------------------
// Branch naming — Conventional Commits style
// ---------------------------------------------------------------------------

const WORKFLOW_TYPE_PREFIX: Record<string, string> = {
  feature: "feat",
  bugfix: "fix",
  fix: "fix",
  docs: "docs",
  chore: "chore",
  refactor: "refactor",
  test: "test",
  ci: "ci",
  build: "build",
  perf: "perf",
  style: "style",
  revert: "revert",
};

/**
 * Compute the git branch name for a new run.
 * Format: {type}/{issueNum}-{slug}
 *   e.g. feat/53856-single-job-priority-update-grpc
 *
 * The issue number makes the branch unique — no random suffix needed.
 * Exported for unit testing.
 */
export function makeBranchName(workflowName: string, planPath: string): string {
  const prefix = WORKFLOW_TYPE_PREFIX[workflowName] ?? "feat";
  const issueNum = issueNumFromPlanPath(planPath);
  const slug = slugFromPlanPath(planPath);
  return `${prefix}/${issueNum}-${slug}`;
}

/**
 * Return the PR title prefix for a workflow: "{type}:"
 *   e.g. "feat:" for feature, "fix:" for fix.
 * The pr node uses this to enforce Conventional Commits format.
 * Exported for unit testing.
 */
export function makePrTitlePrefix(workflowName: string): string {
  return (WORKFLOW_TYPE_PREFIX[workflowName] ?? "feat") + ":";
}

// ---------------------------------------------------------------------------
// Worktree hygiene — structural scratch backstop
// ---------------------------------------------------------------------------

/**
 * Returns all known artifact filenames (from featureWorkflow.produces) plus
 * secondary scratch patterns. Used for both .git/info/exclude seeding and the
 * advisory pre-pr scan. Exported for unit testing.
 */
export function worktreeArtifactPatterns(): string[] {
  const names = new Set<string>();
  for (const node of featureWorkflow.nodes) {
    for (const f of node.produces ?? []) {
      names.add(f);
    }
  }
  // Secondary scratch patterns that aren't in produces.
  for (const p of [
    "*.tmp",
    "*-state.json",
    "pr-meta.json",
    ".gitignore",
    ".claude/",
    "**/target/",
  ]) {
    names.add(p);
  }
  return Array.from(names);
}

/**
 * Given lines from `git status --ignored --porcelain` and a list of patterns,
 * return entries that look like leaked dagrunner artifacts. Both `!!` (ignored)
 * and `??` (untracked) prefixes are checked — the former confirms the .gitignore
 * seed is working, the latter catches patterns we forgot to include.
 * Exported for unit testing.
 */
export function findWorktreeScratch(
  statusLines: string[],
  patterns: string[],
): string[] {
  const result: string[] = [];
  for (const line of statusLines) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (xy !== "!!" && xy !== "??") continue;
    if (line[2] !== " ") continue; // guard: must be "XY " not "XY<no-space>"
    const filePath = line.slice(3).trim();
    const name = filePath.split("/").pop() ?? filePath;
    if (patterns.some((p) => matchesHygienePattern(filePath, name, p))) {
      result.push(filePath);
    }
  }
  return result;
}

function matchesHygienePattern(
  filePath: string,
  name: string,
  pattern: string,
): boolean {
  // Directory-style pattern: ".claude/" or "target/" — match if path ends with
  // "/{dir}" or equals the dir name (with trailing slash preserved in filePath).
  if (pattern.endsWith("/") && !pattern.startsWith("**/")) {
    const dir = pattern.slice(0, -1); // strip trailing "/"
    return (
      filePath === pattern ||
      filePath.endsWith(`/${dir}/`) ||
      filePath === `${dir}/`
    );
  }
  // Glob prefix "**/" — match any path segment that ends with the suffix.
  // e.g. "**/target/" matches "java/engine/target/" and "target/"
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3); // strip "**/"
    return filePath === suffix || filePath.endsWith(`/${suffix}`);
  }
  // Glob suffix "*" — match by name suffix (e.g. "*.tmp", "*-state.json").
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  // Exact match on basename.
  return name === pattern;
}

/**
 * Write dagrunner artifact patterns to the DEVHARNESS_SRC repo's common
 * .git/info/exclude so they apply to the worktree without touching any tracked
 * file. Uses --git-common-dir (the repo's shared .git dir) because git only
 * reads info/exclude from the common gitdir, not per-worktree gitdirs.
 *
 * Append-with-marker strategy: if the dagrunner block is already present
 * (idempotent guard), skip. Otherwise append it. Never overwrites the whole
 * file — preserves any pre-existing user patterns. Fail-soft: logs a warning
 * on error and never throws.
 */
function seedWorktreeExclude(worktreePath: string, patterns: string[]): void {
  const MARKER = "# dagrunner artifact backstop — auto-generated, do not edit";
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();
    const resolvedCommonDir = commonDir.startsWith("/")
      ? commonDir
      : join(worktreePath, commonDir);
    const infoDir = join(resolvedCommonDir, "info");
    mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, "exclude");

    // Read existing content (may not exist yet).
    let existing = "";
    try {
      existing = readFileSync(excludePath, "utf8");
    } catch {
      // file absent — start fresh
    }

    // Idempotent: if marker already present, do not append again.
    if (existing.includes(MARKER)) return;

    const block =
      (existing.length > 0 && !existing.endsWith("\n") ? "\n" : "") +
      [MARKER, ...patterns, ""].join("\n");
    writeFileSync(excludePath, existing + block, "utf8");
  } catch (err) {
    process.stderr.write(
      `dagrun: warning — could not seed worktree exclude: ${String(err)}\n`,
    );
  }
}

/**
 * Append java and maven tool entries to the worktree's .tool-versions, then
 * mark the file skip-worktree so the additions never appear as staged changes.
 *
 * Background: .tool-versions is a tracked file (contains "helm ...") so
 * .git/info/exclude has no effect on it. skip-worktree is the correct
 * per-worktree mechanism — git stops comparing the working-tree copy against
 * the index, so `git add` and `git commit` cannot pick up the additions.
 *
 * ASDF_JAVA_VERSION env var does not work in this asdf setup (no upward
 * resolution), so the file edit is the only path. Maven env var does work
 * but both entries go here for consistency. Fail-soft: logs a warning on
 * error and never throws.
 */
function seedWorktreeToolVersions(worktreePath: string): void {
  // Detect the latest installed temurin-21.* from asdf — Camunda main targets Java 21.
  // Falls back to a known-good patch if asdf is unavailable.
  const javaEntry = (() => {
    try {
      const out = execSync("asdf list java 2>/dev/null", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const ver = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("temurin-25."))
        .pop();
      if (ver !== undefined) return `java ${ver}`;
    } catch {
      // asdf not on PATH
    }
    return "java temurin-25.0.3+9.0.LTS";
  })();
  const TOOL_ENTRIES = [javaEntry, "maven 3.9.9"];
  try {
    const tvPath = join(worktreePath, ".tool-versions");
    let existing = "";
    try {
      existing = readFileSync(tvPath, "utf8");
    } catch {
      // absent — will create it
    }

    const toAdd = TOOL_ENTRIES.filter((entry) => {
      const tool = (entry.split(" ")[0] ?? "").trim();
      return !existing.split("\n").some((l) => l.trimStart().startsWith(tool));
    });

    if (toAdd.length > 0) {
      const prefix =
        existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(
        tvPath,
        existing + prefix + toAdd.join("\n") + "\n",
        "utf8",
      );
    }

    execSync("git update-index --skip-worktree .tool-versions", {
      cwd: worktreePath,
      stdio: "pipe",
    });
  } catch (err) {
    process.stderr.write(
      `dagrun: warning — could not seed .tool-versions: ${String(err)}\n`,
    );
  }
}

/**
 * Symlink every node_modules directory found up to 3 levels deep in
 * devharnessSrc into the corresponding worktree location, so the implement
 * node can run frontend tests (e.g. `npx vitest`) from the worktree against
 * the changed source without a full npm install.
 *
 * Why symlinks: the worktree shares git objects with the main checkout but has
 * no node_modules. Running from DEVHARNESS_SRC would test the unmodified code.
 * The shared npm/Vite/Jest caches are acceptable for sequential runs.
 *
 * node_modules is in .gitignore so symlinks are never staged or committed.
 * Fail-soft: a missing directory or permission error is logged and ignored.
 */
function seedWorktreeNodeModules(
  worktreePath: string,
  devharnessSrc: string,
): void {
  try {
    const out = execSync(
      `find "${devharnessSrc}" -maxdepth 3 -name "node_modules" -prune -print`,
      { encoding: "utf8", timeout: 15000 },
    ).trim();
    if (!out) return;
    for (const nmPath of out.split("\n")) {
      if (!nmPath) continue;
      const rel = nmPath.slice(devharnessSrc.length).replace(/^\//, "");
      const dest = join(worktreePath, rel);
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(nmPath, dest);
      }
    }
  } catch (err) {
    process.stderr.write(
      `dagrun: warning — could not seed node_modules symlinks: ${String(err)}\n`,
    );
  }
}

/**
 * Run `git status --ignored --porcelain` in the worktree, find leaked artifact
 * filenames, and emit an advisory warning to stdout + a scratch-warning.txt
 * file in the run dir. Never throws; never blocks the caller.
 */
function scanWorktreeForLeaks(
  worktreePath: string,
  runDir: string,
  patterns: string[],
): void {
  try {
    const out = execSync("git status --ignored --porcelain", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const leaked = findWorktreeScratch(out.split("\n"), patterns);
    if (leaked.length === 0) return;
    const msg =
      `dagrun: [advisory] pre-pr scan found ${String(leaked.length)} leaked artifact(s) in worktree:\n` +
      leaked.map((f) => `  ${f}`).join("\n") +
      "\n  These are excluded from git by .git/info/exclude — they cannot be staged or committed.\n" +
      "  A node prompt wrote to the worktree instead of $DAGRUN_ARTIFACTS. Fix the prompt.\n";
    process.stdout.write(msg);
    writeFileSync(join(runDir, "scratch-warning.txt"), msg, "utf8");
  } catch (err) {
    process.stderr.write(
      `dagrun: warning — pre-pr scratch scan failed: ${String(err)}\n`,
    );
  }
}

/**
 * Seed the worktree's .claude/ with dagrunner-owned sibling commands and scripts
 * (ci-babysit, pr-triage, seed-data). These are seeded AFTER the pipeline commands
 * so that session-start.sh's DEVHARNESS_SRC sync can be overridden by this call.
 *
 * Also exports DAGRUNNER_ROOT into process.env so session-start.sh can re-apply
 * siblings at every node session start (satisfying the env-propagation contract).
 *
 * Exported for unit testing (tests point at the real repo root + a temp destClaude).
 * Fail-loud: throws if payload/siblings/commands/ is absent (broken install).
 */
export function seedWorktreeSiblings(
  dagrunnerRoot: string,
  destClaude: string,
): void {
  const srcSiblingCommands = join(
    dagrunnerRoot,
    "payload",
    "siblings",
    "commands",
  );
  const srcSiblingScripts = join(
    dagrunnerRoot,
    "payload",
    "siblings",
    "scripts",
  );

  if (!existsSync(srcSiblingCommands)) {
    throw new Error(
      `dagrun: payload/siblings/commands not found at ${srcSiblingCommands} — package installation may be broken`,
    );
  }

  // Set env before any child process / session spawn so hooks can see it.
  process.env["DAGRUNNER_ROOT"] = dagrunnerRoot;

  // Seed sibling commands into .claude/commands/ (alongside pipeline commands).
  mkdirSync(join(destClaude, "commands"), { recursive: true });
  cpSync(srcSiblingCommands, join(destClaude, "commands"), { recursive: true });

  // Seed sibling scripts into .claude/scripts/.
  if (existsSync(srcSiblingScripts)) {
    mkdirSync(join(destClaude, "scripts"), { recursive: true });
    cpSync(srcSiblingScripts, join(destClaude, "scripts"), { recursive: true });
  }
}

/**
 * Wrap an executor so that immediately before the `pr` node fires, the worktree
 * is scanned for leaked artifacts. Advisory only — never blocks the pr node.
 * Note: rerunNode does not use this wrapper (debug tool; intentional omission
 * documented in DECISIONS.md).
 */
function wrapWithPrScan(
  base: NodeExecutor,
  worktreePath: string,
  runDir: string,
): NodeExecutor {
  // Exclude **/target/ from the scan — Maven build output is legitimate, not leaked artifacts.
  const patterns = worktreeArtifactPatterns().filter((p) => p !== "**/target/");
  return async (id, node, ctx) => {
    if (id === "pr") scanWorktreeForLeaks(worktreePath, runDir, patterns);
    return base(id, node, ctx);
  };
}

import {
  reconcileRunningNodes,
  resetInterruptedNodes,
  MAX_INTERRUPT_RETRIES,
  runDag,
} from "../core/dag.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { makeSDKRunner } from "./sdk-runner.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { loadWorkflow } from "../workflow/workflow.js";
import {
  readSourcePassthrough,
  readWorkProfileMcpServers,
  buildSeededSettings,
} from "../config/settings-seed.js";

// ---------------------------------------------------------------------------
// Ctx builder
// ---------------------------------------------------------------------------

function makeCtx(runDir: string) {
  return {
    // Reads the first structured JSON artifact from a node directory.
    // Nodes that produce structured output use output.json (sdk-runner writes it).
    json: (nodeId: string): unknown =>
      JSON.parse(
        readFileSync(join(runDir, nodeId, "output.json"), "utf8"),
      ) as unknown,
    read: (nodeId: string, file: string): string =>
      readFileSync(join(runDir, nodeId, file), "utf8"),
    dir: (nodeId: string): string => join(runDir, nodeId),
  };
}

// ---------------------------------------------------------------------------
// Initial node state factory
// ---------------------------------------------------------------------------

const MODEL_IDS: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

function makeInitialNodeStates(workflow: Workflow): Record<string, NodeState> {
  const nodes: Record<string, NodeState> = {};
  for (const node of workflow.nodes) {
    nodes[node.id] = {
      status: "pending",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
      ...(node.model !== undefined
        ? { model: MODEL_IDS[node.model] ?? node.model }
        : {}),
    };
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Workflow resolver (v1: only feature)
// ---------------------------------------------------------------------------

function workflowFromState(state: RunState): Workflow {
  if (state.workflow === "feature") return featureWorkflow;
  if (state.workflow === "bugfix") return bugfixWorkflow;
  throw new Error(`run-engine: unknown workflow "${state.workflow}"`);
}

// ---------------------------------------------------------------------------
// startRun
// ---------------------------------------------------------------------------

export async function startRun(opts: {
  workflow: Workflow;
  planPath: string;
  homeDir: string;
  config: DagrunnerConfig;
  maxBudgetUsd?: number;
  force?: boolean;
  executorFactory?: ExecutorFactory;
  /** Run unattended: auto-approve agent-decidable gates when no concerns are flagged. */
  nightMode?: boolean;
}): Promise<void> {
  const { workflow, planPath, homeDir, config, force } = opts;

  // Validate workflow at load time (hard rule: fail at load, not at runtime).
  loadWorkflow(workflow);

  const runId = makeRunId(planPath, join(homeDir, "runs"));
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");
  const worktreePath = join(homeDir, "worktrees", runId);

  // Defensive backstop: the run-count scheme ensures a unique ID is computed by
  // scanning existing dirs, but we assert loudly rather than silently clobber.
  if (existsSync(runDir)) {
    throw new Error(
      `dagrun: run directory "${runDir}" already exists — this should never happen with the unique run-id scheme; aborting to avoid clobbering an existing run`,
    );
  }

  // Track for SIGINT diagnostic handler in cli.ts.
  activeRun.runDir = runDir;
  activeRun.homeDir = homeDir;

  // Lock BEFORE creating the worktree (advisor: avoid stray worktrees on failure).
  if (force === true) releaseLock(homeDir);
  acquireLock(homeDir, runId);

  // Parse frontmatter from plan to extract base_branch, severity, issueUrl.
  // Must happen before worktree creation (base_branch determines start-point).
  const planContent = readFileSync(planPath, "utf8");
  const frontmatter = parseFrontmatter(planContent);
  const baseBranch = frontmatter["base_branch"] ?? "main";
  const severity = frontmatter["severity"];
  const issueUrl = frontmatter["issue"];

  // Validate base branch exists in DEVHARNESS_SRC before any side effects.
  // Fail loud — a typo in base_branch would silently branch from HEAD.
  try {
    execSync(`git rev-parse --verify --quiet "${baseBranch}"`, {
      cwd: config.DEVHARNESS_SRC,
      stdio: "pipe",
    });
  } catch {
    releaseLock(homeDir);
    process.stderr.write(
      `dagrun: base_branch "${baseBranch}" not found in DEVHARNESS_SRC — fetch it first\n`,
    );
    process.exit(1);
  }

  // Create run directory and copy plan.
  mkdirSync(join(runDir, "plan"), { recursive: true });
  cpSync(planPath, join(runDir, "plan", "plan.md"));

  const branchName = makeBranchName(workflow.name, planPath);

  // Create git worktree from DEVHARNESS_SRC, branching from baseBranch start-point.
  // For feature workflow baseBranch is always "main"; for bugfix it may be a release branch.
  execSync(
    `git worktree add "${worktreePath}" -b "${branchName}" "${baseBranch}"`,
    {
      cwd: config.DEVHARNESS_SRC,
      stdio: "inherit",
    },
  );

  // Structural scratch backstop: seed the repo's .git/info/exclude so known
  // artifact filenames can never be staged or committed even if a prompt
  // accidentally writes to cwd instead of $DAGRUN_ARTIFACTS. Uses the common
  // gitdir (not per-worktree) — see DECISIONS.md § worktree-exclude-location.
  seedWorktreeExclude(worktreePath, worktreeArtifactPatterns());

  // Seed java + maven into .tool-versions and mark skip-worktree so the
  // implement node's pre-commit format hook resolves both tools without the
  // node having to add them and accidentally committing them.
  seedWorktreeToolVersions(worktreePath);

  // Symlink node_modules from the main DEVHARNESS_SRC checkout into the
  // worktree so the implement node can run frontend tests against the changed
  // source without a separate npm install.
  seedWorktreeNodeModules(worktreePath, config.DEVHARNESS_SRC);

  // Seed the worktree's .claude/ with dagrunner's bundled commands + hooks + a
  // node-run settings.json. Without this, a source repo with no .claude/commands/
  // causes node commands to return immediately with cost=0 and no output —
  // the SDK treats unknown slash commands as no-ops.
  const dagrunnerRoot = new URL("../../", import.meta.url).pathname;
  const destClaude = join(worktreePath, ".claude");
  mkdirSync(join(destClaude, "commands"), { recursive: true });
  mkdirSync(join(destClaude, "hooks"), { recursive: true });
  mkdirSync(join(destClaude, "agents"), { recursive: true });
  const srcCommands = join(dagrunnerRoot, "payload", "commands");
  const srcHooks = join(dagrunnerRoot, ".claude", "hooks");
  const srcAgents = join(dagrunnerRoot, "payload", "agents");
  if (!existsSync(srcCommands)) {
    throw new Error(
      `dagrun: bundled commands not found at ${srcCommands} — package installation may be broken`,
    );
  }
  if (!existsSync(srcHooks)) {
    throw new Error(
      `dagrun: bundled hooks not found at ${srcHooks} — package installation may be broken`,
    );
  }
  if (!existsSync(srcAgents)) {
    throw new Error(
      `dagrun: bundled agents not found at ${srcAgents} — package installation may be broken`,
    );
  }
  cpSync(srcCommands, join(destClaude, "commands"), { recursive: true });
  cpSync(srcHooks, join(destClaude, "hooks"), { recursive: true });
  cpSync(srcAgents, join(destClaude, "agents"), { recursive: true });

  // Seed sibling commands + scripts (ci-babysit, pr-triage, seed-data) into the
  // worktree. Also exports DAGRUNNER_ROOT so session-start.sh can re-apply siblings
  // at every node session start (satisfying the env-propagation contract in CLAUDE.md).
  // Must run AFTER pipeline commands so siblings land last and always win over
  // any DEVHARNESS_SRC rsync that session-start.sh may have applied.
  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  // Runtime settings.json: full permission/sandbox/network model (Phase 2a D1).
  // DISTINCT from the build-harness settings.json (bypassPermissions).
  // buildSeededSettings is the single authoritative template (settings-seed.ts).
  const seededSettings = buildSeededSettings({
    runDir,
    homeDir: homedir(),
    tmpDir: tmpdir(),
    passthrough: readSourcePassthrough(config.DEVHARNESS_SRC),
    ...(config.claudeConfigDir !== undefined
      ? { claudeConfigDir: config.claudeConfigDir }
      : {}),
    workProfileMcpServers: readWorkProfileMcpServers(
      config.claudeConfigDir ?? join(homedir(), ".claude"),
      worktreePath,
    ),
    devharnessSrc: config.DEVHARNESS_SRC,
    dagrunnerHome: homeDir,
  });
  writeFileSync(
    join(destClaude, "settings.json"),
    JSON.stringify(seededSettings, null, 2),
    "utf8",
  );

  const state: RunState = {
    runId,
    workflow: workflow.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    worktreePath,
    branch: branchName,
    sourcePlanPath: planPath,
    nodes: makeInitialNodeStates(workflow),
    // Frontmatter fields — survive resume via state.json.
    ...(baseBranch !== "main" ? { baseBranch } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(issueUrl !== undefined ? { issueUrl } : {}),
  };

  writeState(stateFile, state);
  process.stdout.write(`dagrun: starting run ${runId}\n`);

  // Export PR title prefix so the pr node session inherits it (env-propagation rule).
  // Must be set before the executor/SDK query() is spawned. The pr node uses this
  // to enforce Conventional Commits format: "{type}: {description}".
  process.env["DAGRUN_PR_TITLE_PREFIX"] = makePrTitlePrefix(workflow.name);

  // When no custom factory is provided, use makeSDKRunner with the night flag
  // so the correct permissionMode is selected per the two-posture rule.
  const defaultFactory: ExecutorFactory = (c, rid, rdir, wt, sd) =>
    makeSDKRunner(c, rid, rdir, wt, sd, opts.nightMode);
  const executor = wrapWithPrScan(
    (opts.executorFactory ?? defaultFactory)(
      config,
      runId,
      runDir,
      worktreePath,
      join(homeDir, "store"),
    ),
    worktreePath,
    runDir,
  );
  const ctx = makeCtx(runDir);
  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  runPrPostProcess(readState(stateFile), runDir);

  // Night-mode: auto-resolve agent-decidable gates in a loop.
  if (opts.nightMode === true && result.status === "paused") {
    let nightState = readState(stateFile);
    // Safety cap: max 20 iterations (the real pipeline has 2 decidable gates).
    for (let loops = 0; loops < 20; loops++) {
      const gateEntry = Object.entries(nightState.nodes).find(
        ([, ns]) => ns.status === "awaiting-gate",
      );
      if (gateEntry === undefined) break;
      const [gateNodeId, gateNodeState] = gateEntry;

      if (!agentDecidable(gateNodeId)) {
        releaseLock(homeDir);
        process.stdout.write(
          `dagrun: [night] paused — "${gateNodeId}" requires human decision\n`,
        );
        process.stdout.write(`dagrun: resume with: dagrun resume ${runId}\n`);
        return;
      }

      // Severity-aware pause: critical/blocker bugs always require a human gate,
      // regardless of whether concerns are flagged in the artifact.
      if (severityForcesPause(nightState.severity)) {
        releaseLock(homeDir);
        process.stdout.write(
          `dagrun: [night] paused at gate "${gateNodeId}" — severity "${nightState.severity ?? ""}" requires human review\n`,
        );
        process.stdout.write(`dagrun: resume with: dagrun resume ${runId}\n`);
        return;
      }

      // Read the primary artifact and check for a concerns heading.
      const gateNode = workflow.nodes.find((n) => n.id === gateNodeId);
      const primaryFile = gateNode?.produces?.[0];
      // Safe default: pause when artifact is missing/unreadable.
      let concerns = true;
      if (primaryFile !== undefined) {
        const artifactPath = join(runDir, gateNodeId, primaryFile);
        try {
          if (existsSync(artifactPath)) {
            concerns = hasConcerns(readFileSync(artifactPath, "utf8"));
          }
        } catch {
          // unreadable → concerns stays true → pause
        }
      }

      if (concerns) {
        releaseLock(homeDir);
        process.stdout.write(
          `dagrun: [night] paused at gate "${gateNodeId}" — concerns flagged in artifact\n`,
        );
        process.stdout.write(`dagrun: resume with: dagrun resume ${runId}\n`);
        return;
      }

      // Auto-approve: log to gateHistory with night-mode basis.
      const autoTs = new Date().toISOString();
      const basis = "no concerns flagged";
      const nightArtifacts = (gateNode?.produces ?? [])
        .map((f) => join(runDir, gateNodeId, f))
        .filter((p) => existsSync(p));
      nightState = {
        ...nightState,
        nodes: {
          ...nightState.nodes,
          [gateNodeId]: {
            ...gateNodeState,
            status: "done",
            artifacts: nightArtifacts,
            gateHistory: [
              ...gateNodeState.gateHistory,
              {
                decision: "approve" as const,
                timestamp: autoTs,
                mode: "night" as const,
                basis,
              },
            ],
          },
        },
        status: "running",
        updatedAt: autoTs,
      };
      writeState(stateFile, nightState);
      process.stdout.write(
        `dagrun: [night] auto-approved "${gateNodeId}" — ${basis}\n`,
      );

      // Verify-election is human-only: always park after fix is auto-approved.
      if (nightState.verifyElection === undefined) {
        const hasVerifyNode = workflow.nodes.some((n) => n.id === "verify");
        const fixDone = nightState.nodes["fix"]?.status === "done";
        if (hasVerifyNode && fixDone) {
          const parkState = {
            ...nightState,
            status: "paused" as const,
            updatedAt: new Date().toISOString(),
          };
          writeState(stateFile, parkState);
          releaseLock(homeDir);
          process.stdout.write(
            `dagrun: [night] paused at verify-election (human decision required)\n`,
          );
          process.stdout.write(
            `dagrun: resume with: dagrun resume ${runId} --verify y|n\n`,
          );
          return;
        }
      }

      // Re-run the DAG from the newly approved gate.
      const nightResult = await runDag(workflow, executor, nightState, {
        ctx,
        stateFile,
      });
      runPrPostProcess(readState(stateFile), runDir);
      nightState = readState(stateFile);

      if (nightResult.status !== "paused") {
        releaseLock(homeDir);
        process.stdout.write(`dagrun: run ${runId} ${nightResult.status}\n`);
        if (nightResult.status === "failed") process.exit(1);
        return;
      }
    }
    // Fell through safety cap — treat as a regular checkpoint.
    releaseLock(homeDir);
    const gateNode = Object.entries(nightState.nodes).find(
      ([, ns]) => ns.status === "awaiting-gate",
    );
    process.stdout.write(
      `dagrun: checkpointed at gate — node "${gateNode?.[0] ?? "unknown"}" awaiting review\n`,
    );
    process.stdout.write(`dagrun: resume with: dagrun resume ${runId}\n`);
    return;
  }

  // Attended mode (default) — behavior unchanged.
  // Paused = gate checkpoint: release lock so another start can proceed.
  if (result.status === "paused") {
    releaseLock(homeDir);
    const gateNode = Object.entries(result.nodes).find(
      ([, ns]) => ns.status === "awaiting-gate",
    );
    process.stdout.write(
      `dagrun: checkpointed at gate — node "${gateNode?.[0] ?? "unknown"}" awaiting review\n`,
    );
    process.stdout.write(`dagrun: resume with: dagrun resume ${runId}\n`);
  } else {
    releaseLock(homeDir);
    process.stdout.write(`dagrun: run ${runId} ${result.status}\n`);
    if (result.status === "failed") process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// resumeRun
// ---------------------------------------------------------------------------

export async function resumeRun(opts: {
  runId: string;
  homeDir: string;
  config: DagrunnerConfig;
  approve?: boolean;
  rejectComment?: string;
  /** Non-interactive election answer: 'y' = run verify, 'n' = skip. */
  verify?: "y" | "n";
  executorFactory?: ExecutorFactory;
}): Promise<void> {
  const { runId, homeDir, config } = opts;
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");

  // Track for SIGINT diagnostic handler in cli.ts.
  activeRun.runDir = runDir;
  activeRun.homeDir = homeDir;

  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun: run "${runId}" not found at ${stateFile}\n`);
    process.exit(1);
  }

  // Reconcile: running → failed (crash recovery). Then re-acquire lock.
  let state = reconcileRunningNodes(readState(stateFile));
  releaseLock(homeDir);
  acquireLock(homeDir, runId);
  writeState(stateFile, state);

  const workflow = workflowFromState(state);

  // Any node that was running when the process was interrupted is marked
  // failed by reconcileRunningNodes. Reset interrupted nodes to pending up
  // to MAX_INTERRUPT_RETRIES times; beyond the cap, leave them failed so
  // a genuinely broken node eventually settles the run to "failed".
  const stateBefore = state;
  state = resetInterruptedNodes(state, MAX_INTERRUPT_RETRIES);
  for (const [id, ns] of Object.entries(state.nodes)) {
    const prev = stateBefore.nodes[id];
    if (ns.status === "pending" && prev?.status === "failed") {
      process.stdout.write(
        `dagrun: node "${id}" was interrupted — resetting to pending for retry (attempt ${String(ns.interruptRetries ?? 0)}/${String(MAX_INTERRUPT_RETRIES)})\n`,
      );
    } else if (
      ns.status === "failed" &&
      ns.error === "process interrupted — reconciled on resume"
    ) {
      process.stdout.write(
        `dagrun: node "${id}" interrupted retry cap (${String(MAX_INTERRUPT_RETRIES)}) exceeded — leaving failed\n`,
      );
    }
  }
  writeState(stateFile, state);

  // Find the awaiting-gate node (single-awaiting-gate invariant).
  const gateEntry = Object.entries(state.nodes).find(
    ([, ns]) => ns.status === "awaiting-gate",
  );

  if (gateEntry !== undefined) {
    const [gateNodeId, gateNodeState] = gateEntry;
    const artifactsDir = join(runDir, gateNodeId);

    // Find the gate config for maxIterations check.
    const gateNode = workflow.nodes.find((n) => n.id === gateNodeId);

    // Stale gate: node existed in a prior workflow version but is not in the current one.
    // Auto-skip it — the node is non-runnable; no user decision makes sense.
    if (gateNode === undefined) {
      process.stdout.write(
        `dagrun: skipping stale gate "${gateNodeId}" (node not in current workflow)\n`,
      );
      state = {
        ...state,
        nodes: {
          ...state.nodes,
          [gateNodeId]: {
            ...gateNodeState,
            status: "skipped",
            endedAt: new Date().toISOString(),
          },
        },
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      writeState(stateFile, state);
    } else {
      const maxIterations = gateNode.gate?.maxIterations ?? 10;

      if (opts.rejectComment !== undefined) {
        // Check maxIterations — at the limit, do not auto-revise (spec: terminal choice).
        if (gateNodeState.iteration >= maxIterations) {
          process.stdout.write(
            `dagrun: maxIterations (${maxIterations}) reached for "${gateNodeId}".\n` +
              `  Use --approve to accept as-is, or dagrun abort ${runId} to abort.\n`,
          );
          releaseLock(homeDir);
          process.exit(0);
        }

        // Write feedback file (feedback-N.md where N = iteration count + 1).
        const n = gateNodeState.iteration + 1;
        writeFileSync(
          join(artifactsDir, `feedback-${n}.md`),
          opts.rejectComment,
          "utf8",
        );

        // Reset to pending so DAG re-runs the node with the feedback.
        state = {
          ...state,
          nodes: {
            ...state.nodes,
            [gateNodeId]: {
              ...gateNodeState,
              status: "pending",
              iteration: n,
              gateHistory: [
                ...gateNodeState.gateHistory,
                {
                  decision: "reject",
                  comment: opts.rejectComment,
                  timestamp: new Date().toISOString(),
                },
              ],
            },
          },
          status: "running",
          updatedAt: new Date().toISOString(),
        };
        writeState(stateFile, state);
        process.stdout.write(
          `dagrun: rejected — node "${gateNodeId}" will revise (iteration ${n})\n`,
        );
      } else if (opts.approve === true) {
        // Approve: mark done, collect artifacts from disk, continue.
        const approvedArtifacts = (gateNode?.produces ?? [])
          .map((f) => join(artifactsDir, f))
          .filter((p) => existsSync(p));
        state = {
          ...state,
          nodes: {
            ...state.nodes,
            [gateNodeId]: {
              ...gateNodeState,
              status: "done",
              artifacts: approvedArtifacts,
              gateHistory: [
                ...gateNodeState.gateHistory,
                {
                  decision: "approve",
                  timestamp: new Date().toISOString(),
                },
              ],
            },
          },
          status: "running",
          updatedAt: new Date().toISOString(),
        };
        writeState(stateFile, state);
        process.stdout.write(`dagrun: approved — continuing run\n`);
      } else {
        // Interactive gate UX — spawn a fresh Claude Code session for review dialogue.
        //
        // The human and a Claude agent review the artifact together over as many turns
        // as needed. /gate-review opens the review; /gate-conclude writes the decision.
        // dagrunner reads gate-decision.md after the claude process exits and routes
        // accordingly (approve / reject / absent = still open).
        //
        // Note: `claude --resume <sdkSessionId>` does NOT work here — the Agent SDK
        // and the interactive Claude Code CLI do not share a session store.
        // See DECISIONS.md § gate-dialogue-ux.

        const primaryProduces = gateNode?.produces?.[0] ?? "artifact";
        const artifactPath = join(artifactsDir, primaryProduces);

        // Paths for the two handshake files.
        const contextFilePath = join(artifactsDir, "gate-context.md");
        const decisionFilePath = join(artifactsDir, "gate-decision.md");

        // Guard: delete any stale decision from a prior iteration.
        if (existsSync(decisionFilePath)) {
          unlinkSync(decisionFilePath);
        }

        // Write gate-context.md so /gate-review can orient the dialogue.
        const artifactContent = existsSync(artifactPath)
          ? readFileSync(artifactPath, "utf8")
          : "(artifact not found)";
        const contextContent = [
          `# Gate context — ${gateNodeId}`,
          ``,
          `**Node:** ${gateNodeId}`,
          `**Run ID:** ${runId}`,
          `**Iteration:** ${gateNodeState.iteration + 1} / ${maxIterations}`,
          `**Artifact path:** ${artifactPath}`,
          `**Gate-decision file:** ${decisionFilePath}`,
          ``,
          `## Artifact`,
          ``,
          artifactContent,
        ].join("\n");
        writeFileSync(contextFilePath, contextContent, "utf8");

        // Print guidance before spawning.
        process.stdout.write(
          `\ndagrun: gate — node "${gateNodeId}" (iteration ${gateNodeState.iteration + 1}/${maxIterations})\n` +
            `dagrun: opening Claude Code for review dialogue...\n` +
            `  → In the session: run /gate-review to start the review\n` +
            `  → When done:       run /gate-conclude to record your decision\n` +
            `  → To exit:         type /exit (not Ctrl-C)\n\n`,
        );

        // Spawn an interactive claude session. spawnSync blocks until the user exits.
        const spawnResult = spawnSync(
          "claude",
          ["--model", "claude-sonnet-4-6"],
          {
            stdio: "inherit",
            cwd: state.worktreePath,
            env: {
              ...process.env,
              DAGRUN_GATE_NODE_ID: gateNodeId,
              DAGRUN_GATE_CONTEXT_FILE: contextFilePath,
              DAGRUN_GATE_DECISION_FILE: decisionFilePath,
            },
          },
        );

        // If claude couldn't launch (e.g. not on PATH), fail loud — never look like success.
        if (spawnResult.error !== undefined) {
          process.stderr.write(
            `dagrun: failed to launch 'claude' — ${spawnResult.error.message}\n` +
              `  Ensure the claude CLI is on PATH and retry: dagrun resume ${runId}\n`,
          );
          releaseLock(homeDir);
          process.exit(1);
        }

        // Read and parse the decision written by /gate-conclude.
        if (!existsSync(decisionFilePath)) {
          process.stdout.write(
            `dagrun: no gate decision recorded — run \`dagrun resume ${runId}\` to review again\n`,
          );
          releaseLock(homeDir);
          process.exit(0);
        }

        const decisionContent = readFileSync(decisionFilePath, "utf8");
        const parsed = parseGateDecision(decisionContent);

        if (parsed === null) {
          process.stdout.write(
            `dagrun: gate-decision.md could not be parsed — run \`dagrun resume ${runId}\` to review again\n`,
          );
          releaseLock(homeDir);
          process.exit(0);
        }

        if (parsed.decision === "approve") {
          await resumeRun({ ...opts, approve: true });
          return;
        } else {
          // reject: pass the consensus feedback body as the rejectComment.
          const comment = parsed.body !== "" ? parsed.body : "rejected";
          await resumeRun({ ...opts, rejectComment: comment });
          return;
        }
      }
    } // closes else (gateNode !== undefined)
  }

  // verify-election: conducted once, after fix (Gate 2) is approved.
  // Only applies when the workflow has a verify node and election is not yet recorded.
  if (state.verifyElection === undefined) {
    const hasVerifySeed = workflow.nodes.some((n) => n.id === "verify");
    const fixDone = state.nodes["fix"]?.status === "done";
    if (hasVerifySeed && fixDone) {
      // Surface the observability recommendation from review/findings.json (fail-soft).
      // Printed on both the interactive and --verify paths so it is always recorded.
      let verifyAdvisory = "";
      try {
        const findingsPath = join(runDir, "review", "findings.json");
        if (existsSync(findingsPath)) {
          const findings = JSON.parse(
            readFileSync(findingsPath, "utf8"),
          ) as unknown;
          verifyAdvisory = formatVerifyRecommendation(findings);
        }
      } catch {
        // Degrade silently — recommendation is advisory, not load-bearing.
      }
      if (verifyAdvisory !== "") {
        process.stdout.write(`\n${verifyAdvisory}\n`);
      }

      let electionAnswer: "y" | "n";
      if (opts.verify !== undefined) {
        electionAnswer = opts.verify;
        process.stdout.write(
          `dagrun: verify-election = ${electionAnswer} (from --verify flag)\n`,
        );
      } else {
        process.stdout.write(
          "\nRun verify (produces seeding spec + manual-test guide, no cluster)? [y/n] > ",
        );
        const answer = await readOneLine();
        electionAnswer = answer.trim() === "y" ? "y" : "n";
      }

      state = {
        ...state,
        verifyElection: electionAnswer,
        updatedAt: new Date().toISOString(),
      };

      if (electionAnswer === "n") {
        // Pre-mark verify as skipped so the DAG routes directly to pr.
        const verifySeedNodeState = state.nodes["verify"];
        if (verifySeedNodeState !== undefined) {
          state = {
            ...state,
            nodes: {
              ...state.nodes,
              verify: {
                ...verifySeedNodeState,
                status: "skipped",
                endedAt: new Date().toISOString(),
              },
            },
          };
        }
        process.stdout.write(
          "dagrun: skipping runtime verification — proceeding to pr\n",
        );
      } else {
        process.stdout.write("dagrun: will run verify + Gate 3\n");
      }

      writeState(stateFile, state);
    }
  }

  // Re-seed siblings into the worktree and export DAGRUNNER_ROOT so session-start.sh
  // can re-apply them at every node session start. resumeRun is a fresh process —
  // DAGRUNNER_ROOT set in a prior startRun does not survive here.
  {
    const dagrunnerRoot = new URL("../../", import.meta.url).pathname;
    const destClaude = join(state.worktreePath, ".claude");
    seedWorktreeSiblings(dagrunnerRoot, destClaude);
  }

  // Export PR title prefix before executor/SDK query() so the pr node session inherits it.
  // resumeRun is a fresh process — the env set in startRun does not survive here.
  process.env["DAGRUN_PR_TITLE_PREFIX"] = makePrTitlePrefix(workflow.name);

  // Re-run the DAG engine with the (possibly updated) state.
  const executor = wrapWithPrScan(
    (opts.executorFactory ?? makeSDKRunner)(
      config,
      runId,
      runDir,
      state.worktreePath,
      join(homeDir, "store"),
    ),
    state.worktreePath,
    runDir,
  );
  const ctx = makeCtx(runDir);
  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  runPrPostProcess(readState(stateFile), runDir);

  if (result.status === "paused") {
    releaseLock(homeDir);
    const gateNode = Object.entries(result.nodes).find(
      ([, ns]) => ns.status === "awaiting-gate",
    );
    process.stdout.write(
      `dagrun: re-paused at gate — node "${gateNode?.[0] ?? "unknown"}"\n`,
    );
    process.stdout.write(`dagrun: resume with: dagrun resume ${runId}\n`);
  } else {
    releaseLock(homeDir);
    process.stdout.write(`dagrun: run ${runId} ${result.status}\n`);
    if (result.status === "failed") process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// runPrPostProcess — push branch + open draft PR outside the agent sandbox
// ---------------------------------------------------------------------------

/**
 * After the pr node's agent session exits, push the feature branch and create
 * a draft PR using Node.js (outside the Claude Code sandbox). This avoids the
 * TLS certificate error that occurs when `gh` (Go binary) runs inside the
 * sandbox — Go's TLS stack doesn't trust the sandbox proxy certificate, while
 * Node.js and macOS-native tools use the keychain correctly.
 *
 * Reads pr-meta.json for the branch and title written by the agent.
 * Writes prUrl back to pr-meta.json on success, pr-error.txt on failure.
 * Idempotent — skips if prUrl is already set.
 */
function runPrPostProcess(state: RunState, runDir: string): void {
  const prNodeState = state.nodes["pr"];
  if (prNodeState?.status !== "done") return;

  // Primary locations (correct): runs/<id>/pr/body.md and pr-meta.json.
  // Fallback locations (miswrite): agent used $DAGRUN_RUN_DIR instead of
  // $DAGRUN_ARTIFACTS and wrote to the run dir root. Accept both so the
  // post-process still fires even when the agent got the path wrong.
  const metaPath = existsSync(join(runDir, "pr", "pr-meta.json"))
    ? join(runDir, "pr", "pr-meta.json")
    : existsSync(join(runDir, "pr-meta.json"))
      ? join(runDir, "pr-meta.json")
      : "";
  const bodyPath = existsSync(join(runDir, "pr", "body.md"))
    ? join(runDir, "pr", "body.md")
    : existsSync(join(runDir, "body.md"))
      ? join(runDir, "body.md")
      : "";
  if (metaPath === "" || bodyPath === "") return;

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return;
  }

  if (typeof meta["prUrl"] === "string" && meta["prUrl"] !== "") return;

  const worktreePath = state.worktreePath;
  const title =
    typeof meta["title"] === "string" ? meta["title"] : state.branch;
  const errorPath = join(runDir, "pr", "pr-error.txt");

  // Push the branch (idempotent — may already be done from a prior attempt).
  try {
    execSync(`git -C "${worktreePath}" push origin HEAD`, { stdio: "pipe" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeFileSync(errorPath, `git push failed: ${msg}\n`);
    process.stdout.write(`dagrun: git push failed — see ${errorPath}\n`);
    return;
  }

  // Create the draft PR, targeting the run's base branch (supports hotfix branches).
  const baseBranch = state.baseBranch ?? "main";
  try {
    const url = execSync(
      `gh pr create --draft --title ${JSON.stringify(title)} --body-file "${bodyPath}" --base ${JSON.stringify(baseBranch)}`,
      { cwd: worktreePath, encoding: "utf8" },
    ).trim();
    meta["prUrl"] = url;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    process.stdout.write(`dagrun: draft PR created: ${url}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeFileSync(errorPath, `gh pr create failed: ${msg}\n`);
    process.stdout.write(`dagrun: PR creation failed — see ${errorPath}\n`);
    process.stdout.write(
      `  Manual: cd "${worktreePath}" && gh pr create --draft --title ${JSON.stringify(title)} --body-file "${bodyPath}" --base ${JSON.stringify(baseBranch)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readOneLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", function onData(chunk: string) {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        resolve(buf.slice(0, nl).trim());
      }
    });
  });
}

// ---------------------------------------------------------------------------
// listRuns — enumerate all run state files under <homeDir>/runs/
// ---------------------------------------------------------------------------

export function listRuns(
  homeDir: string,
): Array<{ runId: string; status: string; updatedAt: string }> {
  const runsDir = join(homeDir, "runs");
  if (!existsSync(runsDir)) return [];

  const entries = readdirSync(runsDir, { withFileTypes: true });
  const results: Array<{ runId: string; status: string; updatedAt: string }> =
    [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stateFile = join(runsDir, entry.name, "state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const s = readState(stateFile);
      results.push({
        runId: s.runId,
        status: s.status,
        updatedAt: s.updatedAt,
      });
    } catch {
      // Corrupt state — skip.
    }
  }

  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------------------------------------------------------------------------
// rerunNode — re-execute a single node against an existing run's worktree
// ---------------------------------------------------------------------------

/**
 * Re-execute a single workflow node in isolation, using the existing worktree
 * and run directory. Useful for testing node prompt changes or recovering from
 * a failed node without restarting the whole workflow.
 *
 * Lock discipline: rerunNode does NOT acquire the run lock — it is a debug/
 * recovery tool. Ensure no other dagrun process is running the same run.
 *
 * On completion the node's entry in state.json is updated to reflect the new
 * result, so `dagrun resume <run-id>` can continue the DAG from there.
 */
export async function rerunNode(opts: {
  runId: string;
  nodeId: string;
  homeDir: string;
  config: DagrunnerConfig;
  executorFactory?: ExecutorFactory;
}): Promise<void> {
  const { runId, nodeId, homeDir, config } = opts;
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");

  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun: run "${runId}" not found at ${stateFile}\n`);
    process.exit(1);
  }

  const state = readState(stateFile);
  const workflow = workflowFromState(state);
  const node = workflow.nodes.find((n) => n.id === nodeId);

  if (node === undefined) {
    const available = workflow.nodes.map((n) => n.id).join(", ");
    process.stderr.write(
      `dagrun: node "${nodeId}" not found in workflow "${state.workflow}".\n` +
        `  Available nodes: ${available}\n`,
    );
    process.exit(1);
  }

  const worktreePath = state.worktreePath;
  const artifactsDir = join(runDir, nodeId);

  // Re-seed .claude/ so any changes to commands, hooks, or settings-seed.ts
  // take effect without needing a new full run (e.g. allowedDomains fixes).
  const dagrunnerRoot = new URL("../../", import.meta.url).pathname;
  const destClaude = join(worktreePath, ".claude");
  const srcCommands = join(dagrunnerRoot, "payload", "commands");
  const srcHooks = join(dagrunnerRoot, ".claude", "hooks");
  const srcAgents = join(dagrunnerRoot, "payload", "agents");
  if (existsSync(srcCommands))
    cpSync(srcCommands, join(destClaude, "commands"), { recursive: true });
  if (existsSync(srcHooks))
    cpSync(srcHooks, join(destClaude, "hooks"), { recursive: true });
  if (existsSync(srcAgents))
    cpSync(srcAgents, join(destClaude, "agents"), { recursive: true });

  // Re-seed siblings and export DAGRUNNER_ROOT (rerunNode is a fresh process).
  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  const seededSettings = buildSeededSettings({
    runDir,
    homeDir: homedir(),
    tmpDir: tmpdir(),
    passthrough: readSourcePassthrough(config.DEVHARNESS_SRC),
    ...(config.claudeConfigDir !== undefined
      ? { claudeConfigDir: config.claudeConfigDir }
      : {}),
    workProfileMcpServers: readWorkProfileMcpServers(
      config.claudeConfigDir ?? join(homedir(), ".claude"),
      worktreePath,
    ),
    devharnessSrc: config.DEVHARNESS_SRC,
    dagrunnerHome: homeDir,
  });
  writeFileSync(
    join(destClaude, "settings.json"),
    JSON.stringify(seededSettings, null, 2),
    "utf8",
  );

  // Wipe previous artifacts so the node starts clean.
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  process.stdout.write(
    `dagrun: rerunning node "${nodeId}" in run "${runId}"\n` +
      `  Worktree: ${worktreePath}\n` +
      `  Artifacts: ${artifactsDir}\n`,
  );

  // Export PR title prefix before executor/SDK query() so the pr node session inherits it.
  process.env["DAGRUN_PR_TITLE_PREFIX"] = makePrTitlePrefix(state.workflow);

  const executor = (opts.executorFactory ?? makeSDKRunner)(
    config,
    runId,
    runDir,
    worktreePath,
    join(homeDir, "store"),
  );
  const execCtx: ExecutionCtx = { runDir, artifactsDir, worktreePath };
  const result = await executor(nodeId, node, execCtx);

  // Build the updated node state — mirror what runDag does.
  const now = new Date().toISOString();
  const prev = state.nodes[nodeId] ?? {
    status: "pending" as NodeStatus,
    artifacts: [],
    iteration: 0,
    cost: 0,
    gateHistory: [],
  };

  let newStatus: NodeStatus;
  let updates: Partial<NodeState>;

  if (result.status === "done") {
    const missing = (node.produces ?? []).filter(
      (f) => !existsSync(join(runDir, nodeId, f)),
    );
    if (missing.length > 0) {
      newStatus = "failed";
      updates = {
        status: newStatus,
        error: `produces contract violated — missing: ${missing.join(", ")}`,
        endedAt: now,
      };
    } else {
      newStatus = "done";
      updates = {
        status: newStatus,
        artifacts: result.artifacts,
        cost: result.cost,
        sessionId: result.sessionId,
        endedAt: now,
      };
    }
  } else if (result.status === "awaiting-gate") {
    newStatus = "awaiting-gate";
    updates = {
      status: newStatus,
      iteration: result.iteration,
      sessionId: result.sessionId,
      cost: result.cost,
      endedAt: now,
    };
  } else {
    newStatus = "failed";
    updates = {
      status: newStatus,
      error: result.error,
      endedAt: now,
    };
  }

  const updatedState: RunState = {
    ...state,
    updatedAt: now,
    nodes: {
      ...state.nodes,
      [nodeId]: { ...prev, ...updates },
    },
  };
  writeState(stateFile, updatedState);
  runPrPostProcess(updatedState, runDir);

  process.stdout.write(`dagrun: node "${nodeId}" rerun → ${newStatus}\n`);
  if (newStatus === "done" || newStatus === "awaiting-gate") {
    process.stdout.write(`  To continue: dagrun resume ${runId}\n`);
  }
}

// ---------------------------------------------------------------------------
// scaffoldRun — create an isolated run for a single node with deps pre-done
// ---------------------------------------------------------------------------

/**
 * Create a scaffold run for a single DAG node in isolation.
 *
 * This lets a developer test one node without running the full pipeline:
 *   1. Creates a fresh run dir + git worktree seeded from a feature branch
 *   2. Writes state.json with all transitive deps marked "done", target "pending"
 *   3. Optionally copies mock artifacts into dep dirs
 *   4. Prints the run ID and the `dagrun rerun` command to execute the node
 *
 * Lock discipline: scaffoldRun does NOT acquire the run lock — like rerunNode,
 * it is a debug/developer tool. The node is run via `dagrun rerun` which also
 * does not acquire the lock.
 */
export async function scaffoldRun(opts: {
  nodeId: string;
  homeDir: string;
  config: DagrunnerConfig;
  /** Feature branch name to checkout from DEVHARNESS_SRC (creates a new scaffold branch starting there) */
  branch: string;
  /** Optional dir whose contents are cpSync'd into runDir (structure: <mocksDir>/<depNodeId>/<file>) */
  mocksDir?: string;
}): Promise<void> {
  const { nodeId, homeDir, config, branch, mocksDir } = opts;

  // Step 1: Load workflow and find the target node. Fail loud if not found.
  const workflow = featureWorkflow;
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node === undefined) {
    const available = workflow.nodes.map((n) => n.id).join(", ");
    process.stderr.write(
      `dagrun scaffold: node "${nodeId}" not found in workflow "feature".\n` +
        `  Available nodes: ${available}\n`,
    );
    process.exit(1);
  }

  // Step 2: Validate branch exists in DEVHARNESS_SRC before any side effects.
  try {
    execSync(
      `git -C "${config.DEVHARNESS_SRC}" rev-parse --verify --quiet "${branch}"`,
      { stdio: "pipe" },
    );
  } catch {
    process.stderr.write(
      `dagrun scaffold: branch '${branch}' not found in DEVHARNESS_SRC — fetch it first\n`,
    );
    process.exit(1);
  }

  // Step 3: Generate run ID and paths. Capture timestamp ONCE so runId, branch
  // name, and state.json all agree on the same timestamp.
  const ts = Date.now();
  const runId = `scaffold-${nodeId}-${ts}`;
  const branchName = `scaffold/${nodeId}-${ts}`;
  const runDir = join(homeDir, "runs", runId);
  const worktreePath = join(homeDir, "worktrees", runId);

  // Step 4: Create run dir.
  mkdirSync(runDir, { recursive: true });

  // Step 5: Create worktree from the feature branch start-point.
  execSync(
    `git worktree add "${worktreePath}" -b "${branchName}" "${branch}"`,
    {
      cwd: config.DEVHARNESS_SRC,
      stdio: "inherit",
    },
  );

  // Step 6: Seed .claude/ into the worktree (same pattern as rerunNode).
  const dagrunnerRoot = new URL("../../", import.meta.url).pathname;
  const destClaude = join(worktreePath, ".claude");
  mkdirSync(join(destClaude, "commands"), { recursive: true });
  mkdirSync(join(destClaude, "hooks"), { recursive: true });
  mkdirSync(join(destClaude, "agents"), { recursive: true });
  const srcCommands = join(dagrunnerRoot, "payload", "commands");
  const srcHooks = join(dagrunnerRoot, ".claude", "hooks");
  const srcAgents = join(dagrunnerRoot, "payload", "agents");
  if (existsSync(srcCommands))
    cpSync(srcCommands, join(destClaude, "commands"), { recursive: true });
  if (existsSync(srcHooks))
    cpSync(srcHooks, join(destClaude, "hooks"), { recursive: true });
  if (existsSync(srcAgents))
    cpSync(srcAgents, join(destClaude, "agents"), { recursive: true });

  seedWorktreeSiblings(dagrunnerRoot, destClaude);

  const seededSettings = buildSeededSettings({
    runDir,
    homeDir: homedir(),
    tmpDir: tmpdir(),
    passthrough: readSourcePassthrough(config.DEVHARNESS_SRC),
    ...(config.claudeConfigDir !== undefined
      ? { claudeConfigDir: config.claudeConfigDir }
      : {}),
    workProfileMcpServers: readWorkProfileMcpServers(
      config.claudeConfigDir ?? join(homedir(), ".claude"),
      worktreePath,
    ),
    devharnessSrc: config.DEVHARNESS_SRC,
    dagrunnerHome: homeDir,
  });
  writeFileSync(
    join(destClaude, "settings.json"),
    JSON.stringify(seededSettings, null, 2),
    "utf8",
  );

  // Step 7: Compute transitive deps of nodeId via BFS over dependsOn.
  const transitiveDeps = new Set<string>();
  const queue: string[] = [...(node.dependsOn ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const depId = queue.shift()!;
    if (visited.has(depId)) continue;
    visited.add(depId);
    transitiveDeps.add(depId);
    const depNode = workflow.nodes.find((n) => n.id === depId);
    for (const grandDep of depNode?.dependsOn ?? []) {
      if (!visited.has(grandDep)) queue.push(grandDep);
    }
  }

  // Step 8: Build node states — reuse makeInitialNodeStates for correct typing,
  // then flip transitive deps to "done". Target + rest stay "pending".
  const nodes = makeInitialNodeStates(workflow);
  for (const depId of transitiveDeps) {
    const existing = nodes[depId];
    if (existing !== undefined) {
      nodes[depId] = {
        ...existing,
        status: "done",
        artifacts: [],
        iteration: 0,
        cost: 0,
        gateHistory: [],
      };
    }
  }

  const now = new Date().toISOString();
  const state: RunState = {
    runId,
    workflow: "feature",
    createdAt: now,
    updatedAt: now,
    status: "paused",
    worktreePath,
    branch: branchName,
    sourcePlanPath: "",
    nodes,
  };

  const stateFile = join(runDir, "state.json");
  writeState(stateFile, state);

  // Step 9: Create artifact dirs for each dep node.
  for (const depId of transitiveDeps) {
    mkdirSync(join(runDir, depId), { recursive: true });
  }

  // Step 10: Copy mock artifacts if provided.
  if (mocksDir !== undefined) {
    if (existsSync(mocksDir)) {
      cpSync(mocksDir, runDir, { recursive: true });
    } else {
      process.stderr.write(
        `dagrun scaffold: warning — --mocks dir "${mocksDir}" does not exist; skipping mock copy\n`,
      );
    }
  }

  // Step 11: Print summary.
  const depList = Array.from(transitiveDeps);
  const mockHints = depList
    .map((depId) => {
      const depNode = workflow.nodes.find((n) => n.id === depId);
      const produces = depNode?.produces ?? [];
      const suffix = produces.length > 0 ? `  <- ${produces.join(", ")}` : "";
      return `  ${join(runDir, depId)}/${suffix}`;
    })
    .join("\n");

  process.stdout.write(
    `dagrun: scaffold run created: ${runId}\n` +
      `  Worktree: ${worktreePath}  (branch: ${branchName} from ${branch})\n` +
      `  Artifacts dir: ${runDir}\n` +
      `\n` +
      `Dep mock locations (place files here before rerunning):\n` +
      (mockHints.length > 0 ? `${mockHints}\n` : `  (no deps)\n`) +
      `\n` +
      `To run the node:\n` +
      `  dagrun rerun ${runId} ${nodeId}\n`,
  );
}
