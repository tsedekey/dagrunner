/**
 * xdg.ts — XDG home layout + config resolution for dagrunner.
 *
 * Design decision (see DECISIONS.md block5):
 *   `resolveHome()` is exported for non-init commands and FAILS LOUD if the
 *   resolved path does not exist. `init` must NOT call resolveHome() — it calls
 *   the internal `computeHomePath()` which returns the path without an existence
 *   check, then creates it.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseReviewersConfig, type ReviewersConfig } from "./reviewers-config.js";

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export type DagrunnerConfig = {
  /** Absolute path to the main checkout. Mandatory — user must fill in. */
  DEVHARNESS_SRC: string;
  /**
   * Which Claude config directory agent sessions use (CLAUDE_CONFIG_DIR).
   * ~/.claude = work (default), ~/.claude-personal = personal.
   */
  claudeConfigDir?: string;
  maxBudgetUsd?: number;
  maxParallel?: number;
  /**
   * Validated `reviewers` block (pr-node reviewer suggestion). Undefined when
   * the block is absent — consumers fall back to parseReviewersConfig(undefined)
   * (documented defaults). A present-but-malformed block exits at load.
   */
  reviewers?: ReviewersConfig;
};

// ---------------------------------------------------------------------------
// Internal: path computation (no existence check)
// ---------------------------------------------------------------------------

/**
 * The ONE definition of the default home: everything Eddie's agents leave behind
 * lives under ~/.local/share/camunda/ (v0.1.85, DECISIONS.md § home-under-camunda).
 */
export function defaultHomePath(): string {
  return join(homedir(), ".local", "share", "camunda", "dagrunner");
}

/** The pre-v0.1.85 default home. Only ever read to detect an un-moved install. */
export function legacyHomePath(): string {
  return join(homedir(), ".local", "share", "dagrunner");
}

/** Absolute path of scripts/move-home.mjs in THIS install (same depth from src/ and dist/). */
export function moveHomeScriptPath(): string {
  return fileURLToPath(new URL("../../scripts/move-home.mjs", import.meta.url));
}

/** True when --home or DAGRUNNER_HOME names the home explicitly (empty counts as unset). */
function hasHomeOverride(homeFlag?: string): boolean {
  if (homeFlag !== undefined && homeFlag !== "") return true;
  const envHome = process.env["DAGRUNNER_HOME"];
  return envHome !== undefined && envHome !== "";
}

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
  return defaultHomePath();
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Fail-loud detection of an un-moved install: no --home / DAGRUNNER_HOME, the
 * new default does NOT exist, and the OLD default (~/.local/share/dagrunner)
 * DOES. Returns the message to show (callers exit / throw with it), else null.
 * Never falls back to the old home silently: reading runs from a home that is
 * supposed to have moved would hide the very state the move script must fix.
 */
export function legacyHomeMovedMessage(homeFlag?: string): string | null {
  if (hasHomeOverride(homeFlag)) return null;
  const next = defaultHomePath();
  const old = legacyHomePath();
  if (existsSync(next) || !existsSync(old)) return null;
  const script = shellQuote(moveHomeScriptPath());
  return (
    `dagrun: the dagrunner home moved (v0.1.85).\n` +
    `  New default: ${next} (does not exist)\n` +
    `  Old home:    ${old} (still exists)\n` +
    `  Move it once with: node ${script}\n` +
    `  Preview first with: node ${script} --dry-run\n` +
    `  (Until then DAGRUNNER_HOME=${old} makes any command use the old home, e.g. \`DAGRUNNER_HOME=${old} dagrun cleanup --all\`, which the move needs first if legacy worktrees remain.)`
  );
}

/**
 * One-line `dagrun preflight` warning for a leftover old home: the active home
 * is the new default AND the old default still exists (new wins; the old one is
 * ignored). Top-level names only. Null otherwise — an explicit override is not
 * our business.
 */
export function legacyHomeLeftoverWarning(activeHome: string): string | null {
  const old = legacyHomePath();
  if (activeHome !== defaultHomePath() || !existsSync(old)) return null;
  let names: string[];
  try {
    names = readdirSync(old).sort();
  } catch {
    names = [];
  }
  return (
    `the old dagrunner home ${old} still exists next to the active ${activeHome} and is ignored; ` +
    `it contains: ${names.length > 0 ? names.join(", ") : "(empty)"}. ` +
    `Archive or delete it once nothing needs it.`
  );
}

// ---------------------------------------------------------------------------
// resolveHome — exported, fails loud if path doesn't exist
// ---------------------------------------------------------------------------

/**
 * Resolve the dagrunner home directory.
 *
 * Resolution order: DAGRUNNER_HOME env → ~/.local/share/camunda/dagrunner
 *
 * Fails loud with exact paths checked if:
 *   - DAGRUNNER_HOME is set but the directory doesn't exist
 *   - the home moved (new default absent, old ~/.local/share/dagrunner present):
 *     the message names both paths and the exact move-home.mjs command
 *   - neither DAGRUNNER_HOME nor the XDG default exists
 *
 * Do NOT call from `init` — use computeHomePath() + initHome() instead.
 */
export function resolveHome(): string {
  const envHome = process.env["DAGRUNNER_HOME"];
  const xdgDefault = defaultHomePath();

  if (envHome !== undefined && envHome !== "") {
    if (!existsSync(envHome)) {
      process.stderr.write(
        `dagrun: DAGRUNNER_HOME is set to "${envHome}" but the directory does not exist.\n`,
      );
      process.exit(1);
    }
    return envHome;
  }

  const moved = legacyHomeMovedMessage();
  if (moved !== null) {
    process.stderr.write(`${moved}\n`);
    process.exit(1);
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

  if ("reviewers" in raw) {
    try {
      config.reviewers = parseReviewersConfig(raw["reviewers"]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`dagrun: invalid config at "${configPath}": ${message}\n`);
      process.exit(1);
    }
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
 *
 * `worktrees/` is LEGACY: new runs adopt an existing worktree and never put one
 * here; it is still created because pre-adoption runs' worktrees live under it.
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
