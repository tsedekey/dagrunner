/**
 * worktree.test.ts — adoption of an existing git worktree (validateAdoptedWorktree
 * + resolveWorktreeArg). Real temp git repos, temp DAGRUNNER_HOME; never touches
 * the real home or any real repo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveWorktreeArg,
  validateAdoptedWorktree,
  WorktreeAdoptionError,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A main checkout on `main` with one tracked file. */
function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "dr-wt-repo-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** A linked worktree of `repo` on a fresh branch off main. */
function addWorktree(repo: string, branch: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "dr-wt-linked-")));
  const wt = join(parent, branch.replace(/\//g, "-"));
  git(repo, "worktree", "add", "-q", wt, "-b", branch, "main");
  return realpathSync(wt);
}

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dr-wt-home-")));
  mkdirSync(join(home, "runs"), { recursive: true });
  return home;
}

function writeRun(
  home: string,
  runId: string,
  worktreePath: string,
  status: string,
): void {
  const runDir = join(home, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      runId,
      status,
      worktreePath,
      branch: "b",
      workflow: "feature",
      nodes: {},
    }),
  );
}

type Fx = { repo: string; wt: string; home: string };
function fixture(branch = "feat/adopt-me"): Fx {
  const repo = makeRepo();
  return { repo, wt: addWorktree(repo, branch), home: makeHome() };
}

function validate(
  fx: Fx,
  over: Partial<Parameters<typeof validateAdoptedWorktree>[0]> = {},
) {
  return validateAdoptedWorktree({
    worktreePath: fx.wt,
    devharnessSrc: fx.repo,
    baseBranch: "main",
    homeDir: fx.home,
    ...over,
  });
}

function refusal(fn: () => unknown): WorktreeAdoptionError {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e instanceof WorktreeAdoptionError,
      `expected WorktreeAdoptionError, got ${String(e)}`,
    );
    return e;
  }
  assert.fail("expected the validation to refuse, but it passed");
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("validateAdoptedWorktree: a clean linked worktree on its own branch is adopted (branch + realpath returned)", () => {
  const fx = fixture();
  const r = validate(fx);
  assert.deepEqual(r, { worktreePath: fx.wt, branch: "feat/adopt-me" });
});

test("validateAdoptedWorktree: the returned path is realpath-normalised (symlinked input)", () => {
  const fx = fixture();
  const link = join(tmpdir(), `dr-wt-link-${String(Date.now())}`);
  symlinkSync(fx.wt, link);
  assert.equal(validate(fx, { worktreePath: link }).worktreePath, fx.wt);
});

test("validateAdoptedWorktree: untracked files are allowed (workmux may leave .workmux/)", () => {
  const fx = fixture();
  mkdirSync(join(fx.wt, ".workmux"));
  writeFileSync(join(fx.wt, ".workmux", "state"), "x");
  writeFileSync(join(fx.wt, "scratch.txt"), "x");
  assert.equal(validate(fx).branch, "feat/adopt-me");
});

// ---------------------------------------------------------------------------
// (a) must be a LINKED worktree of DEVHARNESS_SRC
// ---------------------------------------------------------------------------

test("validateAdoptedWorktree (a): a path that does not exist is refused", () => {
  const fx = fixture();
  const e = refusal(() => validate(fx, { worktreePath: join(fx.wt, "nope") }));
  assert.match(e.message, /does not exist/);
});

test("validateAdoptedWorktree (a): a directory that is not a git worktree is refused", () => {
  const fx = fixture();
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "dr-wt-plain-")));
  const e = refusal(() => validate(fx, { worktreePath: plain }));
  assert.match(e.message, /not inside a git worktree/);
});

test("validateAdoptedWorktree (a): the main checkout itself is refused", () => {
  const fx = fixture();
  const e = refusal(() => validate(fx, { worktreePath: fx.repo }));
  assert.match(e.message, /main checkout/);
});

test("validateAdoptedWorktree (a): a worktree of a DIFFERENT repo is refused", () => {
  const fx = fixture();
  const other = makeRepo();
  const foreign = addWorktree(other, "feat/foreign");
  const e = refusal(() => validate(fx, { worktreePath: foreign }));
  assert.match(e.message, /not a linked worktree of DEVHARNESS_SRC/);
});

test("validateAdoptedWorktree (a): a subdirectory of a worktree is refused (must be the worktree root)", () => {
  const fx = fixture();
  mkdirSync(join(fx.wt, "sub"));
  const e = refusal(() => validate(fx, { worktreePath: join(fx.wt, "sub") }));
  assert.match(e.message, /worktree root/);
});

// ---------------------------------------------------------------------------
// (b) on a branch, and not the base branch
// ---------------------------------------------------------------------------

test("validateAdoptedWorktree (b): detached HEAD is refused", () => {
  const fx = fixture();
  git(fx.wt, "checkout", "-q", "--detach");
  const e = refusal(() => validate(fx));
  assert.match(e.message, /HEAD is detached/);
});

