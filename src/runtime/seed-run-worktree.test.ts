/**
 * seed-run-worktree.test.ts — the post-adoption seeding is applied to a worktree
 * that ALREADY exists (and may have been seeded by an earlier run), so every
 * step must be idempotent: a second application errors nowhere, warns about
 * nothing, and leaves the worktree byte-identical.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { seedRunWorktree } from "./run-engine.js";

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

const DAGRUNNER_ROOT = new URL("../../", import.meta.url).pathname;

/** Capture stderr while running fn (seed helpers are fail-soft: a failure is only a warning). */
function captureStderr(fn: () => void): string {
  const real = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((s: string | Uint8Array) => {
    out += String(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = real;
  }
  return out;
}

/** All files under dir → their content (relative path keyed), symlinks as "-> target". */
function snapshot(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out[r] = `-> ${realpathSync.native(join(dir, r))}`;
    else if (st.isDirectory()) Object.assign(out, snapshot(dir, r));
    else out[r] = readFileSync(join(dir, r), "utf8");
  }
  return out;
}

test("seedRunWorktree: applying the full seed twice to one adopted worktree is a no-op the second time", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "dr-seed-repo-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".tool-versions"), "helm 3.0.0\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  // A frontend node_modules the worktree gets symlinked to.
  mkdirSync(join(repo, "ui", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "ui", "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(repo, "ui", "package.json"), "{}");
  git(repo, "add", "ui/package.json"); // node_modules itself stays untracked

  const wtParent = realpathSync(mkdtempSync(join(tmpdir(), "dr-seed-wt-")));
  const wt = join(wtParent, "feat-seed");
  git(repo, "worktree", "add", "-q", wt, "-b", "feat/seed", "main");

  const home = mkdtempSync(join(tmpdir(), "dr-seed-home-"));
  const runDir = join(home, "runs", "1-1");
  mkdirSync(runDir, { recursive: true });
  const claudeConfigDir = mkdtempSync(join(tmpdir(), "dr-seed-claude-"));

  const seed = () =>
    seedRunWorktree({
      worktreePath: wt,
      runDir,
      homeDir: home,
      config: { DEVHARNESS_SRC: repo, claudeConfigDir },
      dagrunnerRoot: DAGRUNNER_ROOT,
    });

  const warn1 = captureStderr(seed);
  assert.equal(warn1, "", `first seed must be silent, got: ${warn1}`);
  const after1 = snapshot(wt);
  const exclude1 = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");

  // Sanity: the first pass really seeded everything.
  assert.ok(
    after1[".claude/settings.json"] !== undefined,
    "settings.json seeded",
  );
  assert.ok(
    Object.keys(after1).some((k) => k.startsWith(".claude/commands/")),
    "commands seeded",
  );
  assert.ok(
    Object.keys(after1).some((k) => k.startsWith(".claude/hooks/")),
    "hooks seeded",
  );
  assert.ok(
    Object.keys(after1).some((k) => k.startsWith(".claude/agents/")),
    "agents seeded",
  );
  assert.match(
    after1[".tool-versions"] ?? "",
    /^helm 3\.0\.0\njava .*\nmaven 3\.9\.9\n$/,
  );
  assert.match(after1["ui/node_modules"] ?? "", /^-> .*ui\/node_modules$/);
  assert.equal(
    git(wt, "status", "--porcelain", "--untracked-files=no"),
    "",
    "seeded .tool-versions stays invisible (skip-worktree)",
  );

  const warn2 = captureStderr(seed);
  assert.equal(warn2, "", `second seed must be silent, got: ${warn2}`);
  assert.deepEqual(
    snapshot(wt),
    after1,
    "second seed changes nothing in the worktree",
  );
  assert.equal(
    readFileSync(join(repo, ".git", "info", "exclude"), "utf8"),
    exclude1,
    "exclude block is not appended twice",
  );
  assert.equal(
    exclude1.split("# dagrunner artifact backstop").length - 1,
    1,
    "exactly one dagrunner block in info/exclude",
  );
  assert.equal(git(wt, "status", "--porcelain", "--untracked-files=no"), "");
});

test("seedRunWorktree: a node_modules symlink left dangling by an earlier seeding does not abort the rest", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "dr-seed-repo-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".tool-versions"), "helm 3.0.0\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  mkdirSync(join(repo, "node_modules", "p"), { recursive: true });
  mkdirSync(join(repo, "ui", "node_modules", "p"), { recursive: true });

  const wt = join(
    realpathSync(mkdtempSync(join(tmpdir(), "dr-seed-wt-"))),
    "w",
  );
  git(repo, "worktree", "add", "-q", wt, "-b", "feat/dangling", "main");
  symlinkSync(
    join(tmpdir(), "dr-gone-target-does-not-exist"),
    join(wt, "node_modules"),
  );

  const home = mkdtempSync(join(tmpdir(), "dr-seed-home-"));
  const runDir = join(home, "runs", "1-1");
  mkdirSync(runDir, { recursive: true });
  const warn = captureStderr(() =>
    seedRunWorktree({
      worktreePath: wt,
      runDir,
      homeDir: home,
      config: {
        DEVHARNESS_SRC: repo,
        claudeConfigDir: mkdtempSync(join(tmpdir(), "dr-seed-claude-")),
      },
      dagrunnerRoot: DAGRUNNER_ROOT,
    }),
  );
  assert.equal(warn, "", `no warning expected, got: ${warn}`);
  assert.ok(
    lstatSync(join(wt, "ui", "node_modules")).isSymbolicLink(),
    "the later node_modules dir was still seeded",
  );
});
