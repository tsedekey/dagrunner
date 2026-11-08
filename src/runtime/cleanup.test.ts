/**
 * cleanup.test.ts — `dagrun cleanup` for adopted vs legacy runs. Temp home +
 * temp repos only; NEVER the real DAGRUNNER_HOME.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { cleanupAll, cleanupRun } from "./cleanup.js";
import { readLock } from "../core/lock.js";

const GIT_ID = [
  "-c",
  "user.name=dr-test",
  "-c",
  "user.email=dr-test@example.com",
];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "dr-cl-repo-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dr-cl-home-")));
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "worktrees"), { recursive: true });
  return home;
}

function writeRun(
  home: string,
  runId: string,
  worktreePath: string,
  origin?: "adopted",
): void {
  const runDir = join(home, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      runId,
      status: "paused",
      workflow: "feature",
      worktreePath,
      branch: "b",
      ...(origin !== undefined ? { worktreeOrigin: origin } : {}),
      nodes: {},
    }),
  );
}

function holdLock(home: string, runId: string): void {
  writeFileSync(
    join(home, "active.lock"),
    JSON.stringify({ runId, pid: process.pid, startedAt: "T" }),
  );
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

test("cleanupRun (adopted): releases the lock, prints the wm rm hint, never touches the worktree or branch", () => {
  const repo = makeRepo();
  const home = makeHome();
  const wt = join(
    realpathSync(mkdtempSync(join(tmpdir(), "dr-cl-wt-"))),
    "feat-x",
  );
  git(repo, "worktree", "add", "-q", wt, "-b", "feat/x", "main");
  writeRun(home, "7-1", wt, "adopted");
  holdLock(home, "7-1");

  const removed: string[] = [];
  const s = sink();
  const outcome = cleanupRun({
    homeDir: home,
    devharnessSrc: repo,
    runId: "7-1",
    removeWorktree: (p) => removed.push(p),
    ...s.io,
  });

  assert.equal(outcome, "released");
  assert.deepEqual(
    removed,
    [],
    "remover must not be called for an adopted run",
  );
  assert.ok(existsSync(wt), "worktree directory untouched");
  assert.match(
    git(repo, "branch", "--list", "feat/x"),
    /feat\/x/,
    "branch untouched",
  );
  assert.equal(readLock(home), null, "lock released");
  assert.ok(
    s.out
      .join("")
      .includes(
        "dagrun: run 7-1 released. The worktree is yours: remove it with: wm rm feat-x",
      ),
    s.out.join(""),
  );
});

test("cleanupRun (legacy, no worktreeOrigin): git worktree remove is unchanged — remover called, lock released", () => {
  const repo = makeRepo();
  const home = makeHome();
  const legacyWt = join(home, "worktrees", "7-2");
  git(repo, "worktree", "add", "-q", legacyWt, "-b", "feat/legacy", "main");
  writeRun(home, "7-2", legacyWt);
  holdLock(home, "7-2");

  const s = sink();
  const outcome = cleanupRun({
    homeDir: home,
    devharnessSrc: repo,
    runId: "7-2",
    ...s.io,
  });

  assert.equal(outcome, "removed");
  assert.ok(
    !existsSync(legacyWt),
    "the legacy worktree dagrunner created is removed",
  );
  assert.equal(readLock(home), null);
  assert.ok(s.out.join("").includes("dagrun: cleaned up 7-2"), s.out.join(""));
});

test("cleanupRun (legacy): a failing git remove is logged and does not block the lock release (today's behaviour)", () => {
  const repo = makeRepo();
  const home = makeHome();
  writeRun(home, "7-3", join(home, "worktrees", "7-3"));
  holdLock(home, "7-3");
  const s = sink();
  cleanupRun({
    homeDir: home,
    devharnessSrc: repo,
    runId: "7-3",
    removeWorktree: () => {
      throw new Error("boom");
    },
    ...s.io,
  });
  assert.match(s.err.join(""), /git worktree remove failed: boom/);
  assert.equal(readLock(home), null);
});

test("cleanupAll: iterates runs/*/state.json, removes legacy, releases adopted, skips missing worktrees, ignores everything not in a state.json", () => {
  const repo = makeRepo();
  const home = makeHome();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dr-cl-wts-")));

  // adopted, worktree present → released
  const adoptedWt = join(base, "feat-a");
  git(repo, "worktree", "add", "-q", adoptedWt, "-b", "feat/a", "main");
  writeRun(home, "1-1", adoptedWt, "adopted");
  // adopted, worktree already gone → skipped
  writeRun(home, "1-2", join(base, "gone-adopted"), "adopted");
  // legacy, present → removed (real git, real temp worktree)
  const legacyWt = join(home, "worktrees", "1-3");
  git(repo, "worktree", "add", "-q", legacyWt, "-b", "feat/legacy-c", "main");
  writeRun(home, "1-3", legacyWt);
  // legacy, gone → skipped
  writeRun(home, "1-4", join(home, "worktrees", "1-4"));
  // a stranger under <home>/worktrees that no state.json records → must survive
  const stranger = join(home, "worktrees", "stranger");
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, "keep.txt"), "x");
  // a run dir without state.json → ignored
  mkdirSync(join(home, "runs", "no-state"), { recursive: true });
  holdLock(home, "1-1");

  const calls: string[] = [];
  const s = sink();
  const r = cleanupAll({
    homeDir: home,
    devharnessSrc: repo,
    removeWorktree: (p, src) => {
      calls.push(p);
      execFileSync("git", ["worktree", "remove", p, "--force"], { cwd: src });
    },
    ...s.io,
  });

  assert.deepEqual(r, { removed: 1, released: 1, skipped: 2, failed: 0 });
  assert.deepEqual(
    calls,
    [legacyWt],
    "only the legacy worktree recorded in a state.json is ever removed",
  );
  assert.ok(existsSync(adoptedWt), "adopted worktree left alone");
  assert.ok(!existsSync(legacyWt));
  assert.ok(
    existsSync(join(stranger, "keep.txt")),
    "a path not recorded in any state.json is never touched",
  );
  assert.equal(readLock(home), null, "lock released");
  const text = s.out.join("");
  assert.ok(text.includes(`wm rm ${basename(adoptedWt)}`), text);
  assert.match(text, /removed 1, released 1, skipped 2/);
});

test("cleanupAll: a failing removal is counted and reported, not swallowed", () => {
  const repo = makeRepo();
  const home = makeHome();
  const legacyWt = join(home, "worktrees", "2-1");
  mkdirSync(legacyWt, { recursive: true });
  writeRun(home, "2-1", legacyWt);
  const s = sink();
  const r = cleanupAll({
    homeDir: home,
    devharnessSrc: repo,
    removeWorktree: () => {
      throw new Error("locked");
    },
    ...s.io,
  });
  assert.deepEqual(r, { removed: 0, released: 0, skipped: 0, failed: 1 });
  assert.match(s.err.join(""), /failed to remove .*2-1: locked/);
  assert.match(s.out.join(""), /failed 1/);
});

test("cleanupAll: no runs → says so and removes nothing", () => {
  const home = makeHome();
  const s = sink();
  const r = cleanupAll({
    homeDir: home,
    devharnessSrc: "/nonexistent",
    ...s.io,
  });
  assert.deepEqual(r, { removed: 0, released: 0, skipped: 0, failed: 0 });
  assert.match(s.out.join(""), /no runs to clean up/);
});
