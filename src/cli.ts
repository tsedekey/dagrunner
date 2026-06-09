#!/usr/bin/env node
/**
 * dagrunner CLI entrypoint — Block 5 implementation.
 *
 * Only `init` is fully functional. All other commands are stubs that print
 * their message and exit 0. Block 7 wires the real engine.
 *
 * Arg parsing uses Node.js built-ins only (no external arg-parser).
 */

import {
  computeHomePath,
  initHome,
  resolveHome,
  resolveConfig,
} from "./xdg.js";
import { acquireLock, releaseLock } from "./lock.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Arg-parsing helpers
// ---------------------------------------------------------------------------

/** Return the value after `flag` in argv, or undefined if not present. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const val = argv[i + 1];
  return val;
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

function cmdStart(argv: string[]): void {
  // argv here is everything after "start"
  const workflow = argv[0];
  if (workflow === undefined || workflow.startsWith("--")) {
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
  const configFlag = flagValue(argv, "--config");

  // Resolve home (fails loud if missing).
  const homeDir = resolveHome();

  // Load config — fails loud if DEVHARNESS_SRC is blank.
  resolveConfig(homeDir, configFlag);

  // Acquire lock (fails if another run is active and !force).
  const runId = randomUUID().slice(0, 8);

  if (force) {
    // Force-override: release any stale lock first.
    releaseLock(homeDir);
  }

  acquireLock(homeDir, runId);

  process.stdout.write(`starting run ${runId}\n`);
  process.stdout.write(`start not yet wired to engine (Block 7)\n`);

  // maxBudgetStr used in Block 7.
  void maxBudgetStr;
}

function cmdResume(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined) {
    process.stderr.write(`dagrun resume: missing <run-id> argument.\n`);
    process.exit(1);
  }
  process.stdout.write(`resume not yet wired to engine (Block 7)\n`);
}

function cmdStatus(argv: string[]): void {
  void argv;
  process.stdout.write(`status not yet wired to engine (Block 7)\n`);
}

function cmdList(): void {
  process.stdout.write(`list not yet wired to engine (Block 7)\n`);
}

function cmdAbort(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined) {
    process.stderr.write(`dagrun abort: missing <run-id> argument.\n`);
    process.exit(1);
  }
  process.stdout.write(`abort not yet wired to engine (Block 7)\n`);
}

function cmdCleanup(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined) {
    process.stderr.write(`dagrun cleanup: missing <run-id> argument.\n`);
    process.exit(1);
  }
  process.stdout.write(`cleanup not yet wired to engine (Block 7)\n`);
}

function cmdReport(argv: string[]): void {
  const runId = argv[0];
  if (runId === undefined) {
    process.stderr.write(`dagrun report: missing <run-id> argument.\n`);
    process.exit(1);
  }
  process.stdout.write(`report not yet wired to engine (Block 7)\n`);
}

function cmdLogs(argv: string[]): void {
  const runId = argv[0];
  const node = argv[1];
  if (runId === undefined || node === undefined) {
    process.stderr.write(`dagrun logs: usage: dagrun logs <run-id> <node>\n`);
    process.exit(1);
  }
  process.stdout.write(`logs not yet wired to engine (Block 7)\n`);
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
      cmdStart(rest);
      return 0;

    case "resume":
      cmdResume(rest);
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
