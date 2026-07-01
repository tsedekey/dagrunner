/**
 * preflight.test.ts — co-located unit tests for getAgentContext,
 * formatAgentContext, and the fixture-able predicates of runPreflight.
 *
 * formatAgentContext golden test: committed snapshot at preflight.golden.txt
 * (UPDATE_SNAPSHOTS=1 writes; plain run compares).
 *
 * runPreflight is partially tested — predicates requiring a real git repo
 * or live auth are deferred to smoke per the testability decision (see
 * DECISIONS.md unit-test-backfill-2b).
 *
 * Run with:
 *   node --test --import tsx src/cli/preflight.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  getAgentContext,
  formatAgentContext,
  runPreflight,
  checkSdkBinary,
  checkClaudeConfigDir,
  checkNodeVersion,
  checkStaleLock,
  checkDevharnessNotInWorktreeRoot,
  type AgentContext,
} from "./preflight.js";
import type { DagrunnerConfig } from "../config/xdg.js";
import type { VersionInfo } from "../config/version.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("./preflight.golden.txt", import.meta.url),
);

// ---------------------------------------------------------------------------
// getAgentContext — with fixture directories
// ---------------------------------------------------------------------------

test("getAgentContext: commands merged from dagrunner payload + DEVHARNESS_SRC", () => {
  const dagrunnerRoot = mkdtempSync(join(tmpdir(), "dr-pf-root-"));
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-pf-src-"));

  // Write a dagrunner payload command
  const dagCmdsDir = join(dagrunnerRoot, "payload", "commands");
  mkdirSync(dagCmdsDir, { recursive: true });
  writeFileSync(join(dagCmdsDir, "dagcmd.md"), "# dagcmd", "utf8");

  // Write a DEVHARNESS_SRC command (different name — not override)
  const srcCmdsDir = join(devharnessSrc, ".claude", "commands");
  mkdirSync(srcCmdsDir, { recursive: true });
  writeFileSync(join(srcCmdsDir, "srccmd.md"), "# srccmd", "utf8");

  // Minimal settings.json in DEVHARNESS_SRC (no env, no mcp)
  mkdirSync(join(devharnessSrc, ".claude"), { recursive: true });
  writeFileSync(
    join(devharnessSrc, ".claude", "settings.json"),
    JSON.stringify({}),
    "utf8",
  );

  const config: DagrunnerConfig = { DEVHARNESS_SRC: devharnessSrc };
  const ctx = getAgentContext(dagrunnerRoot, config);

  const cmdNames = ctx.commands.map((c) => c.name);
  assert.ok(cmdNames.includes("dagcmd"), "dagrunner command must appear");
  assert.ok(cmdNames.includes("srccmd"), "DEVHARNESS_SRC command must appear");

  // Source attribution
  const dagcmd = ctx.commands.find((c) => c.name === "dagcmd");
  const srccmd = ctx.commands.find((c) => c.name === "srccmd");
  assert.equal(dagcmd?.source, "dagrunner");
  assert.equal(srccmd?.source, "DEVHARNESS_SRC");
});

test("getAgentContext: dagrunner command shadows DEVHARNESS_SRC command with same name", () => {
  const dagrunnerRoot = mkdtempSync(join(tmpdir(), "dr-pf-root-"));
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-pf-src-"));

  const dagCmdsDir = join(dagrunnerRoot, "payload", "commands");
  mkdirSync(dagCmdsDir, { recursive: true });
  writeFileSync(join(dagCmdsDir, "shared.md"), "# from dagrunner", "utf8");

  const srcCmdsDir = join(devharnessSrc, ".claude", "commands");
  mkdirSync(srcCmdsDir, { recursive: true });
  writeFileSync(join(srcCmdsDir, "shared.md"), "# from src", "utf8");

  mkdirSync(join(devharnessSrc, ".claude"), { recursive: true });
  writeFileSync(
    join(devharnessSrc, ".claude", "settings.json"),
    JSON.stringify({}),
    "utf8",
  );

  const config: DagrunnerConfig = { DEVHARNESS_SRC: devharnessSrc };
  const ctx = getAgentContext(dagrunnerRoot, config);

  const shared = ctx.commands.filter((c) => c.name === "shared");
  // Only one entry (dagrunner wins, src is suppressed)
  assert.equal(shared.length, 1);
  assert.equal(shared[0]?.source, "dagrunner");
});

test("getAgentContext: env from DEVHARNESS_SRC settings.json is passed through", () => {
  const dagrunnerRoot = mkdtempSync(join(tmpdir(), "dr-pf-root-"));
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-pf-src-"));

  mkdirSync(join(devharnessSrc, ".claude"), { recursive: true });
  writeFileSync(
    join(devharnessSrc, ".claude", "settings.json"),
    JSON.stringify({ env: { MY_REPO_VAR: "some-value" } }),
    "utf8",
  );

  const config: DagrunnerConfig = { DEVHARNESS_SRC: devharnessSrc };
  const ctx = getAgentContext(dagrunnerRoot, config);

  assert.equal(ctx.env["MY_REPO_VAR"], "some-value");
});

test("getAgentContext: hooks list is the canonical four", () => {
  const dagrunnerRoot = mkdtempSync(join(tmpdir(), "dr-pf-root-"));
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-pf-src-"));

  mkdirSync(join(devharnessSrc, ".claude"), { recursive: true });
  writeFileSync(
    join(devharnessSrc, ".claude", "settings.json"),
    JSON.stringify({}),
    "utf8",
  );

  const config: DagrunnerConfig = { DEVHARNESS_SRC: devharnessSrc };
  const ctx = getAgentContext(dagrunnerRoot, config);

  assert.deepStrictEqual(ctx.hooks, [
    "SessionStart",
    "Stop",
    "PostToolUse",
    "SessionEnd",
  ]);
});

// ---------------------------------------------------------------------------
// formatAgentContext — golden snapshot
// ---------------------------------------------------------------------------

const FIXED_CTX: AgentContext = {
  commands: [
    { name: "dr-build", source: "dagrunner" },
    { name: "expand", source: "DEVHARNESS_SRC" },
  ],
  agents: [{ name: "code-reviewer", source: "dagrunner" }],
  skills: [{ name: "architecture-spec", source: "DEVHARNESS_SRC" }],
  env: { REPO_ENV: "repo-value" },
  mcpServers: ["camunda-knowledge"],
  hooks: ["SessionStart", "Stop", "PostToolUse", "SessionEnd"],
  seededSettings: { permissions: { defaultMode: "acceptEdits" } },
};

const FIXED_CONFIG: DagrunnerConfig = {
  DEVHARNESS_SRC: "/test/devharness/src",
  claudeConfigDir: "/test/.claude",
  maxBudgetUsd: 10,
  maxParallel: 3,
};

const FIXED_HOME = "/test/dagrunner/home";
const FIXED_CONTEXT_FILE = "/test/cache/preflight-context.md";

// Synthetic version — deliberately NOT the real package.json version, so the
// golden snapshot never breaks under the mandatory version-bump policy.
const FIXED_VERSION: VersionInfo = {
  version: "9.9.9",
  buildTime: "2026-07-01 14:32:05 UTC",
  isDev: false,
};

test("formatAgentContext: golden snapshot", () => {
  const actual = formatAgentContext(
    FIXED_CTX,
    FIXED_CONTEXT_FILE,
    FIXED_CONFIG,
    FIXED_HOME,
    FIXED_VERSION,
  );

  if (process.env["UPDATE_SNAPSHOTS"] === "1") {
    writeFileSync(SNAPSHOT_PATH, actual, "utf8");
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `Golden snapshot missing at ${SNAPSHOT_PATH}. ` +
        `Run with UPDATE_SNAPSHOTS=1 to generate it.`,
    );
  }

  const expected = readFileSync(SNAPSHOT_PATH, "utf8");
  assert.equal(
    actual,
    expected,
    `formatAgentContext output differs from snapshot at ${SNAPSHOT_PATH}`,
  );
});

test("formatAgentContext: version line reflects built mode", () => {
  const actual = formatAgentContext(
    FIXED_CTX,
    FIXED_CONTEXT_FILE,
    FIXED_CONFIG,
    FIXED_HOME,
    FIXED_VERSION,
  );
  assert.ok(
    actual.includes("dagrun version") &&
      actual.includes("9.9.9") &&
      actual.includes("(built 2026-07-01 14:32:05 UTC)"),
    `Expected built-mode version line, got:\n${actual}`,
  );
});

test("formatAgentContext: version line reflects dev mode", () => {
  const devVersion: VersionInfo = {
    version: "9.9.9",
    buildTime: "unbuilt (dev)",
    isDev: true,
  };
  const actual = formatAgentContext(
    FIXED_CTX,
    FIXED_CONTEXT_FILE,
    FIXED_CONFIG,
    FIXED_HOME,
    devVersion,
  );
  assert.ok(
    actual.includes("dagrun version") && actual.includes("(dev, unbuilt)"),
    `Expected dev-mode version line, got:\n${actual}`,
  );
});

// ---------------------------------------------------------------------------
// runPreflight — fixture-able predicates
// ---------------------------------------------------------------------------

test("runPreflight: missing home subdirectory produces a failure", () => {
  // Create a home dir with only "runs" and "worktrees" but not "inbox" or "store"
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-chk-"));
  mkdirSync(join(homeDir, "runs"), { recursive: true });
  mkdirSync(join(homeDir, "worktrees"), { recursive: true });
  // inbox and store intentionally absent

  // DEVHARNESS_SRC: use a real existing dir to not trigger that check
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-pf-src-"));

  const config: DagrunnerConfig = { DEVHARNESS_SRC: devharnessSrc };
  const result = runPreflight(config, homeDir);

  assert.equal(result.ok, false);
  if (result.ok === false) {
    const failureText = result.failures.join("\n");
    assert.ok(
      failureText.includes("inbox") || failureText.includes("store"),
      `Expected failure mentioning inbox or store, got: ${failureText}`,
    );
  }
});

test("runPreflight: nonexistent DEVHARNESS_SRC produces a failure", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-chk-"));
  for (const sub of ["runs", "worktrees", "inbox", "store"]) {
    mkdirSync(join(homeDir, sub), { recursive: true });
  }

  const config: DagrunnerConfig = {
    DEVHARNESS_SRC: "/nonexistent/devharness/src/dr-pf-test",
  };
  const result = runPreflight(config, homeDir);

  assert.equal(result.ok, false);
  if (result.ok === false) {
    const failureText = result.failures.join("\n");
    assert.ok(
      failureText.includes("DEVHARNESS_SRC"),
      `Expected DEVHARNESS_SRC mention, got: ${failureText}`,
    );
  }
});

// ---------------------------------------------------------------------------
// runPreflight: DEVHARNESS_SRC exists but is not a git repo produces a failure
// ---------------------------------------------------------------------------

test("runPreflight: DEVHARNESS_SRC exists but is not a git repo produces a failure", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-chk-"));
  for (const sub of ["runs", "worktrees", "inbox", "store"]) {
    mkdirSync(join(homeDir, sub), { recursive: true });
  }

  // A real directory but not a git repo
  const notARepo = mkdtempSync(join(tmpdir(), "dr-pf-notrep-"));

  const config: DagrunnerConfig = { DEVHARNESS_SRC: notARepo };
  const result = runPreflight(config, homeDir);

  assert.equal(result.ok, false);
  if (result.ok === false) {
    const failureText = result.failures.join("\n");
    assert.ok(
      failureText.toLowerCase().includes("git"),
      `Expected git-related failure, got: ${failureText}`,
    );
  }
});

// ---------------------------------------------------------------------------
// checkSdkBinary — injectable resolver
// ---------------------------------------------------------------------------

test("checkSdkBinary: no failures when resolver finds the binary", () => {
  assert.deepStrictEqual(
    checkSdkBinary(() => "/some/path/claude"),
    [],
  );
});

test("checkSdkBinary: failure when resolver throws (package not installed)", () => {
  const result = checkSdkBinary(() => {
    throw new Error("MODULE_NOT_FOUND");
  });
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.includes("npm install"),
    `Expected npm install hint, got: ${result[0]}`,
  );
});

// ---------------------------------------------------------------------------
// checkClaudeConfigDir — pure, uses existsSync
// ---------------------------------------------------------------------------

test("checkClaudeConfigDir: no failures when claudeConfigDir is undefined", () => {
  assert.deepStrictEqual(checkClaudeConfigDir(undefined), []);
});

test("checkClaudeConfigDir: no failures when claudeConfigDir exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-pf-ccd-"));
  assert.deepStrictEqual(checkClaudeConfigDir(dir), []);
});

test("checkClaudeConfigDir: failure when claudeConfigDir does not exist", () => {
  const result = checkClaudeConfigDir("/nonexistent/claude-config-dir-dr-pf");
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.includes("/nonexistent/claude-config-dir-dr-pf"),
    `Expected path in message, got: ${result[0]}`,
  );
});

// ---------------------------------------------------------------------------
// checkNodeVersion — pure
// ---------------------------------------------------------------------------

test("checkNodeVersion: no failures on exact minimum version", () => {
  assert.deepStrictEqual(checkNodeVersion("20.10.0"), []);
});

test("checkNodeVersion: no failures on a newer version", () => {
  assert.deepStrictEqual(checkNodeVersion("22.3.1"), []);
});

test("checkNodeVersion: failure on Node 20.9.0 (minor below 10)", () => {
  const result = checkNodeVersion("20.9.0");
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.includes("20.9.0"),
    `Expected version in message, got: ${result[0]}`,
  );
});

test("checkNodeVersion: failure on Node 18.x", () => {
  const result = checkNodeVersion("18.20.0");
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.includes("18.20.0"),
    `Expected version in message, got: ${result[0]}`,
  );
});

// ---------------------------------------------------------------------------
// checkStaleLock — uses real temp dir with lock file
// ---------------------------------------------------------------------------

test("checkStaleLock: no failures when no lock file exists", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-lock-"));
  assert.deepStrictEqual(checkStaleLock(homeDir), []);
});

test("checkStaleLock: failure with stale lock (dead PID)", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-lock-"));
  // PID 1 exists but is owned by root; any non-root process gets EPERM.
  // Use PID 2147483647 (max int32) which is guaranteed not to exist.
  const deadPid = 2147483647;
  writeFileSync(
    join(homeDir, "active.lock"),
    JSON.stringify({
      runId: "test-run-001",
      pid: deadPid,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  const result = checkStaleLock(homeDir);
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.toLowerCase().includes("stale"),
    `Expected stale mention, got: ${result[0]}`,
  );
  assert.ok(
    result[0]!.includes("test-run-001"),
    `Expected run id in message, got: ${result[0]}`,
  );
});

test("checkStaleLock: failure with active lock (current process PID)", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-lock-"));
  writeFileSync(
    join(homeDir, "active.lock"),
    JSON.stringify({
      runId: "active-run-001",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  const result = checkStaleLock(homeDir);
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.includes("active-run-001"),
    `Expected run id in message, got: ${result[0]}`,
  );
  // Should NOT say "stale" — it's a live process
  assert.ok(
    !result[0]!.toLowerCase().includes("stale"),
    `Should not say stale for live pid, got: ${result[0]}`,
  );
});

// ---------------------------------------------------------------------------
// checkDevharnessNotInWorktreeRoot — pure path check
// ---------------------------------------------------------------------------

test("checkDevharnessNotInWorktreeRoot: no failures when DEVHARNESS_SRC is outside worktree root", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-wt-"));
  const srcDir = mkdtempSync(join(tmpdir(), "dr-pf-src-"));
  const config: DagrunnerConfig = { DEVHARNESS_SRC: srcDir };
  assert.deepStrictEqual(checkDevharnessNotInWorktreeRoot(config, homeDir), []);
});

test("checkDevharnessNotInWorktreeRoot: failure when DEVHARNESS_SRC is inside homeDir/worktrees", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-wt-"));
  const fakeSrc = join(homeDir, "worktrees", "my-run", "repo");
  const config: DagrunnerConfig = { DEVHARNESS_SRC: fakeSrc };
  const result = checkDevharnessNotInWorktreeRoot(config, homeDir);
  assert.equal(result.length, 1);
  assert.ok(
    result[0]!.toLowerCase().includes("worktree"),
    `Expected worktree mention, got: ${result[0]}`,
  );
});

test("checkDevharnessNotInWorktreeRoot: failure when DEVHARNESS_SRC is the worktree root itself", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-wt-"));
  const config: DagrunnerConfig = {
    DEVHARNESS_SRC: join(homeDir, "worktrees"),
  };
  const result = checkDevharnessNotInWorktreeRoot(config, homeDir);
  assert.equal(result.length, 1);
});

test("checkDevharnessNotInWorktreeRoot: respects custom worktreeRoot from config", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-pf-wt-"));
  const customWtRoot = mkdtempSync(join(tmpdir(), "dr-pf-custom-wt-"));
  const fakeSrc = join(customWtRoot, "some-run", "repo");
  const config: DagrunnerConfig = {
    DEVHARNESS_SRC: fakeSrc,
    worktreeRoot: customWtRoot,
  };
  const result = checkDevharnessNotInWorktreeRoot(config, homeDir);
  assert.equal(result.length, 1);
});
