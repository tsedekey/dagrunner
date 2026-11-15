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
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeHomePath,
  defaultHomePath,
  legacyHomePath,
  legacyHomeLeftoverWarning,
  legacyHomeMovedMessage,
  moveHomeScriptPath,
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
    assert.ok(
      result.endsWith("/.local/share/camunda/dagrunner"),
      `got: ${result}`,
    );
    assert.equal(result, defaultHomePath());
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
// The home moved under ~/.local/share/camunda/ (v0.1.85): fail-loud legacy detection
// ---------------------------------------------------------------------------

/** Run `fn` with HOME pointing at a fresh temp dir and no DAGRUNNER_HOME; restore after. */
function withFakeHome<T>(fn: (fakeHome: string) => T): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "dr-xdg-fakehome-"));
  const origHome = process.env["HOME"];
  const origEnv = process.env["DAGRUNNER_HOME"];
  process.env["HOME"] = fakeHome;
  delete process.env["DAGRUNNER_HOME"];
  try {
    return fn(fakeHome);
  } finally {
    if (origHome !== undefined) process.env["HOME"] = origHome;
    else delete process.env["HOME"];
    if (origEnv !== undefined) process.env["DAGRUNNER_HOME"] = origEnv;
    else delete process.env["DAGRUNNER_HOME"];
  }
}

/** resolveHome() with process.exit stubbed to throw and stderr captured. */
function resolveHomeCaptured(): { home?: string; exited: boolean; stderr: string } {
  const origExit = process.exit;
  const origWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.exit = (() => {
    throw new Error("process.exit called");
  }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { home: resolveHome(), exited: false, stderr };
  } catch (e) {
    if (e instanceof Error && e.message === "process.exit called") {
      return { exited: true, stderr };
    }
    throw e;
  } finally {
    process.exit = origExit;
    process.stderr.write = origWrite;
  }
}

test("defaultHomePath / legacyHomePath: new default lives under camunda/, legacy is the old path", () => {
  withFakeHome((h) => {
    assert.equal(defaultHomePath(), join(h, ".local", "share", "camunda", "dagrunner"));
    assert.equal(legacyHomePath(), join(h, ".local", "share", "dagrunner"));
  });
});

test("moveHomeScriptPath: absolute path of scripts/move-home.mjs in this install, and it exists", () => {
  const p = moveHomeScriptPath();
  assert.ok(p.startsWith("/"), `got: ${p}`);
  assert.ok(p.endsWith("/scripts/move-home.mjs"), `got: ${p}`);
  assert.ok(existsSync(p), `move script missing at ${p}`);
});

test("resolveHome: old default exists, new default does not -> exits loud naming both paths + the exact move command", () => {
  withFakeHome((h) => {
    mkdirSync(join(h, ".local", "share", "dagrunner", "runs"), { recursive: true });
    const r = resolveHomeCaptured();
    assert.equal(r.exited, true);
    assert.match(r.stderr, /moved/i);
    assert.ok(r.stderr.includes(defaultHomePath()), r.stderr);
    assert.ok(r.stderr.includes(legacyHomePath()), r.stderr);
    assert.ok(r.stderr.includes(`node ${moveHomeScriptPath()}`), r.stderr);
    assert.ok(r.stderr.includes("--dry-run"), r.stderr);
    // the escape hatch for commands the move itself needs first (cleanup --all)
    assert.ok(
      r.stderr.includes(`DAGRUNNER_HOME=${legacyHomePath()} dagrun cleanup --all`),
      r.stderr,
    );
  });
});

test("resolveHome: both exist -> the new home wins silently", () => {
  withFakeHome((h) => {
    mkdirSync(join(h, ".local", "share", "dagrunner"), { recursive: true });
    mkdirSync(join(h, ".local", "share", "camunda", "dagrunner"), { recursive: true });
    const r = resolveHomeCaptured();
    assert.equal(r.exited, false);
    assert.equal(r.home, defaultHomePath());
    assert.equal(r.stderr, "");
  });
});

