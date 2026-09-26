/**
 * verify-cli.ts — `dagrun verify cleanup <run-id>`: the deterministic teardown of
 * a run's provisioned verify environment (see core/verify-cleanup.ts). Also the
 * retry path when the automatic teardown at the human's gate decision left
 * leftovers. Exit 0 only when everything owned is gone and the worktree still
 * matches the recorded dirtyFiles.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readState } from "../core/state.js";
import { formatTeardown, teardownRun, type DockerExec } from "../core/verify-cleanup.js";

export function verifyCleanup(args: { homeDir: string; runId: string; exec?: DockerExec }): number {
  const runDir = join(args.homeDir, "runs", args.runId);
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) {
    process.stderr.write(`dagrun verify cleanup: run "${args.runId}" not found\n`);
    return 1;
  }
  const state = readState(stateFile);
  const r = teardownRun({
    runDir,
    runId: args.runId,
    worktreePath: state.worktreePath,
    trigger: "cli:verify-cleanup",
    all: true,
    ...(args.exec !== undefined ? { exec: args.exec } : {}),
  });
  const text = formatTeardown(r.reports);
  (r.ok ? process.stdout : process.stderr).write(text);
  return r.ok ? 0 : 1;
}
