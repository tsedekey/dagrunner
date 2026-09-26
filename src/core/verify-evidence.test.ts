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
  schemaVersion: 3,
  run_id: "r",
  outcome: "PROVISIONED",
  capability: "docker-compose",
  target: {
    kind: "local-disposable",
    host: "localhost",
    port: 18080,
    ownedResources: [
      { kind: "container", name: "dagrun-r-camunda" },
      { kind: "network", name: "dagrun-r-net" },
      { kind: "image", name: "dagrun-r-camunda:latest" },
    ],
  },
  candidate: {
    sourceRevision: "abc123",
    dirtyFiles: ["src/FixTest.java", "src/Fix.java"],
    builtFromWorktree: true,
    artifact: "target/camunda.tar.gz",
    artifactIdentity: "sha256:1234",
  },
  readiness: { command: "curl -s localhost:18080/actuator/health", result: '{"status":"UP"}' },
  teardown: { status: "pending" },
  demoFile: "demo.md",
});

const bad = (mutate: (r: ReturnType<typeof good>) => void) => {
  const r = good();
  mutate(r);
  return validateVerifyReport(r, wt);
};

test("a fully-backed PROVISIONED report passes (dirty list order-insensitive)", () => {
  assert.deepEqual(validateVerifyReport(good(), wt), { ok: true });
  assert.deepEqual(validateVerifyReport(good(), wt, "r"), { ok: true });
});

test("the old verdict outcomes and schema 2 are refused (the node no longer renders a verdict)", () => {
  assert.equal(bad((x) => { x.outcome = "DEMONSTRATED"; }).ok, false);
  assert.equal(bad((x) => { x.outcome = "NOT_DEMONSTRATED"; }).ok, false);
  assert.equal(validateVerifyReport({ ...good(), schemaVersion: 2 }, wt).ok, false);
});

test("empty ownedResources is rejected for a runtime capability", () => {
  const r = bad((x) => { x.target.ownedResources = []; });
  assert.match((r as { error: string }).error, /ownedResources must be non-empty/);
});

test("ownedResources without the dagrun-<run-id>- prefix (or of another run) are rejected", () => {
  const foreign = bad((x) => { x.target.ownedResources.push({ kind: "container", name: "postgres" }); });
  assert.match((foreign as { error: string }).error, /ownership prefix/);
  const otherRun = bad((x) => { x.target.ownedResources.push({ kind: "network", name: "dagrun-r2-net" }); });
  assert.equal(otherRun.ok, false);
  // engine's run id wins over the report's self-report
  assert.equal(validateVerifyReport(good(), wt, "other").ok, false);
  // trailing dash matters: run "r" must not claim "dagrun-rx-..."
  assert.equal(bad((x) => { x.target.ownedResources[0] = { kind: "container", name: "dagrun-rx-c" }; }).ok, false);
  // untyped free-text entries (v2 shape) are refused
  assert.equal(bad((x) => { (x.target.ownedResources as unknown[])[0] = "dagrun-r-es"; }).ok, false);
});

test("tempdir resources are checked on their basename", () => {
  assert.equal(bad((x) => { x.target.ownedResources.push({ kind: "tempdir", name: "/tmp/dagrun-r-data" }); }).ok, true);
  assert.equal(bad((x) => { x.target.ownedResources.push({ kind: "tempdir", name: "/tmp/dagrun-r-x/other" }); }).ok, false);
});

test("readiness evidence and host port are required (an unreachable env is not PROVISIONED)", () => {
  assert.match((bad((x) => { delete (x as Record<string, unknown>)["readiness"]; }) as { error: string }).error, /readiness/);
  assert.equal(bad((x) => { x.readiness.result = ""; }).ok, false);
  assert.equal(bad((x) => { delete (x.target as Record<string, unknown>)["port"]; }).ok, false);
});

test("teardown must be pending at provision time (the node never tears down)", () => {
  assert.equal(bad((x) => { x.teardown.status = "clean"; }).ok, false);
  assert.equal(bad((x) => { delete (x as Record<string, unknown>)["teardown"]; }).ok, false);
});

test("stock-release-only evidence can never stand in for an unbuilt patch", () => {
  const r = bad((x) => { x.candidate.builtFromWorktree = false; });
  assert.match((r as { error: string }).error, /builtFromWorktree/);
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

test("non-disposable target kind, missing identity, missing demo file, unknown capability are rejected", () => {
  assert.equal(bad((x) => { (x.target as { kind: string }).kind = "shared"; }).ok, false);
  assert.equal(bad((x) => { x.candidate.artifactIdentity = ""; }).ok, false);
  assert.equal(bad((x) => { x.demoFile = ""; }).ok, false);
  assert.equal(bad((x) => { x.capability = "kubectl"; }).ok, false);
});

test("unknown outcomes are refused; BLOCKED_RUNTIME needs a reason and still fails the node (outcomeGate)", () => {
  assert.equal(validateVerifyReport({ ...good(), outcome: "PASS" }, wt).ok, false);
  assert.equal(validateVerifyReport({ schemaVersion: 3, outcome: "BLOCKED_RUNTIME" }, wt).ok, false);
  assert.equal(validateVerifyReport({ schemaVersion: 3, outcome: "BLOCKED_RUNTIME", reason: "docker denied" }, wt).ok, true);
  assert.equal(validateVerifyReport("nope", wt).ok, false);
});

test("checkEvidence: no-op without evidenceCheck; fails loud on missing/garbled file; uses the run dir name as run id", () => {
  const root = mkdtempSync(join(tmpdir(), "ev-"));
  const dir = join(root, "r");
  mkdirSync(join(dir, "verify"), { recursive: true });
  const node: Node = { id: "verify", command: "/verify", evidenceCheck: "verify-runtime", outcomeGate: { file: "verify-report.json", field: "outcome", passValues: ["PROVISIONED"] } };
  assert.deepEqual(checkEvidence(dir, "verify", { id: "verify", command: "/verify" }, wt), { ok: true });
  assert.equal(checkEvidence(dir, "verify", node, wt).ok, false);
  writeFileSync(join(dir, "verify", "verify-report.json"), "{garbled");
  assert.match((checkEvidence(dir, "verify", node, wt) as { error: string }).error, /unreadable/);
  writeFileSync(join(dir, "verify", "verify-report.json"), JSON.stringify(good()));
  assert.deepEqual(checkEvidence(dir, "verify", node, wt), { ok: true });
  const wrong = join(root, "other");
  mkdirSync(join(wrong, "verify"), { recursive: true });
  writeFileSync(join(wrong, "verify", "verify-report.json"), JSON.stringify(good()));
  assert.equal(checkEvidence(wrong, "verify", node, wt).ok, false);
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

test("capability source requires a sourceRationale, no ownedResources, and teardown not-applicable; no readiness needed", () => {
  const src = bad((x) => { x.capability = "source"; });
  assert.match((src as { error: string }).error, /sourceRationale/);
  const ok = good() as Record<string, unknown>;
  ok["capability"] = "source";
  ok["sourceRationale"] = "pure library change; no runtime surface to seed";
  ok["target"] = { kind: "local-disposable", host: "localhost", ownedResources: [] };
  delete ok["readiness"];
  ok["teardown"] = { status: "not-applicable" };
  assert.deepEqual(validateVerifyReport(ok, wt), { ok: true });
  ok["teardown"] = { status: "pending" };
  assert.equal(validateVerifyReport(ok, wt).ok, false);
});
