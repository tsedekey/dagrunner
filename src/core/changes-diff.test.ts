import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DIFF_BYTES, renderChangesDiff, writeChangesDiff } from "./changes-diff.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

/** repo with `main` and a feature branch that has 1 commit + tracked edit + untracked files. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "dr-diff-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "one\n");
  git(d, "add", "."); git(d, "commit", "-qm", "init");
  git(d, "checkout", "-qb", "feat");
  writeFileSync(join(d, "b.txt"), "committed\n");
  git(d, "add", "."); git(d, "commit", "-qm", "c1");
  writeFileSync(join(d, "a.txt"), "one\ntwo\n"); // tracked, unstaged
  writeFileSync(join(d, "new.txt"), "brand new\n"); // untracked
  mkdirSync(join(d, "node_modules", "x"), { recursive: true });
  writeFileSync(join(d, "node_modules", "x", "i.js"), "junk\n");
  return d;
}

test("diff covers committed + unstaged + untracked, excludes node_modules, leaves index/worktree untouched", () => {
  const d = repo();
  const before = git(d, "status", "--porcelain", "-uall");
  const out = join(d, "..", `out-${Date.now()}`, "changes.diff");
  const r = writeChangesDiff({ worktreePath: d, baseBranch: "main", outFile: out });
  assert.equal(r.truncated, false);
  const txt = readFileSync(out, "utf8");
  assert.match(txt, /b\.txt/);
  assert.match(txt, /\+two/);
  assert.match(txt, /new file mode[\s\S]*\+brand new/);
  assert.doesNotMatch(txt, /node_modules/);
  assert.equal(git(d, "status", "--porcelain", "-uall"), before, "index/worktree unchanged");
  assert.equal(git(d, "diff", "--cached", "--name-only"), "", "nothing staged");
});

test("prefers origin/<base> merge-base, falls back to local <base>, fails loud when neither exists", () => {
  const d = repo();
  assert.match(renderChangesDiff({ worktreePath: d, baseBranch: "main" }).text, /b\.txt/);
  assert.throws(() => renderChangesDiff({ worktreePath: d, baseBranch: "release/9.9" }), /release\/9\.9/);
});

test("a diff failure throws from render and write never leaves a partial file", () => {
  const d = repo();
  const out = join(d, "..", `o2-${Date.now()}`, "changes.diff");
  assert.throws(() => writeChangesDiff({ worktreePath: d, baseBranch: "nope", outFile: out }));
  assert.equal(existsSync(out), false);
});

test("output is capped with a clear truncation marker", () => {
  const d = repo();
  writeFileSync(join(d, "big.txt"), "x".repeat(MAX_DIFF_BYTES + 5000) + "\n");
  const out = join(d, "..", `o3-${Date.now()}`, "changes.diff");
  const r = writeChangesDiff({ worktreePath: d, baseBranch: "main", outFile: out });
  assert.equal(r.truncated, true);
  const txt = readFileSync(out, "utf8");
  assert.match(txt, /\[dagrun: changes\.diff truncated at \d+ bytes/);
  assert.ok(Buffer.byteLength(txt) < MAX_DIFF_BYTES + 1000);
});
