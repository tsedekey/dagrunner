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
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import type { Workflow } from "./types.js";
import type { DagrunnerConfig } from "./xdg.js";
import { readState, writeState } from "./state.js";
import type { RunState, NodeState } from "./state.js";
import { reconcileRunningNodes } from "./dag.js";
import { runDag } from "./dag.js";
import { acquireLock, releaseLock } from "./lock.js";
import { makeSDKRunner } from "./sdk-runner.js";
import { featureWorkflow } from "./feature-workflow.js";
import { loadWorkflow } from "./workflow.js";

// ---------------------------------------------------------------------------
// Ctx builder
// ---------------------------------------------------------------------------

function makeCtx(runDir: string) {
  return {
    json: (nodeId: string): unknown =>
      JSON.parse(
        readFileSync(join(runDir, nodeId, "classify.json"), "utf8"),
      ) as unknown,
    read: (nodeId: string, file: string): string =>
      readFileSync(join(runDir, nodeId, file), "utf8"),
    dir: (nodeId: string): string => join(runDir, nodeId),
  };
}

// ---------------------------------------------------------------------------
// Initial node state factory
// ---------------------------------------------------------------------------

function makeInitialNodeStates(workflow: Workflow): Record<string, NodeState> {
  const nodes: Record<string, NodeState> = {};
  for (const node of workflow.nodes) {
    nodes[node.id] = {
      status: "pending",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
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
  // additionalDirectories includes runDir so all node artifact subdirs are
  // accessible without prompting (artifacts live outside the worktree).
  writeFileSync(
    join(destClaude, "settings.json"),
    JSON.stringify(
      {
        permissions: {
          defaultMode: "acceptEdits",
          additionalDirectories: [runDir],
          allow: [
            "Read",
            "Bash(git *)",
            "Bash(npm run *)",
            "Bash(npm test *)",
            "Bash(npm ci *)",
            "Bash(npx tsc *)",
            "Bash(npx prettier *)",
            "Bash(./mvnw *)",
          ],
          deny: [
            "Bash(rm -rf *)",
            "Bash(sudo *)",
            "Bash(git push --force *)",
            "Bash(git push * --force)",
            "Read(**/.env)",
            "Read(**/.env.*)",
            "Read(**/secrets/**)",
            "Write(**/.env*)",
          ],
        },
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          network: {
            allowedDomains: [
              "api.anthropic.com",
              "registry.npmjs.org",
              "*.npmjs.org",
              "github.com",
              "*.githubusercontent.com",
            ],
          },
        },
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh",
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-verifier.sh",
                },
                {
                  type: "command",
                  command: "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-schema.sh",
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Write|Edit|MultiEdit",
              hooks: [
                {
                  type: "command",
                  command:
                    "$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use-format.sh",
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: "$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.sh",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
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
}): Promise<void> {
  const { runId, homeDir, config } = opts;
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");

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
      process.stdout.write(
        `[a]pprove  [r]eject <comment>  [s]how full  [q]uit\n> `,
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
      } else {
        process.stdout.write("dagrun: quit\n");
        releaseLock(homeDir);
        process.exit(0);
      }
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
