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
  type AgentContext,
} from "./preflight.js";
import type { DagrunnerConfig } from "../config/xdg.js";

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
  claudeConfigDir: "/test/.claude-work",
  maxBudgetUsd: 10,
  maxParallel: 3,
};

const FIXED_HOME = "/test/dagrunner/home";
const FIXED_CONTEXT_FILE = "/test/cache/preflight-context.md";

test("formatAgentContext: golden snapshot", () => {
  const actual = formatAgentContext(
    FIXED_CTX,
    FIXED_CONTEXT_FILE,
    FIXED_CONFIG,
    FIXED_HOME,
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