test("resolveHome: neither exists -> the 'run dagrun init' message with the NEW path (no move hint)", () => {
  withFakeHome(() => {
    const r = resolveHomeCaptured();
    assert.equal(r.exited, true);
    assert.ok(r.stderr.includes(defaultHomePath()), r.stderr);
    assert.ok(r.stderr.includes("dagrun init"), r.stderr);
    assert.ok(!r.stderr.includes("move-home"), r.stderr);
  });
});

test("resolveHome: DAGRUNNER_HOME set -> the legacy home is irrelevant (override unchanged)", () => {
  withFakeHome((h) => {
    mkdirSync(join(h, ".local", "share", "dagrunner"), { recursive: true });
    const custom = mkdtempSync(join(tmpdir(), "dr-xdg-custom-"));
    process.env["DAGRUNNER_HOME"] = custom;
    const r = resolveHomeCaptured();
    assert.equal(r.exited, false);
    assert.equal(r.home, custom);
  });
});

test("legacyHomeMovedMessage: null when only the new default exists, when neither exists, and when an override is in play", () => {
  withFakeHome((h) => {
    assert.equal(legacyHomeMovedMessage(), null); // neither
    mkdirSync(join(h, ".local", "share", "dagrunner"), { recursive: true });
    assert.notEqual(legacyHomeMovedMessage(), null); // old only
    assert.equal(legacyHomeMovedMessage("/some/explicit/home"), null); // --home given
    process.env["DAGRUNNER_HOME"] = "/some/env/home";
    assert.equal(legacyHomeMovedMessage(), null); // env given
    delete process.env["DAGRUNNER_HOME"];
    mkdirSync(join(h, ".local", "share", "camunda", "dagrunner"), { recursive: true });
    assert.equal(legacyHomeMovedMessage(), null); // new exists
  });
});

test("computeHomePath (the init path): returns the NEW default even while only the old home exists", () => {
  withFakeHome((h) => {
    mkdirSync(join(h, ".local", "share", "dagrunner"), { recursive: true });
    assert.equal(computeHomePath(), defaultHomePath());
    initHome(computeHomePath());
    assert.ok(existsSync(join(defaultHomePath(), "runs")));
  });
});

test("legacyHomeLeftoverWarning: one line naming the old home and its top-level names, only when the active home is the new default", () => {
  withFakeHome((h) => {
    const old = join(h, ".local", "share", "dagrunner");
    mkdirSync(join(old, "runs"), { recursive: true });
    mkdirSync(join(old, "store"), { recursive: true });
    writeFileSync(join(old, "config.json"), "{}", "utf8");
    const w = legacyHomeLeftoverWarning(defaultHomePath());
    assert.ok(w !== null);
    assert.ok(!w.trimEnd().includes("\n"), `must be one line: ${w}`);
    assert.ok(w.includes(old), w);
    assert.ok(w.includes("config.json") && w.includes("runs") && w.includes("store"), w);
    assert.equal(legacyHomeLeftoverWarning("/some/other/home"), null); // override in play
    rmSync(old, { recursive: true });
    assert.equal(legacyHomeLeftoverWarning(defaultHomePath()), null); // no old home
  });
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

test("resolveConfig: an old config.json that still carries worktreeRoot loads (unknown key ignored, not parsed)", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-xdg-cfg-"));
  writeFileSync(
    join(homeDir, "config.json"),
    JSON.stringify({ DEVHARNESS_SRC: "/real/src", worktreeRoot: "/old/wt/root" }),
    "utf8",
  );
  const config = resolveConfig(homeDir);
  assert.equal(config.DEVHARNESS_SRC, "/real/src");
  assert.equal("worktreeRoot" in config, false);
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
      claudeConfigDir: "~/.claude-personal",
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
    config.claudeConfigDir?.endsWith("/.claude-personal"),
    `Expected to end with .claude-personal, got: ${config.claudeConfigDir}`,
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
