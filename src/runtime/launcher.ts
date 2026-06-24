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
import type { DagrunnerConfig } from "../config/xdg.js";

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
  /** Absolute path to the durable store dir (<homeDir>/store/) — used by session-end.sh to write reflection-log.jsonl */
  DAGRUN_STORE_DIR: string;
  /** Format command to run before git commit; absent means no-op. */
  DAGRUN_FORMAT_CMD?: string;
  /**
   * Conventional Commits type prefix for the PR title: e.g. "feat:", "fix:".
   * Set by run-engine (startRun/resumeRun/rerunNode) on process.env directly
   * so all spawned node sessions inherit it. Not populated by buildNodeEnv.
   */
  DAGRUN_PR_TITLE_PREFIX?: string;
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
  storeDir: string,
  formatCommand?: string,
): NodeLaunchEnv {
  return {
    DEVHARNESS_SRC: config.DEVHARNESS_SRC,
    DAGRUN_RUN_ID: runId,
    DAGRUN_ARTIFACTS: join(runDir, nodeId),
    DAGRUN_WORKTREE: worktreePath,
    DAGRUN_NODE_ID: nodeId,
    DAGRUN_RUN_DIR: runDir,
    DAGRUN_STORE_DIR: storeDir,
    ...(formatCommand !== undefined
      ? { DAGRUN_FORMAT_CMD: formatCommand }
      : {}),
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
  process.env["DAGRUN_STORE_DIR"] = env.DAGRUN_STORE_DIR;
  if (env.DAGRUN_FORMAT_CMD !== undefined) {
    process.env["DAGRUN_FORMAT_CMD"] = env.DAGRUN_FORMAT_CMD;
  }
}

// ---------------------------------------------------------------------------
// assertAuth
// ---------------------------------------------------------------------------

/**
 * Assert that the configured Claude profile is authenticated.
 *
 * Checks in order:
 *   1. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN env vars (API key auth)
 *   2. `claude auth status` scoped to claudeConfigDir (subscription auth)
 *
 * If not authenticated, prints the exact command to run in a terminal to log
 * in and exits 1.
 */
export function assertAuth(claudeConfigDir?: string): void {
  const hasKey =
    typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
    process.env["ANTHROPIC_API_KEY"] !== "";
  const hasToken =
    typeof process.env["ANTHROPIC_AUTH_TOKEN"] === "string" &&
    process.env["ANTHROPIC_AUTH_TOKEN"] !== "";

  if (hasKey || hasToken) return;

  // Check subscription auth scoped to the configured Claude profile directory.
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (claudeConfigDir !== undefined && claudeConfigDir !== "") {
      env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
    }
    const out = execSync("claude auth status 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
      env,
    });
    if (out.includes('"loggedIn": true') || out.includes('"loggedIn":true'))
      return;
  } catch {
    // claude not found or not logged in — fall through to hard fail
  }

  const configDirNote =
    claudeConfigDir !== undefined && claudeConfigDir !== ""
      ? `  Claude config: ${claudeConfigDir}\n`
      : "";
  const loginCmd =
    claudeConfigDir !== undefined && claudeConfigDir !== ""
      ? `CLAUDE_CONFIG_DIR=${claudeConfigDir} claude auth login`
      : "claude auth login";

  process.stderr.write(
    `dagrun: not logged in to Claude.\n` +
      configDirNote +
      `  Run in your terminal:\n` +
      `    ${loginCmd}\n`,
  );
  process.exit(1);
}
