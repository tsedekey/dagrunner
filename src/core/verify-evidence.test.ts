import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvidence, gitDirtyPaths, normalizeDirty, validateVerifyReport } from "./verify-evidence.js";
import type { Node } from "./types.js";

const wt = { head: "abc123", dirty: ["src/Fix.java", "src/FixTest.java"] };

const good = () => ({
  schemaVersion: 2,
  outcome: "DEMONSTRATED",
  capability: "docker-compose",
  target: { kind: "local-disposable", host: "localhost", ownedResources: ["dagrun-r-es"] },
  candidate: {
    sourceRevision: "abc123",
    dirtyFiles: ["src/FixTest.java", "src/Fix.java"],
    builtFromWorktree: true,
    artifact: "target/camunda.tar.gz",
    artifactIdentity: "sha256:1234",
  },
  observations: [
    { kind: "baseline", command: "curl base", result: "500" },
    { kind: "candidate", command: "curl cand", result: "200" },
  ],
  cleanup: { status: "clean", leftovers: [] },
  demoFile: "demo.md",
});

const bad = (mutate: (r: ReturnType<typeof good>) => void) => {
  const r = good();
  mutate(r);
  return validateVerifyReport(r, wt);
};

test("a fully-backed DEMONSTRATED report passes (dirty list order-insensitive)", () => {
  assert.deepEqual(validateVerifyReport(good(), wt), { ok: true });
});

test("stock-release-only evidence can never demonstrate an unbuilt patch", () => {
  const r = bad((x) => { x.candidate.builtFromWorktree = false; });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /builtFromWorktree/);
});

test("baseline-only observations do not demonstrate the fix", () => {
  const r = bad((x) => { x.observations = [{ kind: "baseline", command: "c", result: "r" }]; });
  assert.match((r as { error: string }).error, /no candidate observation/);
});

test("evidence for a different revision is rejected", () => {
  const r = bad((x) => { x.candidate.sourceRevision = "zzz999"; });
  assert.match((r as { error: string }).error, /different revision/);
});

test("dirtyFiles must match the worktree now (catches a verifier that edited files)", () => {
  const r = bad((x) => { x.candidate.dirtyFiles = ["src/Fix.java"]; });
  assert.match((r as { error: string }).error, /dirtyFiles does not match/);
});

test("non-loopback / ambient targets are rejected", () => {
  for (const host of ["prod.example.com", "10.0.0.5", ""]) {
    const r = bad((x) => { x.target.host = host; });
    assert.equal(r.ok, false, host);
  }
  for (const host of ["localhost", "127.0.0.1", "::1"]) {
    assert.equal(bad((x) => { x.target.host = host; }).ok, true, host);
  }
});

test("non-disposable target kind, missing identity, failed cleanup, missing demo file are rejected", () => {
  assert.equal(bad((x) => { (x.target as { kind: string }).kind = "shared"; }).ok, false);
  assert.equal(bad((x) => { x.candidate.artifactIdentity = ""; }).ok, false);
  assert.equal(bad((x) => { (x.cleanup as { status: string }).status = "failed"; }).ok, false);
  assert.equal(bad((x) => { x.demoFile = ""; }).ok, false);
  assert.equal(bad((x) => { x.capability = "kubectl"; }).ok, false);
});

test("leftovers are allowed (reported honestly), not a failure", () => {
  assert.equal(bad((x) => { (x.cleanup as { status: string }).status = "leftovers"; }).ok, true);
});

test("legacy/other schema and unknown outcomes are refused; non-pass outcomes need a reason", () => {
  assert.equal(validateVerifyReport({ ...good(), schemaVersion: 1 }, wt).ok, false);
  assert.equal(validateVerifyReport({ ...good(), outcome: "PASS" }, wt).ok, false);
  assert.equal(validateVerifyReport({ schemaVersion: 2, outcome: "BLOCKED_RUNTIME" }, wt).ok, false);
  assert.equal(validateVerifyReport({ schemaVersion: 2, outcome: "BLOCKED_RUNTIME", reason: "docker denied" }, wt).ok, true);
  assert.equal(validateVerifyReport("nope", wt).ok, false);
});

test("checkEvidence: no-op without evidenceCheck; fails loud on missing/garbled file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  mkdirSync(join(dir, "verify"));
  const node: Node = { id: "verify", command: "/verify", evidenceCheck: "verify-runtime", outcomeGate: { file: "verify-report.json", field: "outcome", passValues: ["DEMONSTRATED"] } };
  assert.deepEqual(checkEvidence(dir, "verify", { id: "verify", command: "/verify" }, wt), { ok: true });
  assert.equal(checkEvidence(dir, "verify", node, wt).ok, false);
  writeFileSync(join(dir, "verify", "verify-report.json"), "{garbled");
  assert.match((checkEvidence(dir, "verify", node, wt) as { error: string }).error, /unreadable/);
  writeFileSync(join(dir, "verify", "verify-report.json"), JSON.stringify(good()));
  assert.deepEqual(checkEvidence(dir, "verify", node, wt), { ok: true });
});

test("dirtyFiles: porcelain-prefixed reported lines match the bare-path live list (59478-2 format mismatch)", () => {
  const r = bad((x) => { x.candidate.dirtyFiles = [" M src/Fix.java", "A  src/FixTest.java"]; });
  assert.deepEqual(r, { ok: true });
});

test("dirtyFiles: node_modules / untracked-dir noise on either side is ignored (59478-2 race)", () => {
  const live = { head: "abc123", dirty: ["src/Fix.java", "src/FixTest.java", "webapp/client/node_modules", "testing/x/node_modules/a/b.js"] };
  const r = good();
  r.candidate.dirtyFiles = ["?? webapp/", "?? testing/x/", " M src/Fix.java", "M  src/FixTest.java"];
  assert.deepEqual(validateVerifyReport(r, live), { ok: true });
});

test("dirtyFiles: real differences still fail (edited, extra untracked source, missing) and name the paths", () => {
  const extra = validateVerifyReport(good(), { head: "abc123", dirty: ["src/Fix.java", "src/FixTest.java", "src/Scratch.java"] });
  assert.match((extra as { error: string }).error, /unreported: \["src\/Scratch.java"\]/);
  const swapped = bad((x) => { x.candidate.dirtyFiles = ["src/Fix.java", "src/Other.java"]; });
  assert.match((swapped as { error: string }).error, /does not match/);
  // a path that merely contains "node_modules" as a substring is NOT noise
  assert.deepEqual(normalizeDirty(["src/my_node_modules_x/a.ts"]), ["src/my_node_modules_x/a.ts"]);
});

test("normalizeDirty: renames keep the new path; quotes stripped; both forms equal", () => {
  assert.deepEqual(normalizeDirty(["R  old.ts -> new.ts", '?? "sp ace.ts"']), ["new.ts", "sp ace.ts"]);
});

test("gitDirtyPaths returns normalized bare paths and skips node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  mkdirSync(join(dir, "node_modules", "p"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "p", "i.js"), "x");
  writeFileSync(join(dir, "a.txt"), "x");
  assert.deepEqual(gitDirtyPaths(dir), ["a.txt"]);
});

test("capability source requires a sourceRationale; runtime capabilities do not", () => {
  const src = bad((x) => { x.capability = "source"; });
  assert.match((src as { error: string }).error, /sourceRationale/);
  const ok = good() as Record<string, unknown>;
  ok["capability"] = "source";
  ok["sourceRationale"] = "pure library change; no runtime surface to seed";
  assert.deepEqual(validateVerifyReport(ok, wt), { ok: true });
});
