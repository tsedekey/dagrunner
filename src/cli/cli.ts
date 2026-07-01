#!/usr/bin/env node
/**
 * dagrunner CLI entrypoint.
 *
 * Block 7: all commands except `report` and `logs` are fully wired.
 * `report` (Block 8) and `logs` remain stubs.
 *
 * Arg parsing uses Node.js built-ins only (no external arg-parser).
 */

import {
  computeHomePath,
  initHome,
  resolveHome,
  resolveConfig,
} from "../config/xdg.js";
import { releaseLock, readLock } from "../core/lock.js";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendReflection } from "./reflect-append.js";
import { generateReport } from "./report.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { assertAuth } from "../runtime/launcher.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import {
  startRun,
  resumeRun,
  rerunNode,
  scaffoldRun,
  listRuns,
  activeRun,
  seedWorktreeSiblings,
} from "../runtime/run-engine.js";
import { readState, writeState } from "../core/state.js";
import {
  runPreflight,
  printPreflightResult,
  getAgentContext,
  formatAgentContext,
  writeAgentContextFile,
} from "./preflight.js";
import { getVersionInfo, formatVersionBanner } from "../config/version.js";

// ---------------------------------------------------------------------------
// Arg-parsing helpers
// ---------------------------------------------------------------------------

/** Return the value after `flag` in argv, or undefined if not present. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

/** Return true if `flag` is present in argv. */
function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function cmdInit(argv: string[]): void {
  const homeFlag = flagValue(argv, "--home");
  const homeDir = computeHomePath(homeFlag);
  initHome(homeDir);
  process.stdout.write(`dagrunner home initialized at ${homeDir}\n`);
}

async function cmdPreflight(argv: string[]): Promise<void> {
  const configFlag = flagValue(argv, "--config");
  const baseBranch = flagValue(argv, "--base-branch");
  const homeDir = resolveHome();
  const config = resolveConfig(homeDir, configFlag);

  const result = runPreflight(config, homeDir, {
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  });
  printPreflightResult(result);

  // Always show agent context so the user can verify what nodes will have access to.
  const dagrunnerRoot = new URL("../../", import.meta.url).pathname;
  const cacheDir = join(homedir(), ".cache", "dagrunner");
  const ctx = getAgentContext(dagrunnerRoot, config);
  const contextFile = writeAgentContextFile(
    ctx,
    config,
    dagrunnerRoot,
    cacheDir,
  );
  const versionInfo = getVersionInfo();
  process.stdout.write(
    formatAgentContext(ctx, contextFile, config, homeDir, versionInfo),
  );

  if (!result.ok) process.exit(1);
}

async function cmdStart(argv: string[]): Promise<void> {
  // argv here is everything after "start"
  const workflowName = argv[0];
  if (workflowName === undefined || workflowName.startsWith("--")) {
    process.stderr.write(
      `dagrun start: missing <workflow> argument.\n` +
        `Usage: dagrun start <workflow> --plan <file> [--max-budget-usd <n>] [--force] [--night]\n`,
    );
    process.exit(1);
  }

  const planFile = flagValue(argv, "--plan");
  if (planFile === undefined) {
    process.stderr.write(`dagrun start: --plan <file> is required.\n`);
    process.exit(1);
  }

  if (!existsSync(planFile)) {
    process.stderr.write(`dagrun start: plan file not found: "${planFile}"\n`);
    process.exit(1);
  }

  const force = hasFlag(argv, "--force");
  const nightMode = hasFlag(argv, "--night");
  const maxBudgetStr = flagValue(argv, "--max-budget-usd");
  const maxBudgetUsd =
    maxBudgetStr !== undefined ? parseFloat(maxBudgetStr) : undefined;
  const configFlag = flagValue(argv, "--config");

  // Resolve home (fails loud if missing).
  const homeDir = resolveHome();

  // Load config — fails loud if DEVHARNESS_SRC is blank.
  const config = resolveConfig(homeDir, configFlag);

  // Auth check — scoped to the configured Claude profile.
  assertAuth(config.claudeConfigDir);

  // Preflight checks — must pass before creating any worktrees.
  const preflight = runPreflight(config, homeDir);
  if (!preflight.ok) {
    printPreflightResult(preflight);
    process.exit(1);
  }

  // Visible before any node runs, even when the user skips standalone `dagrun preflight`.
  process.stdout.write(`${formatVersionBanner(getVersionInfo())}\n`);

  // Resolve workflow by name.
  if (workflowName !== "feature" && workflowName !== "bugfix") {
    process.stderr.write(
      `dagrun start: unknown workflow "${workflowName}". Available: feature, bugfix\n`,
    );
    process.exit(1);
  }

  const workflow = workflowName === "bugfix" ? bugfixWorkflow : featureWorkflow;

  await startRun({
    workflow,
    planPath: planFile,
    homeDir,
    config,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(force ? { force: true } : {}),
    ...(nightMode ? { nightMode: true } : {}),
  });
}

