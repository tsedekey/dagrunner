/**
 * deliverables.test.ts — pre-PR manifest check: compare what the worktree
 * actually changed (vs the run's base) with the union of implement/ + fix/
 * deliverables.txt. Run 51496-1: a test file the fix node added was missing
 * from every manifest, pr staged declared paths only, and it was silently left
 * out of the first commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compareDeliverables, deliverablesAdvisory, parseManifest, readManifestUnion } from "./deliverables.js";
import { buildGateBrief } from "./gate.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import type { RunState } from "./state.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
}
function put(root: string, rel: string, body = "x\n"): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** main has base.txt; branch `feat` is checked out. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "dr-deliv-"));
  git(root, "init", "-q", "-b", "main");
  put(root, "base.txt");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feat");
  return root;
}

test("parseManifest: trims, drops blanks and duplicates", () => {
  assert.deepEqual(parseManifest("a/b.java\n\n  c.txt  \na/b.java\r\n"), ["a/b.java", "c.txt"]);
});

test("listed + changed (committed, staged, untracked) → clean", () => {
  const r = repo();
  put(r, "src/Committed.java");
  git(r, "add", "-A");
  git(r, "commit", "-q", "-m", "c");
  put(r, "src/Staged.java");
  git(r, "add", "src/Staged.java");
  put(r, "src/Untracked.java");
  put(r, "base.txt", "modified\n");
  const res = compareDeliverables({
    worktreePath: r,
    baseBranch: "main",
    manifest: ["src/Committed.java", "src/Staged.java", "src/Untracked.java", "base.txt"],
  });
  assert.deepEqual(res.unlisted, []);
  assert.deepEqual(res.unchanged, []);
  assert.deepEqual([...res.changed].sort(), ["base.txt", "src/Committed.java", "src/Staged.java", "src/Untracked.java"]);
});

test("changed but unlisted → flagged (the MultiInstanceCallActivityTest case)", () => {
  const r = repo();
  put(r, "src/Listed.java");
  put(r, "src/test/MultiInstanceCallActivityTest.java");
  const res = compareDeliverables({ worktreePath: r, baseBranch: "main", manifest: ["src/Listed.java"] });
  assert.deepEqual(res.unlisted, ["src/test/MultiInstanceCallActivityTest.java"]);
  assert.deepEqual(res.unchanged, []);
});

test("listed but unchanged → flagged", () => {
  const r = repo();
  put(r, "src/Real.java");
  const res = compareDeliverables({ worktreePath: r, baseBranch: "main", manifest: ["src/Real.java", "src/Ghost.java"] });
  assert.deepEqual(res.unchanged, ["src/Ghost.java"]);
  assert.deepEqual(res.unlisted, []);
});

test("ignored files, target/ output, node_modules and skip-worktree edits are not counted", () => {
  const r = repo();
  put(r, ".tool-versions", "java 21\n");
  git(r, "add", ".tool-versions");
  git(r, "commit", "-q", "-m", "tv on feat");
  git(r, "checkout", "-q", "main");
  git(r, "merge", "-q", "--ff-only", "feat");
  git(r, "checkout", "-q", "-b", "feat2");
  git(r, "update-index", "--skip-worktree", ".tool-versions");
  put(r, ".tool-versions", "java 21\nmaven 3\n"); // seeded edit, hidden by skip-worktree
  writeFileSync(join(r, ".git", "info", "exclude"), "ignored.log\n**/target/\n");
  put(r, "ignored.log");
  put(r, "mod/target/classes/Foo.class");
  put(r, "web/node_modules/pkg/index.js");
  put(r, "src/Real.java");
  const res = compareDeliverables({ worktreePath: r, baseBranch: "main", manifest: ["src/Real.java"] });
  assert.deepEqual(res.changed, ["src/Real.java"]);
  assert.deepEqual(res.unlisted, []);
  assert.deepEqual(res.unchanged, []);
});

test("a TRACKED target/ file is still excluded (build output is never a deliverable)", () => {
  const r = repo();
  put(r, "mod/target/classes/Foo.class");
  git(r, "add", "-f", "mod/target/classes/Foo.class");
  put(r, "src/Real.java");
  const res = compareDeliverables({ worktreePath: r, baseBranch: "main", manifest: ["src/Real.java"] });
  assert.deepEqual(res.changed, ["src/Real.java"]);
});

test("unresolvable base throws (caller decides how to surface — never a silent pass)", () => {
  const r = repo();
  assert.throws(() => compareDeliverables({ worktreePath: r, baseBranch: "nope", manifest: [] }), /cannot compute a diff base/);
});

