/**
 * xdg.test.ts — co-located unit tests for computeHomePath, resolveHome,
 * resolveConfig, and initHome.
 *
 * resolveHome / resolveConfig call process.exit(1) on failure. Tests stub
 * process.exit to throw so assert.throws can catch them in-process (see
 * DECISIONS.md unit-test-backfill-2b for the choice and rationale).
 *
 * Run with:
 *   node --test --import tsx src/config/xdg.test.ts
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

import {
  computeHomePath,
  resolveHome,
  resolveConfig,
  initHome,
} from "./xdg.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub process.exit to throw; suppress stderr; restore in finally. */
function withExitStub(fn: () => void): void {
  const origExit = process.exit;
  const origStderr = process.stderr.write.bind(process.stderr);
  process.exit = (() => {
    throw new Error("process.exit called");
  }) as typeof process.exit;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.exit = origExit;
    process.stderr.write = origStderr;
  }
}

// ---------------------------------------------------------------------------
// computeHomePath
// ---------------------------------------------------------------------------

test("computeHomePath: returns XDG default when no flag or env", () => {
  const origEnv = process.env["DAGRUNNER_HOME"];
  delete process.env["DAGRUNNER_HOME"];
  try {
    const result = computeHomePath();
    assert.ok(result.endsWith("/.local/share/dagrunner"), `got: ${result}`);
  } finally {
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
});

test("computeHomePath: DAGRUNNER_HOME env overrides XDG default", () => {
  const origEnv = process.env["DAGRUNNER_HOME"];
  process.env["DAGRUNNER_HOME"] = "/custom/dagrunner/home";
  try {
    const result = computeHomePath();
    assert.equal(result, "/custom/dagrunner/home");
  } finally {
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
});

test("computeHomePath: explicit flag overrides env and XDG", () => {
  const origEnv = process.env["DAGRUNNER_HOME"];
  process.env["DAGRUNNER_HOME"] = "/env/value";
  try {
    const result = computeHomePath("/flag/value");
    assert.equal(result, "/flag/value");
  } finally {
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
});

test("computeHomePath: empty flag falls through to env", () => {
  const origEnv = process.env["DAGRUNNER_HOME"];
  process.env["DAGRUNNER_HOME"] = "/env/value";
  try {
    const result = computeHomePath("");
    assert.equal(result, "/env/value");
  } finally {
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
});

// ---------------------------------------------------------------------------
// resolveHome
// ---------------------------------------------------------------------------

test("resolveHome: returns DAGRUNNER_HOME when it exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-xdg-home-"));
  const origEnv = process.env["DAGRUNNER_HOME"];
  process.env["DAGRUNNER_HOME"] = dir;
  try {
    const result = resolveHome();
    assert.equal(result, dir);
  } finally {
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
});

test("resolveHome: exits loud when DAGRUNNER_HOME set but does not exist", () => {
  const origEnv = process.env["DAGRUNNER_HOME"];
  process.env["DAGRUNNER_HOME"] = "/nonexistent/dagrunner/home/dr-xdg-test";
  try {
    assert.throws(
      () => withExitStub(() => resolveHome()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("process.exit"),
          `expected exit: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

test("resolveConfig: valid config.json with DEVHARNESS_SRC returns parsed config", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-cfg-"));
  const configContent = {
    DEVHARNESS_SRC: "/real/devharness/src",
    maxBudgetUsd: 5,
    maxParallel: 2,
  };
  writeFileSync(
    join(homeDir, "config.json"),
    JSON.stringify(configContent),
    "utf8",
  );

  const config = resolveConfig(homeDir);

  assert.equal(config.DEVHARNESS_SRC, "/real/devharness/src");
  assert.equal(config.maxBudgetUsd, 5);
  assert.equal(config.maxParallel, 2);
});

test("resolveConfig: missing config file exits loud", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-cfg-"));
  // No config.json written

  assert.throws(
    () => withExitStub(() => resolveConfig(homeDir)),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("process.exit"), `got: ${err.message}`);
      return true;
    },
  );
});

test("resolveConfig: blank DEVHARNESS_SRC exits loud", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-cfg-"));
  writeFileSync(
    join(homeDir, "config.json"),
    JSON.stringify({ DEVHARNESS_SRC: "" }),
    "utf8",
  );

  assert.throws(
    () => withExitStub(() => resolveConfig(homeDir)),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("process.exit"), `got: ${err.message}`);
      return true;
    },
  );
});

test("resolveConfig: explicit configFlag overrides default config path", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-cfg-"));
  const altConfigPath = join(homeDir, "alt-config.json");
  writeFileSync(
    altConfigPath,
    JSON.stringify({ DEVHARNESS_SRC: "/alt/src" }),
    "utf8",
  );

  const config = resolveConfig(homeDir, altConfigPath);
  assert.equal(config.DEVHARNESS_SRC, "/alt/src");
});

test("resolveConfig: claudeConfigDir with ~/ is expanded", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-cfg-"));
  writeFileSync(
    join(homeDir, "config.json"),
    JSON.stringify({
      DEVHARNESS_SRC: "/some/src",
      claudeConfigDir: "~/.claude-work",
    }),
    "utf8",
  );

  const config = resolveConfig(homeDir);
  // Must not start with ~ after expansion
  assert.ok(
    !config.claudeConfigDir?.startsWith("~"),
    `Expected expanded path, got: ${config.claudeConfigDir}`,
  );
  assert.ok(
    config.claudeConfigDir?.endsWith("/.claude-work"),
    `Expected to end with .claude-work, got: ${config.claudeConfigDir}`,
  );
});

// ---------------------------------------------------------------------------
// initHome
// ---------------------------------------------------------------------------

test("initHome: creates runs/worktrees/inbox/store subdirectories", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-init-"));

  initHome(homeDir);

  for (const sub of ["runs", "worktrees", "inbox", "store"]) {
    assert.ok(
      existsSync(join(homeDir, sub)),
      `Expected ${sub} to exist after initHome`,
    );
  }
});

test("initHome: writes config.json template if absent", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-init-"));

  initHome(homeDir);

  const configPath = join(homeDir, "config.json");
  assert.ok(existsSync(configPath), "config.json must be written");
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  assert.ok(
    "DEVHARNESS_SRC" in parsed,
    "config template must have DEVHARNESS_SRC key",
  );
});

test("initHome: is idempotent — second call does not throw", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-init-"));

  initHome(homeDir);
  initHome(homeDir); // second call must not throw

  for (const sub of ["runs", "worktrees", "inbox", "store"]) {
    assert.ok(existsSync(join(homeDir, sub)));
  }
});

test("initHome: does not overwrite existing config.json", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-init-"));
  const configPath = join(homeDir, "config.json");
  const customContent = JSON.stringify({ DEVHARNESS_SRC: "/my/custom/src" });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(configPath, customContent, "utf8");

  initHome(homeDir);

  const afterContent = readFileSync(configPath, "utf8");
  assert.equal(afterContent, customContent);
});