async function cmdResume(argv: string[]): Promise<void> {
  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(
      `dagrun resume: missing <run-id> argument.\n` +
        `Usage: dagrun resume <run-id> [--approve] [--reject "<comment>"] [--verify y|n]\n`,
    );
    process.exit(1);
  }

  const approve = hasFlag(argv, "--approve");
  const rejectComment = flagValue(argv, "--reject");
  const configFlag = flagValue(argv, "--config");
  const verifyRaw = flagValue(argv, "--verify");
  const verify = verifyRaw === "y" ? "y" : verifyRaw === "n" ? "n" : undefined;

  const homeDir = resolveHome();
  const config = resolveConfig(homeDir, configFlag);
  assertAuth(config.claudeConfigDir);

  await resumeRun({
    runId,
    homeDir,
    config,
    ...(approve ? { approve: true } : {}),
    ...(rejectComment !== undefined ? { rejectComment } : {}),
    ...(verify !== undefined ? { verify } : {}),
  });
}

function cmdStatus(argv: string[]): void {
  const homeDir = resolveHome();

  // Determine which run to show.
  let runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    // No run-id given: use most recent.
    const runs = listRuns(homeDir);
    if (runs.length === 0) {
      process.stdout.write("dagrun: no runs found\n");
      return;
    }
    runId = runs[0]?.runId;
    if (runId === undefined) {
      process.stdout.write("dagrun: no runs found\n");
      return;
    }
  }

  const stateFile = join(homeDir, "runs", runId, "state.json");
  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun: run "${runId}" not found at ${stateFile}\n`);
    process.exit(1);
  }

  const state = readState(stateFile);

  process.stdout.write(
    `Run:        ${state.runId}\n` +
      `Workflow:   ${state.workflow}\n` +
      `Status:     ${state.status}\n` +
      `Created:    ${state.createdAt}\n` +
      `Updated:    ${state.updatedAt}\n` +
      `Worktree:   ${state.worktreePath}\n` +
      `Branch:     ${state.branch}\n` +
      `\nNodes:\n`,
  );

  let totalCost = 0;
  for (const [nodeId, ns] of Object.entries(state.nodes)) {
    totalCost += ns.cost;
    const artifactLink =
      ns.artifacts.length > 0 ? `  artifact=file://${ns.artifacts[0]}` : "";
    process.stdout.write(
      `  ${nodeId.padEnd(20)} status=${ns.status.padEnd(14)} ` +
        `cost=$${ns.cost.toFixed(4)}  iter=${ns.iteration}` +
        `${artifactLink}\n`,
    );
  }

  process.stdout.write(`\nTotal cost: $${totalCost.toFixed(4)}\n`);

  const gateNode = Object.entries(state.nodes).find(
    ([, ns]) => ns.status === "awaiting-gate",
  );
  if (gateNode !== undefined) {
    process.stdout.write(
      `\nAwaiting gate: ${gateNode[0]} (iteration ${gateNode[1].iteration})\n` +
        `  Resume with: dagrun resume ${state.runId}\n`,
    );
  }
}

