/**
 * detach.ts — `--detach`: re-run the SAME dagrun command (minus --detach) as a
 * detached child whose stdout/stderr go to <runDir>/driver.log, so a caller (an
 * agent) can return immediately and poll `dagrun status <run> --json`.
 *
 * The parent must never take the run lock or mutate the run; the child is a
 * normal driver and acquires the lock itself.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** argv with every occurrence of `flag` removed. */
export function withoutFlag(argv: string[], flag: string): string[] {
  return argv.filter((a) => a !== flag);
}

/** The exact command line that re-invokes this dagrun CLI with `cliArgs` (execArgv keeps `--import tsx` working). */
export function selfInvocation(cliArgs: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script === undefined) throw new Error("dagrun --detach: cannot determine the CLI entrypoint (process.argv[1])");
  return { command: process.execPath, args: [...process.execArgv, script, ...cliArgs] };
}

/**
 * Spawn `command args…` detached with stdio appended to `logPath`, unref it, and
 * return its pid. Throws (loud) if the process could not be spawned.
 */
export function spawnDetached(opts: {
  command: string;
  args: string[];
  logPath: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): number {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a");
  try {
    const child = spawn(opts.command, opts.args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: opts.env ?? process.env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    // Attach first: a failed spawn emits "error" asynchronously and must not crash the parent.
    child.on("error", () => {});
    if (child.pid === undefined) throw new Error(`dagrun --detach: failed to spawn ${opts.command}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}
