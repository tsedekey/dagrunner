/**
 * settings-seed.test.ts — co-located unit tests for buildSeededSettings,
 * readSourcePassthrough, and readWorkProfileMcpServers.
 *
 * All FS fixtures use mkdtempSync — never touches ~/.local/share/dagrunner.
 *
 * Run with:
 *   node --test --import tsx src/config/settings-seed.test.ts
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
  buildSeededSettings,
  readSourcePassthrough,
  readWorkProfileMcpServers,
} from "./settings-seed.js";

// ---------------------------------------------------------------------------
// buildSeededSettings — owned keys come from dagrunner
// ---------------------------------------------------------------------------

test("buildSeededSettings: owned keys (permissions/sandbox/hooks) come from dagrunner", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));
  const settings = buildSeededSettings({
    runDir: join(dir, "runs", "test-run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
  });

  // permissions
  const perms = settings["permissions"] as Record<string, unknown>;
  assert.ok(
    perms !== null && typeof perms === "object",
    "permissions must be present",
  );
  assert.equal(perms["defaultMode"], "acceptEdits");
  assert.ok(
    Array.isArray(perms["allow"]),
    "permissions.allow must be an array",
  );
  assert.ok(Array.isArray(perms["deny"]), "permissions.deny must be an array");

  // sandbox
  const sandbox = settings["sandbox"] as Record<string, unknown>;
  assert.ok(
    sandbox !== null && typeof sandbox === "object",
    "sandbox must be present",
  );
  assert.equal(sandbox["enabled"], true);
  assert.equal(sandbox["autoAllowBashIfSandboxed"], true);

  // hooks — all four lifecycle hooks present
  const hooks = settings["hooks"] as Record<string, unknown>;
  assert.ok(
    hooks !== null && typeof hooks === "object",
    "hooks must be present",
  );
  assert.ok(
    Array.isArray(hooks["SessionStart"]),
    "hooks.SessionStart must be array",
  );
  assert.ok(Array.isArray(hooks["Stop"]), "hooks.Stop must be array");
  assert.ok(
    Array.isArray(hooks["PostToolUse"]),
    "hooks.PostToolUse must be array",
  );
  assert.ok(
    Array.isArray(hooks["SessionEnd"]),
    "hooks.SessionEnd must be array",
  );
});

// ---------------------------------------------------------------------------
// buildSeededSettings — runDir appears in additionalDirectories
// ---------------------------------------------------------------------------

test("buildSeededSettings: runDir is in additionalDirectories", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));
  const runDir = join(dir, "runs", "test-run");

  const settings = buildSeededSettings({
    runDir,
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
  });

  const perms = settings["permissions"] as Record<string, unknown>;
  const additionalDirs = perms["additionalDirectories"] as string[];
  assert.ok(
    additionalDirs.includes(runDir),
    `Expected runDir "${runDir}" in additionalDirectories`,
  );
});

// ---------------------------------------------------------------------------
// buildSeededSettings — devharnessSrc added when provided, absent otherwise
// ---------------------------------------------------------------------------

test("buildSeededSettings: devharnessSrc in additionalDirectories when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));
  const devharnessSrc = "/fake/devharness/src";

  const settings = buildSeededSettings({
    runDir: join(dir, "run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
    devharnessSrc,
  });

  const perms = settings["permissions"] as Record<string, unknown>;
  const additionalDirs = perms["additionalDirectories"] as string[];
  assert.ok(
    additionalDirs.includes(devharnessSrc),
    `Expected devharnessSrc "${devharnessSrc}" in additionalDirectories`,
  );
});

test("buildSeededSettings: devharnessSrc absent when not provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));

  const settings = buildSeededSettings({
    runDir: join(dir, "run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
    // devharnessSrc omitted
  });

  const perms = settings["permissions"] as Record<string, unknown>;
  const additionalDirs = perms["additionalDirectories"] as string[];
  // None of the entries should look like an external harness path
  assert.ok(
    !additionalDirs.some((d) => d === "/fake/devharness/src"),
    "devharnessSrc must not appear when not provided",
  );
});

// ---------------------------------------------------------------------------
// buildSeededSettings — dagrunnerHome added when provided
// ---------------------------------------------------------------------------

test("buildSeededSettings: dagrunnerHome in additionalDirectories when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));
  const dagrunnerHome = join(dir, ".local", "share", "dagrunner");

  const settings = buildSeededSettings({
    runDir: join(dir, "run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
    dagrunnerHome,
  });

  const perms = settings["permissions"] as Record<string, unknown>;
  const additionalDirs = perms["additionalDirectories"] as string[];
  assert.ok(
    additionalDirs.includes(dagrunnerHome),
    `Expected dagrunnerHome "${dagrunnerHome}" in additionalDirectories`,
  );
});

// ---------------------------------------------------------------------------
// buildSeededSettings — passthrough.env appears in output
// ---------------------------------------------------------------------------

test("buildSeededSettings: passthrough.env non-empty → appears in settings.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));

  const settings = buildSeededSettings({
    runDir: join(dir, "run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: {
      env: { MY_VAR: "my-value", ANOTHER: "42" },
      mcpServers: undefined,
    },
  });

  const env = settings["env"] as Record<string, string>;
  assert.ok(
    env !== null && typeof env === "object",
    "env must be present in output",
  );
  assert.equal(env["MY_VAR"], "my-value");
  assert.equal(env["ANOTHER"], "42");
});

test("buildSeededSettings: empty passthrough.env → env key absent from output", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));

  const settings = buildSeededSettings({
    runDir: join(dir, "run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
  });

  assert.ok(
    !("env" in settings),
    "env key must be absent when passthrough.env is empty",
  );
});

// ---------------------------------------------------------------------------
// buildSeededSettings — MCP merge precedence (workProfileMcpServers wins on conflict)
// ---------------------------------------------------------------------------

test("buildSeededSettings: workProfileMcpServers wins over passthrough.mcpServers on key conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ss-"));

  const settings = buildSeededSettings({
    runDir: join(dir, "run"),
    homeDir: dir,
    tmpDir: "/tmp",
    passthrough: {
      env: {},
      mcpServers: {
        "shared-server": { command: "from-passthrough", type: "stdio" },
        "passthrough-only": { command: "pass", type: "stdio" },
      },
    },
    workProfileMcpServers: {
      "shared-server": { command: "from-work-profile", type: "stdio" },
      "work-only": { command: "work", type: "stdio" },
    },
  });

  const mcp = settings["mcpServers"] as Record<string, Record<string, string>>;
  assert.ok(
    mcp !== null && typeof mcp === "object",
    "mcpServers must be present",
  );
  // workProfileMcpServers overwrites passthrough on conflict
  assert.equal(mcp["shared-server"]?.["command"], "from-work-profile");
  // Both sources contribute non-conflicting keys
  assert.ok(
    "passthrough-only" in mcp,
    "passthrough-only server must be present",
  );
  assert.ok("work-only" in mcp, "work-only server must be present");
});

// ---------------------------------------------------------------------------
// readSourcePassthrough — missing settings.json → empty defaults
// ---------------------------------------------------------------------------

test("readSourcePassthrough: missing settings.json returns empty defaults", () => {
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-ss-src-"));

  const result = readSourcePassthrough(devharnessSrc);

  assert.deepStrictEqual(result.env, {});
  assert.equal(result.mcpServers, undefined);
});

// ---------------------------------------------------------------------------
// readSourcePassthrough — valid settings.json → returns env + mcpServers
// ---------------------------------------------------------------------------

test("readSourcePassthrough: valid settings.json returns env and mcpServers", () => {
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-ss-src-"));
  const claudeDir = join(devharnessSrc, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsContent = {
    env: { REPO_ENV: "repo-value" },
    mcpServers: { "repo-mcp": { command: "repo-cmd", type: "stdio" } },
  };
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(settingsContent),
    "utf8",
  );

  const result = readSourcePassthrough(devharnessSrc);

  assert.deepStrictEqual(result.env, { REPO_ENV: "repo-value" });
  assert.ok(
    result.mcpServers !== null && typeof result.mcpServers === "object",
  );
});

// ---------------------------------------------------------------------------
// readSourcePassthrough — malformed JSON → returns empty defaults (silent fallback)
// ---------------------------------------------------------------------------

test("readSourcePassthrough: malformed JSON returns empty defaults", () => {
  const devharnessSrc = mkdtempSync(join(tmpdir(), "dr-ss-src-"));
  const claudeDir = join(devharnessSrc, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), "{ not valid json", "utf8");

  const result = readSourcePassthrough(devharnessSrc);

  assert.deepStrictEqual(result.env, {});
  assert.equal(result.mcpServers, undefined);
});

// ---------------------------------------------------------------------------
// readWorkProfileMcpServers — missing .claude.json → returns {}
// ---------------------------------------------------------------------------

test("readWorkProfileMcpServers: missing .claude.json returns empty object", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-ss-home-"));

  const result = readWorkProfileMcpServers(homeDir, "/fake/crev");

  assert.deepStrictEqual(result, {});
});

// ---------------------------------------------------------------------------
// readWorkProfileMcpServers — stdio server with CREV_REPO_DIR → overridden
// ---------------------------------------------------------------------------

test("readWorkProfileMcpServers: stdio server with CREV_REPO_DIR gets overridden to crevRepoDir", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-ss-home-"));
  const claudeWorkDir = join(homeDir, ".claude-work");
  mkdirSync(claudeWorkDir, { recursive: true });

  const claudeJson = {
    mcpServers: {
      "crev-server": {
        type: "stdio",
        command: "node",
        args: ["crev.js"],
        env: { CREV_REPO_DIR: "/old/path", OTHER_VAR: "keep" },
      },
    },
  };
  writeFileSync(
    join(claudeWorkDir, ".claude.json"),
    JSON.stringify(claudeJson),
    "utf8",
  );

  const result = readWorkProfileMcpServers(homeDir, "/new/crev/path");

  const server = result["crev-server"] as Record<
    string,
    Record<string, string>
  >;
  assert.ok(server !== undefined, "crev-server must be present in result");
  assert.equal(server["env"]?.["CREV_REPO_DIR"], "/new/crev/path");
  assert.equal(server["env"]?.["OTHER_VAR"], "keep");
});

// ---------------------------------------------------------------------------
// readWorkProfileMcpServers — http/sse server excluded (stdio-only filter)
// ---------------------------------------------------------------------------

test("readWorkProfileMcpServers: http/sse server (type != stdio) is excluded", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-ss-home-"));
  const claudeWorkDir = join(homeDir, ".claude-work");
  mkdirSync(claudeWorkDir, { recursive: true });

  const claudeJson = {
    mcpServers: {
      "http-server": {
        type: "http",
        command: "node",
        args: ["http.js"],
      },
      "sse-server": {
        type: "sse",
        command: "node",
        args: ["sse.js"],
      },
      "stdio-server": {
        type: "stdio",
        command: "node",
        args: ["stdio.js"],
      },
    },
  };
  writeFileSync(
    join(claudeWorkDir, ".claude.json"),
    JSON.stringify(claudeJson),
    "utf8",
  );

  const result = readWorkProfileMcpServers(homeDir, "/crev");

  assert.ok(!("http-server" in result), "http-server must be excluded");
  assert.ok(!("sse-server" in result), "sse-server must be excluded");
  assert.ok("stdio-server" in result, "stdio-server must be included");
});

// ---------------------------------------------------------------------------
// readWorkProfileMcpServers — server without command field excluded
// ---------------------------------------------------------------------------

test("readWorkProfileMcpServers: server without command field is excluded", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "dr-ss-home-"));
  const claudeWorkDir = join(homeDir, ".claude-work");
  mkdirSync(claudeWorkDir, { recursive: true });

  const claudeJson = {
    mcpServers: {
      "no-command-server": {
        type: "stdio",
        // no command field
      },
      "valid-server": {
        type: "stdio",
        command: "node",
        args: ["valid.js"],
      },
    },
  };
  writeFileSync(
    join(claudeWorkDir, ".claude.json"),
    JSON.stringify(claudeJson),
    "utf8",
  );

  const result = readWorkProfileMcpServers(homeDir, "/crev");

  assert.ok(
    !("no-command-server" in result),
    "server without command must be excluded",
  );
  assert.ok("valid-server" in result, "valid server must be included");
});

// ---------------------------------------------------------------------------
// buildSeededSettings — golden snapshot (fixed inputs, no env or real FS paths)
// ---------------------------------------------------------------------------

const GOLDEN_PATH = fileURLToPath(
  new URL("./settings-seed.golden.json", import.meta.url),
);

test("buildSeededSettings: golden snapshot (fixed inputs)", () => {
  const actual = buildSeededSettings({
    runDir: "/test/runs/my-plan-111",
    homeDir: "/test/home",
    tmpDir: "/tmp",
    passthrough: {
      env: { REPO_ENV: "repo-value" },
      mcpServers: {
        "repo-mcp": { command: "repo-cmd", type: "stdio" },
      },
    },
    workProfileMcpServers: {
      "work-mcp": { command: "work-cmd", type: "stdio" },
    },
    devharnessSrc: "/test/devharness/src",
    dagrunnerHome: "/test/home/.local/share/dagrunner",
    // claudeConfigDir omitted — reads real FS; breaks hermeticity
  });

  const serialised = JSON.stringify(actual, null, 2) + "\n";

  if (process.env["UPDATE_SNAPSHOTS"] === "1") {
    writeFileSync(GOLDEN_PATH, serialised, "utf8");
    return;
  }

  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(
      `Golden snapshot missing at ${GOLDEN_PATH}. ` +
        `Run with UPDATE_SNAPSHOTS=1 to generate it.`,
    );
  }

  const expected = readFileSync(GOLDEN_PATH, "utf8");
  assert.equal(
    serialised,
    expected,
    `buildSeededSettings output differs from snapshot.\n` +
      `Snapshot: ${GOLDEN_PATH}\n` +
      `To update: UPDATE_SNAPSHOTS=1 node --test --import tsx src/config/settings-seed.test.ts`,
  );
});