function cmdList(): void {
  const homeDir = resolveHome();
  const runs = listRuns(homeDir);

  if (runs.length === 0) {
    process.stdout.write("dagrun: no runs found\n");
    return;
  }

  // Header
  process.stdout.write(
    `${"RUN ID".padEnd(36)}  ${"STATUS".padEnd(10)}  UPDATED\n`,
  );
  process.stdout.write(
    `${"-".repeat(36)}  ${"-".repeat(10)}  ${"-".repeat(24)}\n`,
  );

  for (const run of runs) {
    process.stdout.write(
      `${run.runId.padEnd(36)}  ${run.status.padEnd(10)}  ${run.updatedAt}\n`,
    );
  }
}

async function cmdRerun(argv: string[]): Promise<void> {
  const runId = argv[0];
  const nodeId = argv[1];
  if (
    runId === undefined ||
    runId.startsWith("--") ||
    nodeId === undefined ||
    nodeId.startsWith("--")
  ) {
    process.stderr.write(
      "dagrun rerun: usage: dagrun rerun <run-id> <node-id>\n",
    );
    process.exit(1);
  }
  const homeDir = resolveHome();
  const config = resolveConfig(homeDir);
  assertAuth(config.claudeConfigDir);
  await rerunNode({ runId, nodeId, homeDir, config });
}

function cmdAbort(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(`dagrun abort: missing <run-id> argument.\n`);
    process.exit(1);
  }

  const homeDir = resolveHome();
  const stateFile = join(homeDir, "runs", runId, "state.json");

  if (!existsSync(stateFile)) {
    // Run dir was manually deleted — if the lock still names this run, release it.
    const lock = readLock(homeDir);
    if (lock !== null && lock.runId === runId) {
      releaseLock(homeDir);
      process.stdout.write(
        `dagrun: run directory for "${runId}" not found — released stale lock.\n`,
      );
      return;
    }
    process.stderr.write(`dagrun: run "${runId}" not found at ${stateFile}\n`);
    process.exit(1);
  }

  const state = readState(stateFile);
  writeState(stateFile, {
    ...state,
    status: "aborted",
    updatedAt: new Date().toISOString(),
  });
  releaseLock(homeDir);
  process.stdout.write(`dagrun: aborted ${runId}\n`);
}

