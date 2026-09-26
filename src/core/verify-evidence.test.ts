import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvidence, validateVerifyReport } from "./verify-evidence.js";
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
