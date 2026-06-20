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

import { execSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

// Mutable ref so the SIGINT handler in cli.ts can find the active run dir and
// release the lock cleanly. Mutated (not reassigned) so the export stays stable.
export const activeRun: { runDir?: string; homeDir?: string } = {};
import { join, basename } from "node:path";
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

/** Node IDs that night-mode may auto-approve (Gate 1 + Gate 2). */
const AGENT_DECIDABLE_GATES = new Set(["expand", "fix"]);

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
 * Build a unique run ID from a plan path, a timestamp, and a short random
 * suffix. The suffix (default: 3 random bytes as lowercase hex) closes the
 * same-millisecond collision window while keeping the id human-readable.
 *
 * Format: <slug>-<timestamp>-<hex suffix>
 *   e.g. my-plan-1750000000000-a3f9b2
 *
 * The suffix is injectable for deterministic unit testing (pass a fixed
 * string); production code uses the default randomBytes path.
 *
 * All three segments are lowercase alphanumeric + hyphens — git-branch-safe.
 * Exported for unit testing.
 */
export function makeRunId(
  planPath: string,
  now: number,
  suffix = randomBytes(3).toString("hex"),
): string {
  const slug = basename(planPath, ".md")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  return `${slug}-${now}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Branch naming — Conventional Commits style
// ---------------------------------------------------------------------------

const WORKFLOW_TYPE_PREFIX: Record<string, string> = {
  feature: "feat",
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
 * Extract the first H1/H2 heading from a plan file and slugify it.
 * Falls back to "run" if no heading is found.
 * Exported for unit testing.
 */
export function slugifyPlanHeading(planPath: string): string {
  const content = readFileSync(planPath, "utf8");
  const match = content.match(/^#{1,2}\s+(.+)/m);
  const heading = (match ? match[1] : undefined) ?? "run";
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30)
    .replace(/-$/, "");
}

/**
 * Compute the git branch name for a new run.
 * Format: <type>/<heading-slug>-<3-hex>
 *   e.g. feat/add-retry-logic-a3f
 *
 * The suffix is injectable for deterministic unit testing.
 * Exported for unit testing.
 */
export function makeBranchName(
  workflowName: string,
  planPath: string,
  suffix = randomBytes(2).toString("hex").slice(0, 3),
): string {
  const prefix = WORKFLOW_TYPE_PREFIX[workflowName] ?? "feat";
  const slug = slugifyPlanHeading(planPath);
  return `${prefix}/${slug}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Worktree hygiene — structural scratch backstop
// ---------------------------------------------------------------------------

/**
 * Returns all known artifact filenames (from featureWorkflow.produces) plus
 * secondary scratch patterns. Used for both .gitignore seeding and the
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
  for (const p of ["*.tmp", "*-state.json", "pr-meta.json", ".gitignore"]) {
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
    if (patterns.some((p) => matchesHygienePattern(name, p))) {
      result.push(filePath);
    }
  }
  return result;
}

function matchesHygienePattern(name: string, pattern: string): boolean {
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

/**
 * Write a .gitignore to the worktree root seeded with dagrunner artifact and
 * scratch patterns. The file lists itself so it doesn't appear in git status.
 * Fail-soft: logs a warning on error and never throws.
 */
function seedWorktreeGitignore(worktreePath: string, patterns: string[]): void {
  try {
    const lines = [
      "# dagrunner artifact backstop — auto-generated, do not edit",
      ...patterns,
      "",
    ].join("\n");
    writeFileSync(join(worktreePath, ".gitignore"), lines, "utf8");
  } catch (err) {
    process.stderr.write(
      `dagrun: warning — could not seed worktree .gitignore: ${String(err)}\n`,
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
      "\n  These are excluded from git by .gitignore — they cannot be staged or committed.\n" +
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
  const patterns = worktreeArtifactPatterns();
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

  const runId = makeRunId(planPath, Date.now());
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");
  const worktreePath = join(homeDir, "worktrees", runId);

  // Defensive backstop: the random suffix makes collision essentially impossible,
  // but we assert loudly rather than silently clobber an existing run.
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

  // Create run directory and copy plan.
  mkdirSync(join(runDir, "plan"), { recursive: true });
  cpSync(planPath, join(runDir, "plan", "plan.md"));

  const branchName = makeBranchName(workflow.name, planPath);

  // Create git worktree from DEVHARNESS_SRC (must run in that repo's root).
  execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
    cwd: config.DEVHARNESS_SRC,
    stdio: "inherit",
  });

  // Structural scratch backstop: seed .gitignore in the worktree so known
  // artifact filenames can never be staged or committed even if a prompt
  // accidentally writes to cwd instead of $DAGRUN_ARTIFACTS.
  seedWorktreeGitignore(worktreePath, worktreeArtifactPatterns());

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
    workProfileMcpServers: readWorkProfileMcpServers(homedir(), worktreePath),
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
  };

  writeState(stateFile, state);
  process.stdout.write(`dagrun: starting run ${runId}\n`);

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
      nightState = {
        ...nightState,
        nodes: {
          ...nightState.nodes,
          [gateNodeId]: {
            ...gateNodeState,
            status: "done",
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
        // Approve: mark done, continue.
        state = {
          ...state,
          nodes: {
            ...state.nodes,
            [gateNodeId]: {
              ...gateNodeState,
              status: "done",
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
        // Interactive gate UX — preview the primary produces artifact.
        const primaryProduces = gateNode?.produces?.[0] ?? "artifact";
        const artifactPath = join(artifactsDir, primaryProduces);
        if (existsSync(artifactPath)) {
          const preview = readFileSync(artifactPath, "utf8")
            .split("\n")
            .slice(0, 40)
            .join("\n");
          process.stdout.write(
            `\n--- ${gateNodeId} (iteration ${gateNodeState.iteration}/${maxIterations}) ---\n` +
              `${preview}\n---\n\n`,
          );
        }
        const skippable = gateNode?.gate?.skippable === true;
        const quitHint = skippable ? "[q]uit/skip" : "[q]uit";
        process.stdout.write(
          `[a]pprove  [r]eject <comment>  [s]how full  ${quitHint}\n> `,
        );
        const line = await readOneLine();
        if (line === "a" || line === "approve") {
          await resumeRun({ ...opts, approve: true });
          return;
        } else if (line.startsWith("r")) {
          const comment = line.slice(1).trim() || "rejected";
          await resumeRun({ ...opts, rejectComment: comment });
          return;
        } else if (line.startsWith("s")) {
          if (existsSync(artifactPath)) {
            process.stdout.write(readFileSync(artifactPath, "utf8") + "\n");
          }
          await resumeRun(opts);
          return;
        } else if (skippable) {
          // Skippable gate (e.g. reflect): quit marks node skipped, run continues done.
          state = {
            ...state,
            nodes: {
              ...state.nodes,
              [gateNodeId]: {
                ...gateNodeState,
                status: "skipped",
                endedAt: new Date().toISOString(),
                gateHistory: [
                  ...gateNodeState.gateHistory,
                  {
                    decision: "reject" as const,
                    comment: "skipped by user",
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
            `dagrun: ${gateNodeId} gate skipped — run will complete done (PR already shipped)\n`,
          );
          // Fall through: no gateEntry remaining, runDag resumes below.
        } else {
          process.stdout.write("dagrun: quit\n");
          releaseLock(homeDir);
          process.exit(0);
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

  // Create the draft PR.
  try {
    const url = execSync(
      `gh pr create --draft --title ${JSON.stringify(title)} --body-file "${bodyPath}" --base main`,
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
      `  Manual: cd "${worktreePath}" && gh pr create --draft --title ${JSON.stringify(title)} --body-file "${bodyPath}" --base main\n`,
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
    workProfileMcpServers: readWorkProfileMcpServers(homedir(), worktreePath),
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
    workProfileMcpServers: readWorkProfileMcpServers(homedir(), worktreePath),
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