function cmdCleanup(argv: string[]): void {
  const configFlag = flagValue(argv, "--config");
  const homeDir = resolveHome();
  const config = resolveConfig(homeDir, configFlag);

  if (hasFlag(argv, "--all")) {
    const worktreeRoot = config.worktreeRoot ?? join(homeDir, "worktrees");
    const dirs = existsSync(worktreeRoot) ? readdirSync(worktreeRoot) : [];
    if (dirs.length === 0) {
      process.stdout.write("dagrun: no worktrees to clean up\n");
      return;
    }
    let removed = 0;
    for (const d of dirs) {
      const wt = join(worktreeRoot, d);
      try {
        execSync(`git worktree remove "${wt}" --force`, {
          cwd: config.DEVHARNESS_SRC,
          stdio: "inherit",
        });
        removed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `dagrun cleanup: failed to remove ${wt}: ${msg}\n`,
        );
      }
    }
    releaseLock(homeDir);
    process.stdout.write(`dagrun: removed ${removed} worktree(s)\n`);
    return;
  }

  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(
      `dagrun cleanup: missing <run-id> argument.\n` +
        `Usage: dagrun cleanup <run-id>\n` +
        `       dagrun cleanup --all\n`,
    );
    process.exit(1);
  }

  const stateFile = join(homeDir, "runs", runId, "state.json");

  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun: run "${runId}" not found at ${stateFile}\n`);
    process.exit(1);
  }

  const state = readState(stateFile);
  const worktreePath = state.worktreePath;

  try {
    // Must run in the source repo so git can find the worktree registration.
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: config.DEVHARNESS_SRC,
      stdio: "inherit",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `dagrun cleanup: git worktree remove failed: ${msg}\n`,
    );
    // Continue — don't block lock release on git failure.
  }

  releaseLock(homeDir);
  process.stdout.write(`dagrun: cleaned up ${runId}\n`);
}

function cmdClear(argv: string[]): void {
  const homeDir = resolveHome();
  const runsDir = join(homeDir, "runs");

  if (hasFlag(argv, "--all")) {
    const yes = hasFlag(argv, "--yes");
    const runDirs = existsSync(runsDir) ? readdirSync(runsDir) : [];
    if (runDirs.length === 0) {
      process.stdout.write("dagrun: no runs to clear\n");
      return;
    }
    if (!yes) {
      process.stderr.write(
        `dagrun clear --all: will delete ${runDirs.length} run(s):\n` +
          runDirs.map((d) => `  ${d}`).join("\n") +
          `\nAdd --yes to confirm.\n`,
      );
      process.exit(1);
    }
    for (const d of runDirs) {
      rmSync(join(runsDir, d), { recursive: true, force: true });
      process.stdout.write(`dagrun: cleared ${d}\n`);
    }
    releaseLock(homeDir);
    process.stdout.write(`dagrun: all runs cleared\n`);
    return;
  }

  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(
      `dagrun clear: missing <run-id> argument.\n` +
        `Usage: dagrun clear <run-id>\n` +
        `       dagrun clear --all [--yes]\n`,
    );
    process.exit(1);
  }

  const runDir = join(runsDir, runId);
  if (!existsSync(runDir)) {
    process.stderr.write(`dagrun: run "${runId}" not found at ${runDir}\n`);
    process.exit(1);
  }

  rmSync(runDir, { recursive: true, force: true });

  // Release lock if this run held it.
  const lock = readLock(homeDir);
  if (lock !== null && lock.runId === runId) {
    releaseLock(homeDir);
  }

  process.stdout.write(`dagrun: cleared run ${runId}\n`);
}

function cmdReflect(argv: string[]): void {
  const source = flagValue(argv, "--source");
  const kind = flagValue(argv, "--kind");
  const body = flagValue(argv, "--body");
  const runId = flagValue(argv, "--run-id");

  if (source === undefined || kind === undefined || body === undefined) {
    process.stderr.write(
      `dagrun reflect: --source, --kind, and --body are required.\n` +
        `Usage: dagrun reflect --source <node> --kind camunda-knowledge|dagrunner-harness --body "<text>" [--run-id <id>]\n`,
    );
    // Exit 0 — capture is best-effort; caller must not fail because of this.
    return;
  }

  if (kind !== "camunda-knowledge" && kind !== "dagrunner-harness") {
    process.stderr.write(
      `dagrun reflect: --kind must be camunda-knowledge or dagrunner-harness, got "${kind}"\n`,
    );
    return;
  }

  const homeDir = resolveHome();
  appendReflection(homeDir, {
    source,
    kind,
    body,
    ...(runId !== undefined ? { run_id: runId } : {}),
  });
}

function cmdReport(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined) {
    process.stderr.write(`dagrun: report requires <run-id>\n`);
    process.exit(1);
  }
  const homeDir = resolveHome();
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun: run "${runId}" not found\n`);
    process.exit(1);
  }
  const state = readState(stateFile);
  const frictionFile = join(runDir, "friction.jsonl");
  const frictionLines = existsSync(frictionFile)
    ? readFileSync(frictionFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const html = generateReport(state, frictionLines);
  const outPath = join(runDir, "report.html");
  writeFileSync(outPath, html, "utf8");
  process.stdout.write(`dagrun: report written to ${outPath}\n`);
}

