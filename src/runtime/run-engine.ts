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
 * Build a deterministic run ID from a plan path and a timestamp.
 * Exported for unit testing.
 */
export function makeRunId(planPath: string, now: number): string {
  const slug = basename(planPath, ".md")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  return `${slug}-${now}`;
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
}): Promise<void> {
  const { workflow, planPath, homeDir, config, force } = opts;

  // Validate workflow at load time (hard rule: fail at load, not at runtime).
  loadWorkflow(workflow);

  const runId = makeRunId(planPath, Date.now());
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");
  const worktreePath = join(homeDir, "worktrees", runId);

  // Track for SIGINT diagnostic handler in cli.ts.
  activeRun.runDir = runDir;
  activeRun.homeDir = homeDir;

  // Lock BEFORE creating the worktree (advisor: avoid stray worktrees on failure).
  if (force === true) releaseLock(homeDir);
  acquireLock(homeDir, runId);

  // Create run directory and copy plan.
  mkdirSync(join(runDir, "plan"), { recursive: true });
  cpSync(planPath, join(runDir, "plan", "plan.md"));

  // Create git worktree from DEVHARNESS_SRC (must run in that repo's root).
  execSync(`git worktree add "${worktreePath}" -b "feature/${runId}"`, {
    cwd: config.DEVHARNESS_SRC,
    stdio: "inherit",
  });

  // Structural scratch backstop: seed .gitignore in the worktree so known
  // artifact filenames can never be staged or committed even if a prompt
  // accidentally writes to cwd instead of $DAGRUN_ARTIFACTS.
  seedWorktreeGitignore(worktreePath, worktreeArtifactPatterns());

  // Seed the worktree's .claude/ with dagrunner's bundled commands + hooks + a
  // node-run settings.json. Without this, a source repo with no .claude/commands/
  // causes /classify (and siblings) to return immediately with cost=0 and no
  // structured output — the SDK treats unknown slash commands as no-ops.
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
    branch: `feature/${runId}`,
    sourcePlanPath: planPath,
    nodes: makeInitialNodeStates(workflow),
  };

  writeState(stateFile, state);
  process.stdout.write(`dagrun: starting run ${runId}\n`);

  const executor = wrapWithPrScan(
    (opts.executorFactory ?? makeSDKRunner)(
      config,
      runId,
      runDir,
      worktreePath,
    ),
    worktreePath,
    runDir,
  );
  const ctx = makeCtx(runDir);
  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  runPrPostProcess(readState(stateFile), runDir);

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
    const maxIterations = gateNode?.gate?.maxIterations ?? 10;

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

  // Re-run the DAG engine with the (possibly updated) state.
  const executor = wrapWithPrScan(
    (opts.executorFactory ?? makeSDKRunner)(
      config,
      runId,
      runDir,
      state.worktreePath,
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
