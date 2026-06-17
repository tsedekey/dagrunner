/**
 * xdg.ts — XDG home layout + config resolution for dagrunner.
 *
 * Design decision (see DECISIONS.md block5):
 *   `resolveHome()` is exported for non-init commands and FAILS LOUD if the
 *   resolved path does not exist. `init` must NOT call resolveHome() — it calls
 *   the internal `computeHomePath()` which returns the path without an existence
 *   check, then creates it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export type DagrunnerConfig = {
  /** Absolute path to the main checkout. Mandatory — user must fill in. */
  DEVHARNESS_SRC: string;
  /**
   * Which Claude config directory agent sessions use (CLAUDE_CONFIG_DIR).
   * ~/.claude = personal, ~/.claude-work = work. Defaults to ~/.claude if unset.
   */
  claudeConfigDir?: string;
  maxBudgetUsd?: number;
  maxParallel?: number;
  /** Root directory for worktrees. Default: <DAGRUNNER_HOME>/worktrees */
  worktreeRoot?: string;
};

// ---------------------------------------------------------------------------
// Internal: path computation (no existence check)
// ---------------------------------------------------------------------------

/**
 * Compute the home path from optional flag, env, or XDG default.
 * NEVER checks existence — callers that need existence use resolveHome().
 */
export function computeHomePath(homeFlag?: string): string {
  if (homeFlag !== undefined && homeFlag !== "") {
    return homeFlag;
  }
  const envHome = process.env["DAGRUNNER_HOME"];
  if (envHome !== undefined && envHome !== "") {
    return envHome;
  }
  return join(homedir(), ".local", "share", "dagrunner");
}

// ---------------------------------------------------------------------------
// resolveHome — exported, fails loud if path doesn't exist
// ---------------------------------------------------------------------------

/**
 * Resolve the dagrunner home directory.
 *
 * Resolution order: DAGRUNNER_HOME env → ~/.local/share/dagrunner
 *
 * Fails loud with exact paths checked if:
 *   - DAGRUNNER_HOME is set but the directory doesn't exist
 *   - neither DAGRUNNER_HOME nor the XDG default exists
 *
 * Do NOT call from `init` — use computeHomePath() + initHome() instead.
 */
export function resolveHome(): string {
  const envHome = process.env["DAGRUNNER_HOME"];
  const xdgDefault = join(homedir(), ".local", "share", "dagrunner");

  if (envHome !== undefined && envHome !== "") {
    if (!existsSync(envHome)) {
      process.stderr.write(
        `dagrun: DAGRUNNER_HOME is set to "${envHome}" but the directory does not exist.\n`,
      );
      process.exit(1);
    }
    return envHome;
  }

  if (!existsSync(xdgDefault)) {
    process.stderr.write(
      `dagrun: dagrunner home not found.\n` +
        `  Checked: DAGRUNNER_HOME (not set)\n` +
        `  Checked: ${xdgDefault} (does not exist)\n` +
        `  Run: dagrun init\n`,
    );
    process.exit(1);
  }

  return xdgDefault;
}

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

/**
 * Load and validate machine config.
 *
 * Resolution order: configFlag → <homeDir>/config.json
 *
 * Fails loud if:
 *   - config file does not exist
 *   - DEVHARNESS_SRC is blank or missing
 */
export function resolveConfig(
  homeDir: string,
  configFlag?: string,
): DagrunnerConfig {
  const configPath =
    configFlag !== undefined && configFlag !== ""
      ? configFlag
      : join(homeDir, "config.json");

  if (!existsSync(configPath)) {
    process.stderr.write(
      `dagrun: config not found at "${configPath}" — run \`dagrun init\` first.\n`,
    );
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `dagrun: failed to parse config at "${configPath}": ${message}\n`,
    );
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null) {
    process.stderr.write(
      `dagrun: config at "${configPath}" is not a JSON object.\n`,
    );
    process.exit(1);
  }

  const raw = parsed as Record<string, unknown>;

  // DEVHARNESS_SRC is mandatory — fail loud if blank or missing.
  const src = raw["DEVHARNESS_SRC"];
  if (typeof src !== "string" || src.trim() === "") {
    process.stderr.write(
      `dagrun: DEVHARNESS_SRC is not set in "${configPath}" — edit the config file.\n`,
    );
    process.exit(1);
  }

  const config: DagrunnerConfig = { DEVHARNESS_SRC: src };

  const maxBudgetUsd = raw["maxBudgetUsd"];
  if (typeof maxBudgetUsd === "number") {
    config.maxBudgetUsd = maxBudgetUsd;
  }

  const maxParallel = raw["maxParallel"];
  if (typeof maxParallel === "number") {
    config.maxParallel = maxParallel;
  }

  const claudeConfigDir = raw["claudeConfigDir"];
  if (typeof claudeConfigDir === "string" && claudeConfigDir.trim() !== "") {
    // Expand leading ~/ — shell expansion doesn't apply to Node env assignments.
    config.claudeConfigDir = claudeConfigDir.startsWith("~/")
      ? join(homedir(), claudeConfigDir.slice(2))
      : claudeConfigDir;
  }

  const worktreeRoot = raw["worktreeRoot"];
  if (typeof worktreeRoot === "string") {
    config.worktreeRoot = worktreeRoot;
  }

  return config;
}

// ---------------------------------------------------------------------------
// initHome
// ---------------------------------------------------------------------------

/**
 * Create the XDG directory tree under homeDir (idempotent).
 * Writes a config.json template if none exists.
 *
 * Directories created: runs/, worktrees/, inbox/, store/
 */
export function initHome(homeDir: string): void {
  const dirs = ["runs", "worktrees", "inbox", "store"];
  for (const dir of dirs) {
    mkdirSync(join(homeDir, dir), { recursive: true });
  }

  const configPath = join(homeDir, "config.json");
  if (!existsSync(configPath)) {
    const template = {
      DEVHARNESS_SRC: "",
      claudeConfigDir: "~/.claude",
    };
    writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n", "utf8");
  }
}
