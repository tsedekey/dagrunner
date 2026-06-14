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
import type { Workflow } from "./types.js";
import type { DagrunnerConfig } from "./xdg.js";
import { readState, writeState } from "./state.js";
import type { RunState, NodeState, NodeStatus } from "./state.js";
import type { ExecutionCtx } from "./mock-executor.js";
import { reconcileRunningNodes } from "./dag.js";
import { runDag } from "./dag.js";
import { acquireLock, releaseLock } from "./lock.js";
import { makeSDKRunner } from "./sdk-runner.js";
import { featureWorkflow } from "./feature-workflow.js";
import { loadWorkflow } from "./workflow.js";
import {
  readSourcePassthrough,
  readWorkProfileMcpServers,
  buildSeededSettings,
} from "./settings-seed.js";

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
}): Promise<void> {
  const { workflow, planPath, homeDir, config, force } = opts;

  // Validate workflow at load time (hard rule: fail at load, not at runtime).
  loadWorkflow(workflow);

  const slug = basename(planPath, ".md")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  const runId = `${slug}-${Date.now()}`;
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

  // Seed the worktree's .claude/ with dagrunner's bundled commands + hooks + a
  // node-run settings.json. Without this, a source repo with no .claude/commands/
  // causes /classify (and siblings) to return immediately with cost=0 and no
  // structured output — the SDK treats unknown slash commands as no-ops.
  const dagrunnerRoot = new URL("../", import.meta.url).pathname;
  const destClaude = join(worktreePath, ".claude");
  mkdirSync(join(destClaude, "commands"), { recursive: true });
  mkdirSync(join(destClaude, "hooks"), { recursive: true });
  mkdirSync(join(destClaude, "agents"), { recursive: true });
  const srcCommands = join(dagrunnerRoot, ".claude", "commands");
  const srcHooks = join(dagrunnerRoot, ".claude", "hooks");
  const srcAgents = join(dagrunnerRoot, ".claude", "agents");
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

  const executor = makeSDKRunner(config, runId, runDir, worktreePath);
  const ctx = makeCtx(runDir);
  const result = await runDag(workflow, executor, state, { ctx, stateFile });

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
  /** Non-interactive election answer: 'y' = run verify-guide, 'n' = skip. */
  verify?: "y" | "n";
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
  // failed by reconcileRunningNodes. Reset ALL such nodes to pending so
  // they are retried — not just optional ones. For optional nodes the risk
  // is silent skip cascade; for required nodes the risk is the run ending
  // as "failed" even though the node only stopped because of Ctrl+C.
  for (const [id, ns] of Object.entries(state.nodes)) {
    if (
      ns.status === "failed" &&
      ns.error === "process interrupted — reconciled on resume"
    ) {
      // Omit error/endedAt via destructuring — exactOptionalPropertyTypes
      // forbids explicit `undefined` on optional properties.
      const { error: _e, endedAt: _ea, ...nsRest } = ns;
      state = {
        ...state,
        nodes: {
          ...state.nodes,
          [id]: { ...nsRest, status: "pending" },
        },
        updatedAt: new Date().toISOString(),
      };
      process.stdout.write(
        `dagrun: node "${id}" was interrupted — resetting to pending for retry\n`,
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
  // Only applies when the workflow has a verify-guide node and election is not yet recorded.
  if (state.verifyElection === undefined) {
    const hasVerifySeed = workflow.nodes.some((n) => n.id === "verify-guide");
    const fixDone = state.nodes["fix"]?.status === "done";
    if (hasVerifySeed && fixDone) {
      let electionAnswer: "y" | "n";
      if (opts.verify !== undefined) {
        electionAnswer = opts.verify;
        process.stdout.write(
          `dagrun: verify-election = ${electionAnswer} (from --verify flag)\n`,
        );
      } else {
        process.stdout.write(
          "\nRun verify-guide (produces seeding spec + code tour, no cluster)? [y/n] > ",
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
        // Pre-mark verify-guide as skipped so the DAG routes directly to pr.
        const verifySeedNodeState = state.nodes["verify-guide"];
        if (verifySeedNodeState !== undefined) {
          state = {
            ...state,
            nodes: {
              ...state.nodes,
              "verify-guide": {
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
        process.stdout.write("dagrun: will run verify-guide + Gate 3\n");
      }

      writeState(stateFile, state);
    }
  }

  // Re-run the DAG engine with the (possibly updated) state.
  const executor = makeSDKRunner(config, runId, runDir, state.worktreePath);
  const ctx = makeCtx(runDir);
  const result = await runDag(workflow, executor, state, { ctx, stateFile });

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
  const dagrunnerRoot = new URL("../", import.meta.url).pathname;
  const destClaude = join(worktreePath, ".claude");
  const srcCommands = join(dagrunnerRoot, ".claude", "commands");
  const srcHooks = join(dagrunnerRoot, ".claude", "hooks");
  const srcAgents = join(dagrunnerRoot, ".claude", "agents");
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

  const executor = makeSDKRunner(config, runId, runDir, worktreePath);
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

  process.stdout.write(`dagrun: node "${nodeId}" rerun → ${newStatus}\n`);
  if (newStatus === "done" || newStatus === "awaiting-gate") {
    process.stdout.write(`  To continue: dagrun resume ${runId}\n`);
  }
}