test("readManifestUnion: unions implement/ and fix/ deliverables.txt; absent files are fine; null when neither exists", () => {
  const run = mkdtempSync(join(tmpdir(), "dr-deliv-run-"));
  assert.equal(readManifestUnion(run), null);
  put(run, "implement/deliverables.txt", "a.java\nb.java\n");
  assert.deepEqual(readManifestUnion(run), ["a.java", "b.java"]);
  put(run, "fix/deliverables.txt", "b.java\nc.java\n");
  assert.deepEqual(readManifestUnion(run), ["a.java", "b.java", "c.java"]);
});

test("deliverablesAdvisory: names every unlisted and every unchanged path; clean → one ok entry; no manifest → none", () => {
  const r = repo();
  const run = mkdtempSync(join(tmpdir(), "dr-deliv-run-"));
  const st = { worktreePath: r, baseBranch: "main" };
  assert.deepEqual(deliverablesAdvisory(run, st), [], "no manifest → nothing to compare");

  put(r, "src/Listed.java");
  put(r, "src/test/Forgotten.java");
  put(run, "implement/deliverables.txt", "src/Listed.java\nsrc/Ghost.java\n");
  const bad = deliverablesAdvisory(run, st);
  assert.deepEqual(bad.map((c) => [c.check, c.ok]), [["deliverables-unlisted", false], ["deliverables-unchanged", false]]);
  assert.match(bad[0]!.detail!, /src\/test\/Forgotten\.java/);
  assert.match(bad[1]!.detail!, /src\/Ghost\.java/);

  put(run, "fix/deliverables.txt", "src/test/Forgotten.java\n");
  put(r, "src/Ghost.java");
  assert.deepEqual(deliverablesAdvisory(run, st), [{ nodeId: "pr", check: "deliverables-manifest", ok: true }]);
});

test("deliverablesAdvisory: an unresolvable base is a visible failed entry, not a silent pass", () => {
  const r = repo();
  const run = mkdtempSync(join(tmpdir(), "dr-deliv-run-"));
  put(run, "fix/deliverables.txt", "a\n");
  const out = deliverablesAdvisory(run, { worktreePath: r, baseBranch: "nope" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ok, false);
  assert.match(out[0]!.detail!, /could not compare/);
});

test("buildGateBrief: the pr gate carries the advisory (and it never changes the revision); other gates do not", () => {
  const r = repo();
  const run = mkdtempSync(join(tmpdir(), "dr-deliv-run-"));
  put(r, "src/Forgotten.java");
  put(run, "fix/deliverables.txt", "src/Other.java\n");
  const node = (status: "done" | "awaiting-gate") => ({ status, artifacts: [], iteration: 0, cost: 0, gateHistory: [] });
  const st: RunState = {
    runId: "r", workflow: "bugfix", createdAt: "T", updatedAt: "T", status: "paused",
    worktreePath: r, branch: "feat", sourcePlanPath: "/p", baseBranch: "main",
    nodes: { reproduce: node("done"), implement: node("done"), review: node("done"), fix: node("done"), pr: node("awaiting-gate") },
  };
  const build = (gate: string) => buildGateBrief({ runDir: run, state: st, workflow: bugfixWorkflow, gateNodeId: gate, configDirs: [] });
  const pr = build("pr");
  const checks = pr.validation.filter((v) => v.check.startsWith("deliverables-"));
  assert.deepEqual(checks.map((c) => c.check), ["deliverables-unlisted", "deliverables-unchanged"]);
  assert.match(checks[0]!.detail!, /src\/Forgotten\.java/);
  assert.equal(build("fix").validation.some((v) => v.check.startsWith("deliverables-")), false);
  // advisory content must not feed the revision hash
  put(r, "src/AnotherStray.java");
  assert.equal(build("pr").revision, pr.revision);
});

test("payload/commands/fix.md carries the deliverables contract (declare, extend across rounds, verify against git)", () => {
  const md = readFileSync(new URL("../../payload/commands/fix.md", import.meta.url), "utf8");
  assert.match(md, /Declare deliverables/);
  assert.match(md, /fix\/deliverables\.txt/);
  assert.match(md, /implement\/deliverables\.txt/);
  assert.match(md, /extend/i);
  assert.match(md, /git status --porcelain/);
  assert.match(md, /git diff --name-only/);
  // pr.md's reader of the same files must stay in sync with what fix.md tells the node to write
  const pr = readFileSync(new URL("../../payload/commands/pr.md", import.meta.url), "utf8");
  assert.match(pr, /fix\/deliverables\.txt/);
});