test("validateAdoptedWorktree (b): the worktree's branch equal to the base branch is refused", () => {
  const fx = fixture("release/1.x");
  // base_branch resolves (it is this very branch) — only the equality is wrong.
  const e = refusal(() => validate(fx, { baseBranch: "release/1.x" }));
  assert.match(e.message, /is the run's base branch/);
});

// ---------------------------------------------------------------------------
// (c) no tracked modifications / staged changes
// ---------------------------------------------------------------------------

test("validateAdoptedWorktree (c): a tracked modification is refused", () => {
  const fx = fixture();
  writeFileSync(join(fx.wt, "a.txt"), "changed\n");
  const e = refusal(() => validate(fx));
  assert.match(e.message, /uncommitted changes to tracked files/);
  assert.match(e.message, /a\.txt/);
});

test("validateAdoptedWorktree (c): a staged new file is refused", () => {
  const fx = fixture();
  writeFileSync(join(fx.wt, "new.txt"), "x\n");
  git(fx.wt, "add", "new.txt");
  const e = refusal(() => validate(fx));
  assert.match(e.message, /uncommitted changes to tracked files/);
});

test("validateAdoptedWorktree (c): a skip-worktree .tool-versions edit (dagrunner's own seed) does not count as dirty", () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, ".tool-versions"), "helm 3.0.0\n");
  git(fx.repo, "add", ".tool-versions");
  git(fx.repo, "commit", "-q", "-m", "tv");
  git(fx.wt, "merge", "-q", "main");
  writeFileSync(join(fx.wt, ".tool-versions"), "helm 3.0.0\njava x\n");
  git(fx.wt, "update-index", "--skip-worktree", ".tool-versions");
  assert.equal(validate(fx).branch, "feat/adopt-me");
});

// ---------------------------------------------------------------------------
// (d) base branch resolves in DEVHARNESS_SRC
// ---------------------------------------------------------------------------

test("validateAdoptedWorktree (d): a base branch that does not resolve is refused", () => {
  const fx = fixture();
  const e = refusal(() => validate(fx, { baseBranch: "release/9.9" }));
  assert.match(
    e.message,
    /base_branch "release\/9\.9" not found in DEVHARNESS_SRC/,
  );
});

// ---------------------------------------------------------------------------
// (e) no other non-terminal run on this worktree
// ---------------------------------------------------------------------------

test("validateAdoptedWorktree (e): a running/paused/failed run on the same worktree blocks adoption", () => {
  for (const status of ["running", "paused", "failed"]) {
    const fx = fixture();
    writeRun(fx.home, "42-1", fx.wt, status);
    const e = refusal(() => validate(fx));
    assert.match(e.message, /run "42-1" \(status: /, status);
    assert.match(e.message, /dagrun abort 42-1/, status);
    assert.match(e.message, /dagrun rerun/, status);
  }
});

test("validateAdoptedWorktree (e): done and aborted runs on the same worktree do not block it", () => {
  for (const status of ["done", "aborted"]) {
    const fx = fixture();
    writeRun(fx.home, "42-1", fx.wt, status);
    assert.equal(validate(fx).branch, "feat/adopt-me", status);
  }
});

test("validateAdoptedWorktree (e): a non-terminal run on a DIFFERENT worktree does not block", () => {
  const fx = fixture();
  writeRun(fx.home, "42-1", join(fx.home, "somewhere-else"), "paused");
  assert.equal(validate(fx).branch, "feat/adopt-me");
});

test("validateAdoptedWorktree (e): the match is by realpath (state recorded through a symlink still blocks)", () => {
  const fx = fixture();
  const link = join(tmpdir(), `dr-wt-link2-${String(Date.now())}`);
  symlinkSync(fx.wt, link);
  writeRun(fx.home, "42-1", link, "paused");
  refusal(() => validate(fx));
});

test("validateAdoptedWorktree (e): an unreadable state.json of another run is skipped, not fatal", () => {
  const fx = fixture();
  mkdirSync(join(fx.home, "runs", "broken"), { recursive: true });
  writeFileSync(join(fx.home, "runs", "broken", "state.json"), "{not json");
  mkdirSync(join(fx.home, "runs", "no-state-yet"), { recursive: true }); // a --detach pre-claimed dir
  assert.equal(validate(fx).branch, "feat/adopt-me");
});

test("validateAdoptedWorktree: every cause has its own message", () => {
  const fx = fixture();
  const seen = new Set<string>();
  const add = (fn: () => unknown) =>
    seen.add(refusal(fn).message.replace(/"[^"]*"/g, '""'));
  add(() => validate(fx, { worktreePath: join(fx.wt, "nope") }));
  add(() => validate(fx, { worktreePath: fx.repo }));
  add(() => validate(fx, { baseBranch: "release/9.9" }));
  writeFileSync(join(fx.wt, "a.txt"), "changed\n");
  add(() => validate(fx));
  assert.equal(seen.size, 4);
});

// ---------------------------------------------------------------------------
// resolveWorktreeArg — the CLI's --worktree default
// ---------------------------------------------------------------------------

test("resolveWorktreeArg: no flag → the git toplevel of cwd (from a subdirectory too)", () => {
  const fx = fixture();
  mkdirSync(join(fx.wt, "deep", "er"), { recursive: true });
  assert.equal(resolveWorktreeArg(undefined, join(fx.wt, "deep", "er")), fx.wt);
});

test("resolveWorktreeArg: no flag and cwd outside any git repo → fails loud, naming --worktree", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "dr-wt-outside-")));
  assert.throws(
    () => resolveWorktreeArg(undefined, outside),
    (e: unknown) =>
      e instanceof WorktreeAdoptionError &&
      /not inside a git repository/.test(e.message) &&
      /--worktree/.test(e.message),
  );
});

test("resolveWorktreeArg: an explicit flag is taken verbatim, relative to cwd, with no cwd fallback", () => {
  const fx = fixture();
  assert.equal(resolveWorktreeArg(fx.wt, "/"), fx.wt);
  assert.equal(
    resolveWorktreeArg("rel/wt", "/some/where"),
    "/some/where/rel/wt",
  );
});
