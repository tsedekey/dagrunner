/**
 * launcher.ts — env-propagation + per-node env setup.
 *
 * The env-propagation contract (CLAUDE.md):
 *   DEVHARNESS_SRC, DAGRUN_ARTIFACTS, DAGRUN_RUN_ID, DAGRUN_WORKTREE MUST be
 *   set on process.env BEFORE any SDK query() is spawned. A var set after spawn,
 *   or only inside a prompt, is invisible to the SessionStart sync and artifact
 *   writes.
 *
 * Block 7 calls applyNodeEnv(buildNodeEnv(...)) per node before spawning query().
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import type { DagrunnerConfig } from "./xdg.js";

// ---------------------------------------------------------------------------
// NodeLaunchEnv
// ---------------------------------------------------------------------------

export type NodeLaunchEnv = {
  DEVHARNESS_SRC: string;
  DAGRUN_RUN_ID: string;
  /** Absolute path to <runDir>/<nodeId>/ */
  DAGRUN_ARTIFACTS: string;
  DAGRUN_WORKTREE: string;
  /** The current node's id — used by stop-schema.sh and session-end.sh */
  DAGRUN_NODE_ID: string;
  /** Absolute path to the run directory (runs/<run-id>/) — used by session-end.sh */
  DAGRUN_RUN_DIR: string;
};

// ---------------------------------------------------------------------------
// buildNodeEnv
// ---------------------------------------------------------------------------

/**
 * Compute the per-node env vars to be exported before spawning query().
 *
 * Returns the env object — does NOT mutate process.env.
 * Caller must call applyNodeEnv(env) before spawning the SDK query().
 */
export function buildNodeEnv(
  config: DagrunnerConfig,
  runId: string,
  nodeId: string,
  runDir: string,
  worktreePath: string,
): NodeLaunchEnv {
  return {
    DEVHARNESS_SRC: config.DEVHARNESS_SRC,
    DAGRUN_RUN_ID: runId,
    DAGRUN_ARTIFACTS: join(runDir, nodeId),
    DAGRUN_WORKTREE: worktreePath,
    DAGRUN_NODE_ID: nodeId,
    DAGRUN_RUN_DIR: runDir,
  };
}

// ---------------------------------------------------------------------------
// applyNodeEnv
// ---------------------------------------------------------------------------

/**
 * Set the per-node env vars on process.env.
 * MUST be called before spawning SDK query() so hooks and child processes
 * inherit the correct values.
 */
export function applyNodeEnv(env: NodeLaunchEnv): void {
  process.env["DEVHARNESS_SRC"] = env.DEVHARNESS_SRC;
  process.env["DAGRUN_RUN_ID"] = env.DAGRUN_RUN_ID;
  process.env["DAGRUN_ARTIFACTS"] = env.DAGRUN_ARTIFACTS;
  process.env["DAGRUN_WORKTREE"] = env.DAGRUN_WORKTREE;
  process.env["DAGRUN_NODE_ID"] = env.DAGRUN_NODE_ID;
  process.env["DAGRUN_RUN_DIR"] = env.DAGRUN_RUN_DIR;
}

// ---------------------------------------------------------------------------
// assertAuth
// ---------------------------------------------------------------------------

/**
 * Assert that at least one Anthropic auth credential is present in env.
 * Fails loud if neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set.
 * Never logs the key value — only checks presence.
 */
export function assertAuth(): void {
  const hasKey =
    typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
    process.env["ANTHROPIC_API_KEY"] !== "";
  const hasToken =
    typeof process.env["ANTHROPIC_AUTH_TOKEN"] === "string" &&
    process.env["ANTHROPIC_AUTH_TOKEN"] !== "";

  if (hasKey || hasToken) return;

  // Accept claude.ai subscription auth (the SDK's claude binary uses its own session)
  try {
    const out = execSync("claude auth status 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
    });
    if (out.includes('"loggedIn": true') || out.includes('"loggedIn":true'))
      return;
  } catch {
    // claude not found or not logged in — fall through to hard fail
  }

  process.stderr.write(
    `dagrun: authentication required: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or run \`claude login\`.\n`,
  );
  process.exit(1);
}
