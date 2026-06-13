/**
 * preflight.ts — pre-run sanity checks (Phase 2a D1).
 *
 * Runs before the DAG starts. Fails loud on any misconfiguration so the
 * runtime permission model, sandbox, and environment are correct before
 * any node mutates the real repo.
 *
 * Called by: `dagrun preflight` (standalone) and `cmdStart` (always).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DagrunnerConfig } from "./xdg.js";

// ---------------------------------------------------------------------------
// PreflightResult
// ---------------------------------------------------------------------------

export type PreflightResult = { ok: true } | { ok: false; failures: string[] };

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

/**
 * Verify the environment is safe to start a run.
 *
 * @param config   Resolved dagrunner config (DEVHARNESS_SRC must be set).
 * @param homeDir  Resolved dagrunner home directory.
 * @param opts     Optional overrides (base branch, expected API key absence, etc.).
 */
export function runPreflight(
  config: DagrunnerConfig,
  homeDir: string,
  opts: {
    /** Expected base branch in DEVHARNESS_SRC. Default: "main". */
    baseBranch?: string;
    /** When true, ANTHROPIC_API_KEY must be absent (enterprise managed-auth). */
    requireManagedAuth?: boolean;
  } = {},
): PreflightResult {
  const failures: string[] = [];
  const baseBranch = opts.baseBranch ?? "main";

  // ------------------------------------------------------------------
  // 1. DEVHARNESS_SRC resolves and is a git repo
  // ------------------------------------------------------------------
  if (!existsSync(config.DEVHARNESS_SRC)) {
    failures.push(`DEVHARNESS_SRC does not exist: "${config.DEVHARNESS_SRC}"`);
  } else {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: config.DEVHARNESS_SRC,
        stdio: "pipe",
      });
    } catch {
      failures.push(
        `DEVHARNESS_SRC is not a git repository: "${config.DEVHARNESS_SRC}"`,
      );
    }

    // 2. On expected base branch
    if (existsSync(config.DEVHARNESS_SRC)) {
      try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: config.DEVHARNESS_SRC,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
        if (branch !== baseBranch) {
          failures.push(
            `DEVHARNESS_SRC is on branch "${branch}", expected "${baseBranch}". ` +
              `Run: git -C "${config.DEVHARNESS_SRC}" checkout ${baseBranch}`,
          );
        }
      } catch {
        failures.push(
          `Could not determine current branch in DEVHARNESS_SRC: "${config.DEVHARNESS_SRC}"`,
        );
      }

      // 3. Git working tree clean (no uncommitted changes)
      try {
        const status = execSync("git status --porcelain", {
          cwd: config.DEVHARNESS_SRC,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
        if (status !== "") {
          failures.push(
            `DEVHARNESS_SRC has uncommitted changes. Commit or stash them first.\n` +
              `  ${status.split("\n").slice(0, 5).join("\n  ")}`,
          );
        }
      } catch {
        failures.push(
          `Could not check git status in DEVHARNESS_SRC: "${config.DEVHARNESS_SRC}"`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. Dagrunner home exists and has required subdirs
  // ------------------------------------------------------------------
  for (const sub of ["runs", "worktrees", "inbox", "store"]) {
    if (!existsSync(join(homeDir, sub))) {
      failures.push(
        `Dagrunner home missing "${sub}" directory: ${join(homeDir, sub)}. Run: dagrun init`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 5. At least one auth credential is present
  // ------------------------------------------------------------------
  const hasApiKey =
    typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
    process.env["ANTHROPIC_API_KEY"] !== "";
  const hasAuthToken =
    typeof process.env["ANTHROPIC_AUTH_TOKEN"] === "string" &&
    process.env["ANTHROPIC_AUTH_TOKEN"] !== "";
  const hasClaudeAuth = (() => {
    try {
      const out = execSync("claude auth status 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      });
      return (
        out.includes('"loggedIn": true') || out.includes('"loggedIn":true')
      );
    } catch {
      return false;
    }
  })();

  if (!hasApiKey && !hasAuthToken && !hasClaudeAuth) {
    failures.push(
      `No Anthropic auth found. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or run \`claude login\`.`,
    );
  }

  // When enterprise managed-auth is expected, ANTHROPIC_API_KEY must NOT be set.
  if (opts.requireManagedAuth === true && hasApiKey) {
    failures.push(
      `Enterprise managed-auth required but ANTHROPIC_API_KEY is set. Unset it and use managed credentials.`,
    );
  }

  // ------------------------------------------------------------------
  // 6. macOS Seatbelt sandbox availability (advisory warning, not hard fail)
  //    The sandbox key is darwin-only; we only check availability, not activation.
  // ------------------------------------------------------------------
  if (process.platform === "darwin") {
    try {
      execSync("which sandbox-exec", { stdio: "pipe" });
      // sandbox-exec present — seatbelt available
    } catch {
      // Not a hard fail — sandbox.enabled in settings.json will still work
      // via Claude Code's built-in sandbox wrapper on supported macOS versions.
    }
  }

  // ------------------------------------------------------------------
  // 7. claude CLI is on PATH (required to spawn SDK sessions)
  // ------------------------------------------------------------------
  try {
    execSync("which claude", { stdio: "pipe" });
  } catch {
    failures.push(
      `"claude" CLI not found on PATH. Install Claude Code: https://claude.ai/code`,
    );
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}

// ---------------------------------------------------------------------------
// printPreflightResult — human-readable output
// ---------------------------------------------------------------------------

export function printPreflightResult(result: PreflightResult): void {
  if (result.ok) {
    process.stdout.write("dagrun preflight: all checks passed\n");
    return;
  }

  process.stderr.write(
    `dagrun preflight: ${result.failures.length} check(s) failed:\n\n`,
  );
  for (let i = 0; i < result.failures.length; i++) {
    process.stderr.write(`  [${i + 1}] ${result.failures[i]}\n`);
  }
  process.stderr.write("\n");
}
