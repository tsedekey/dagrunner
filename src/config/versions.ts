/**
 * Pinned toolchain versions — single source of truth.
 *
 * CLI version: asserted at preflight via `checkClaudeCliVersion`.
 * SDK version: pinned exact in package.json (no ^ caret) + lockfile.
 *
 * To upgrade: bump this constant + package.json SDK version together,
 * run `npm install` (resync lockfile), run `smoke:live` once, commit both.
 * Set DAGRUN_SKIP_CLI_VERSION_CHECK=1 to bypass the CLI assertion during
 * testing against a new version before updating the pin.
 */

/** Current reproducibility baseline for the Claude Code CLI version. */
export const EXPECTED_CLAUDE_CLI_VERSION = "2.1.181";