function cmdLogs(argv: string[]): void {
  const runId = argv[0];
  const node = argv[1];
  if (runId === undefined || node === undefined) {
    process.stderr.write(`dagrun logs: usage: dagrun logs <run-id> <node>\n`);
    process.exit(1);
  }
  // Fallback: dump the artifacts dir for the node.
  const homeDir = resolveHome();
  const artifactsDir = join(homeDir, "runs", runId, node);
  if (!existsSync(artifactsDir)) {
    process.stdout.write(
      `dagrun: no artifacts found for node "${node}" in run "${runId}"\n`,
    );
    return;
  }
  const files = readdirSync(artifactsDir);
  for (const f of files) {
    process.stdout.write(
      `--- ${f} ---\n${readFileSync(join(artifactsDir, f), "utf8")}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Diagnostic dump — called by the SIGINT handler
// ---------------------------------------------------------------------------

function writeDiagnostic(runDir: string): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(runDir, `diagnostic-${ts}.md`);

  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) {
    process.stderr.write(
      "dagrun: no state.json found — cannot write diagnostic\n",
    );
    return;
  }

  const state = readState(stateFile);

  const activeNodes = Object.entries(state.nodes).filter(
    ([, ns]) => ns.status === "running" || ns.status === "pending",
  );

  const lines: string[] = [
    `# dagrun Diagnostic Report`,
    ``,
    `**Run:** ${state.runId}`,
    `**Interrupted:** ${new Date().toISOString()}`,
    ``,
    `## Active Nodes at Interrupt`,
  ];

  if (activeNodes.length === 0) {
    lines.push("(none running)");
  } else {
    for (const [id, ns] of activeNodes) {
      lines.push(`- **${id}** (${ns.status})`);
      if (ns.error !== undefined) lines.push(`  error: ${ns.error}`);
    }
  }

  lines.push(
    ``,
    `## Run State`,
    ``,
    "```json",
    JSON.stringify(state, null, 2),
    "```",
  );

  lines.push(``, `## Artifact Files`);

  const logPaths: string[] = [];

  for (const nodeId of Object.keys(state.nodes)) {
    const artifactsDir = join(runDir, nodeId);
    if (!existsSync(artifactsDir)) continue;
    lines.push(``, `### ${nodeId}/`);
    try {
      const files = readdirSync(artifactsDir);
      for (const f of files) {
        const fp = join(artifactsDir, f);
        try {
          const st = statSync(fp);
          lines.push(`- ${f} (${st.size} bytes)`);
          if (f.endsWith(".log") || f === "transcript.log") logPaths.push(fp);
        } catch {
          lines.push(`- ${f}`);
        }
      }
    } catch {
      lines.push("(unreadable)");
    }
  }

  if (logPaths.length > 0) {
    lines.push(``, `## Log Tails (last 100 lines each)`);
    for (const logPath of logPaths) {
      const rel = logPath.slice(runDir.length + 1);
      lines.push(``, `### ${rel}`, "```");
      try {
        const tail = readFileSync(logPath, "utf8")
          .split("\n")
          .slice(-100)
          .join("\n");
        lines.push(tail);
      } catch {
        lines.push("(unreadable)");
      }
      lines.push("```");
    }
  }

  lines.push(``, `---`, `*Report: ${reportPath}*`);

  writeFileSync(reportPath, lines.join("\n"), "utf8");
  process.stderr.write(`\ndagrun: diagnostic → ${reportPath}\n`);
}

function cmdSeed(argv: string[]): void {
  const repoPath = argv[0];
  if (repoPath === undefined || repoPath.startsWith("--")) {
    process.stderr.write(
      `dagrun seed: missing <repo-path> argument.\n` +
        `Usage: dagrun seed <repo-path>\n`,
    );
    process.exit(1);
  }

  if (!existsSync(repoPath)) {
    process.stderr.write(`dagrun seed: repo path not found: "${repoPath}"\n`);
    process.exit(1);
  }

  const dagrunnerRoot = new URL("../../", import.meta.url).pathname;
  const destClaude = join(repoPath, ".claude");
  seedWorktreeSiblings(dagrunnerRoot, destClaude);
  process.stdout.write(`dagrun: seeded sibling commands into ${destClaude}\n`);
}

async function cmdScaffold(argv: string[]): Promise<void> {
  const nodeId = argv[0];
  const branch = flagValue(argv, "--branch");
  const mocksDir = flagValue(argv, "--mocks");
  if (!nodeId || nodeId.startsWith("--") || !branch) {
    process.stderr.write(
      "Usage: dagrun scaffold <node-id> --branch <feature-branch> [--mocks <dir>]\n",
    );
    process.exit(1);
  }
  const homeDir = resolveHome();
  const config = resolveConfig(homeDir);
  await scaffoldRun({
    nodeId,
    homeDir,
    config,
    branch,
    ...(mocksDir !== undefined ? { mocksDir } : {}),
  });
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    [
      "dagrun — DAG runner for Claude Code agent pipelines",
      "",
      "Commands:",
      "  dagrun init [--home <path>]",
      "  dagrun preflight [--base-branch <branch>] [--config <file>]",
      "  dagrun start <workflow> --plan <file> [--max-budget-usd <n>] [--force] [--night]",
      '  dagrun resume <run-id> [--approve] [--reject "<comment>"] [--verify y|n]',
      "  dagrun status [<run-id>]",
      "  dagrun list",
      "  dagrun abort <run-id>",
      "  dagrun cleanup <run-id>",
      "  dagrun cleanup --all",
      "  dagrun clear <run-id>",
      "  dagrun clear --all [--yes]",
      "  dagrun report <run-id>",
      "  dagrun logs <run-id> <node>",
      "  dagrun rerun <run-id> <node-id>",
      "  dagrun scaffold <node-id> --branch <feature-branch> [--mocks <dir>]",
      "  dagrun seed <repo-path>",
      '  dagrun reflect --source <node> --kind camunda-knowledge|dagrunner-harness --body "<text>" [--run-id <id>]',
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  // SIGINT handler: write diagnostic before exiting so the user has a record
  // of what the active node was doing and why it may have failed.
  process.on("SIGINT", () => {
    if (activeRun.runDir !== undefined) {
      writeDiagnostic(activeRun.runDir);
    }
    if (activeRun.homeDir !== undefined) {
      try {
        releaseLock(activeRun.homeDir);
      } catch {
        // Ignore — lock may already be gone.
      }
    }
    process.exit(130);
  });

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  switch (command) {
    case "init":
      cmdInit(rest);
      return 0;

    case "preflight":
      await cmdPreflight(rest);
      return 0;

    case "start":
      await cmdStart(rest);
      return 0;

    case "resume":
      await cmdResume(rest);
      return 0;

    case "status":
      cmdStatus(rest);
      return 0;

    case "list":
      cmdList();
      return 0;

    case "abort":
      cmdAbort(rest);
      return 0;

    case "cleanup":
      cmdCleanup(rest);
      return 0;

    case "clear":
      cmdClear(rest);
      return 0;

    case "rerun":
      await cmdRerun(rest);
      return 0;

    case "scaffold":
      await cmdScaffold(rest);
      return 0;

    case "seed":
      cmdSeed(rest);
      return 0;

    case "report":
      cmdReport(rest);
      return 0;

    case "logs":
      cmdLogs(rest);
      return 0;

    case "reflect":
      cmdReflect(rest);
      return 0;

    default:
      process.stderr.write(
        `dagrun: unknown command "${command}". Run dagrun --help for usage.\n`,
      );
      return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
