/**
 * home-moved.test.ts — end-to-end: the real CLI, run as a child process with a
 * FAKE $HOME, refuses loudly while the home is un-moved (old default present,
 * new absent) and names the exact move command. `init` must not trip on the
 * leftover old home, and with both homes present the new one wins silently.
 *
 * Never touches a real home: every path is under a mkdtemp'd fake HOME.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const MOVE_SCRIPT = fileURLToPath(
  new URL("../../scripts/move-home.mjs", import.meta.url),
);

function runCli(fakeHome: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
  delete env["DAGRUNNER_HOME"];
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function fakeHomeWithOldOnly(): {
  fakeHome: string;
  oldHome: string;
  newHome: string;
} {
  const fakeHome = mkdtempSync(join(tmpdir(), "dr-hm-"));
  const oldHome = join(fakeHome, ".local", "share", "dagrunner");
  const newHome = join(fakeHome, ".local", "share", "camunda", "dagrunner");
  mkdirSync(join(oldHome, "runs"), { recursive: true });
  return { fakeHome, oldHome, newHome };
}

test("dagrun list: old default only -> exit 1, says the home moved, names both paths and the exact command", () => {
  const { fakeHome, oldHome, newHome } = fakeHomeWithOldOnly();
  const r = runCli(fakeHome, ["list"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /moved/i);
  assert.ok(r.stderr.includes(oldHome), r.stderr);
  assert.ok(r.stderr.includes(newHome), r.stderr);
  assert.ok(r.stderr.includes(`node ${MOVE_SCRIPT}`), r.stderr);
  assert.ok(r.stderr.includes("--dry-run"), r.stderr);
  assert.equal(
    existsSync(newHome),
    false,
    "a refusing command must not create the new home",
  );
});

test("dagrun cleanup --all: the plain command refuses, but DAGRUNNER_HOME=<old> gets past home resolution (the documented way to clear legacy worktrees before the move)", () => {
  const { fakeHome, oldHome } = fakeHomeWithOldOnly();
  const plain = runCli(fakeHome, ["cleanup", "--all"]);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /moved/i);
  assert.ok(plain.stderr.includes(`DAGRUNNER_HOME=${oldHome} dagrun cleanup --all`), plain.stderr);

  writeFileSync(join(oldHome, "config.json"), JSON.stringify({ DEVHARNESS_SRC: fakeHome }), "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, DAGRUNNER_HOME: oldHome };
  const viaOverride = spawnSync(process.execPath, ["--import", "tsx", CLI, "cleanup", "--all"], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(viaOverride.status, 0, viaOverride.stderr);
  assert.ok(!/moved/i.test(viaOverride.stderr), viaOverride.stderr);
});

test("dagrun ui: old default only -> the same loud refusal (no server started)", () => {
  const { fakeHome, oldHome } = fakeHomeWithOldOnly();
  const r = runCli(fakeHome, ["ui", "--port", "0"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /moved/i);
  assert.ok(r.stderr.includes(oldHome), r.stderr);
  assert.ok(r.stderr.includes(`node ${MOVE_SCRIPT}`), r.stderr);
});

test("dagrun init: creates the NEW default and does not trip on (or touch) a leftover old home", () => {
  const { fakeHome, oldHome, newHome } = fakeHomeWithOldOnly();
  writeFileSync(join(oldHome, "marker.txt"), "keep", "utf8");
  const r = runCli(fakeHome, ["init"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(newHome), r.stdout);
  for (const sub of ["runs", "inbox", "store"])
    assert.ok(existsSync(join(newHome, sub)), sub);
  assert.deepEqual(readdirSync(oldHome).sort(), ["marker.txt", "runs"]);
});

test("dagrun list: both homes present -> the new one wins silently (exit 0, no moved message)", () => {
  const { fakeHome, newHome } = fakeHomeWithOldOnly();
  mkdirSync(join(newHome, "runs"), { recursive: true });
  const r = runCli(fakeHome, ["list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/moved/i.test(r.stderr), r.stderr);
});

test("dagrun list: neither home present -> the 'run dagrun init' message with the new path", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "dr-hm-"));
  const r = runCli(fakeHome, ["list"]);
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.includes(
      join(fakeHome, ".local", "share", "camunda", "dagrunner"),
    ),
    r.stderr,
  );
  assert.ok(r.stderr.includes("dagrun init"), r.stderr);
});

test("dagrun preflight: both homes present -> one WARNING line naming the old home's top-level entries; it is not counted as a failed check", () => {
  const { fakeHome, oldHome, newHome } = fakeHomeWithOldOnly();
  mkdirSync(join(oldHome, "store"), { recursive: true });
  mkdirSync(join(newHome, "runs"), { recursive: true });
  writeFileSync(
    join(newHome, "config.json"),
    JSON.stringify({ DEVHARNESS_SRC: join(fakeHome, "no-such-src") }),
    "utf8",
  );
  const r = runCli(fakeHome, ["preflight"]);
  const warnings = r.stderr.split("\n").filter((l) => l.includes("WARNING"));
  assert.equal(warnings.length, 1, r.stderr);
  assert.ok(warnings[0]!.includes(oldHome) && warnings[0]!.includes("runs") && warnings[0]!.includes("store"), warnings[0]);
  // the failures it reports are the real checks (missing DEVHARNESS_SRC etc.), never the leftover home
  assert.match(r.stderr, /DEVHARNESS_SRC does not exist/);
  assert.ok(!/\[\d+\][^\n]*old dagrunner home/.test(r.stderr), r.stderr);
});
