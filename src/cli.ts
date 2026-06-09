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
} from "./xdg.js";
import { releaseLock } from "./lock.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { assertAuth } from "./launcher.js";
import { featureWorkflow } from "./feature-workflow.js";
import { startRun, resumeRun, listRuns } from "./run-engine.js";
import { readState, writeState } from "./state.js";

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

async function cmdStart(argv: string[]): Promise<void> {
  // argv here is everything after "start"
  const workflowName = argv[0];
  if (workflowName === undefined || workflowName.startsWith("--")) {
    process.stderr.write(
      `dagrun start: missing <workflow> argument.\n` +
        `Usage: dagrun start <workflow> --plan <file> [--max-budget-usd <n>] [--force]\n`,
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
  const maxBudgetStr = flagValue(argv, "--max-budget-usd");
  const maxBudgetUsd =
    maxBudgetStr !== undefined ? parseFloat(maxBudgetStr) : undefined;
  const configFlag = flagValue(argv, "--config");

  // Resolve home (fails loud if missing).
  const homeDir = resolveHome();

  // Load config — fails loud if DEVHARNESS_SRC is blank.
  const config = resolveConfig(homeDir, configFlag);

  // Auth check.
  assertAuth();

  // Resolve workflow by name.
  if (workflowName !== "feature") {
    process.stderr.write(
      `dagrun start: unknown workflow "${workflowName}". Available: feature\n`,
    );
    process.exit(1);
  }

  await startRun({
    workflow: featureWorkflow,
    planPath: planFile,
    homeDir,
    config,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(force ? { force: true } : {}),
  });
}

async function cmdResume(argv: string[]): Promise<void> {
  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(
      `dagrun resume: missing <run-id> argument.\n` +
        `Usage: dagrun resume <run-id> [--approve] [--reject "<comment>"]\n`,
    );
    process.exit(1);
  }

  const approve = hasFlag(argv, "--approve");
  const rejectComment = flagValue(argv, "--reject");
  const configFlag = flagValue(argv, "--config");

  const homeDir = resolveHome();
  const config = resolveConfig(homeDir, configFlag);
  assertAuth();

  await resumeRun({
    runId,
    homeDir,
    config,
    ...(approve ? { approve: true } : {}),
    ...(rejectComment !== undefined ? { rejectComment } : {}),
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
    process.stdout.write(
      `  ${nodeId.padEnd(20)} status=${ns.status.padEnd(14)} ` +
        `cost=$${ns.cost.toFixed(4)}  iter=${ns.iteration}  ` +
        `artifacts=${ns.artifacts.length}\n`,
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

function cmdAbort(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(`dagrun abort: missing <run-id> argument.\n`);
    process.exit(1);
  }

  const homeDir = resolveHome();
  const stateFile = join(homeDir, "runs", runId, "state.json");

  if (!existsSync(stateFile)) {
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
  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write(`dagrun cleanup: missing <run-id> argument.\n`);
    process.exit(1);
  }

  const homeDir = resolveHome();
  const stateFile = join(homeDir, "runs", runId, "state.json");

  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun: run "${runId}" not found at ${stateFile}\n`);
    process.exit(1);
  }

  const state = readState(stateFile);
  const worktreePath = state.worktreePath;

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
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

function cmdReport(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined) {
    process.stderr.write(`dagrun report: missing <run-id> argument.\n`);
    process.exit(1);
  }
  process.stdout.write(`report not yet wired to engine (Block 8)\n`);
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
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    [
      "dagrun — DAG runner for Claude Code agent pipelines",
      "",
      "Commands:",
      "  dagrun init [--home <path>]",
      "  dagrun start <workflow> --plan <file> [--max-budget-usd <n>] [--force]",
      '  dagrun resume <run-id> [--approve] [--reject "<comment>"]',
      "  dagrun status [<run-id>]",
      "  dagrun list",
      "  dagrun abort <run-id>",
      "  dagrun cleanup <run-id>",
      "  dagrun report <run-id>",
      "  dagrun logs <run-id> <node>",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
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

    case "report":
      cmdReport(rest);
      return 0;

    case "logs":
      cmdLogs(rest);
      return 0;

    default:
      process.stderr.write(
        `dagrun: unknown command "${command}". Run dagrun --help for usage.\n`,
      );
      return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
