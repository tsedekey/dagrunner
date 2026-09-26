import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVerifyEnvs, pendingVerifyEnvs, teardownRun, type DockerExec } from "./verify-cleanup.js";
import { fakeDocker } from "./verify-cleanup-testkit.js";

function setup(reportOverride: Record<string, unknown> = {}, opts: { dirty?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "vc-"));
  const runDir = join(home, "runs", "r1");
  const wt = join(home, "wt");
  mkdirSync(join(runDir, "verify"), { recursive: true });
  mkdirSync(wt);
  execFileSync("git", ["-C", wt, "init", "-q"]);
  writeFileSync(join(wt, "a.txt"), "x");
  const report = {
    schemaVersion: 3,
    run_id: "r1",
    outcome: "PROVISIONED",
    capability: "docker-compose",
    target: {
      kind: "local-disposable", host: "127.0.0.1", port: 18080,
      ownedResources: [
        { kind: "container", name: "dagrun-r1-app" },
        { kind: "network", name: "dagrun-r1-net" },
        { kind: "image", name: "dagrun-r1-app:latest" },
        { kind: "volume", name: "dagrun-r1-data" },
      ],
    },
    candidate: { dirtyFiles: opts.dirty === false ? [] : ["?? a.txt"] },
    teardown: { status: "pending" },
    demoFile: "demo.md",
    ...reportOverride,
  };
  writeFileSync(join(runDir, "verify", "verify-report.json"), JSON.stringify(report));
  return { home, runDir, wt, report };
}
const run = (s: ReturnType<typeof setup>, exec: DockerExec, extra: Record<string, unknown> = {}) =>
  teardownRun({ runDir: s.runDir, runId: "r1", worktreePath: s.wt, trigger: "test", exec, ...extra });
const teardownJson = (s: ReturnType<typeof setup>) =>
  JSON.parse(readFileSync(join(s.runDir, "verify", "teardown.json"), "utf8"));

test("removes exactly the owned resources, verifies, writes teardown.json, leaves the report untouched", () => {
  const s = setup();
  const before = readFileSync(join(s.runDir, "verify", "verify-report.json"), "utf8");
  const d = fakeDocker({ container: ["dagrun-r1-app", "unrelated"], network: ["dagrun-r1-net", "bridge"], image: ["dagrun-r1-app:latest", "postgres:16"], volume: ["dagrun-r1-data"] });
  assert.equal(pendingVerifyEnvs(s.runDir).length, 1);
  const r = run(s, d.exec);
  assert.equal(r.ok, true);
  assert.deepEqual([...d.live.container], ["unrelated"]);
  assert.deepEqual([...d.live.network], ["bridge"]);
  assert.deepEqual([...d.live.image], ["postgres:16"]);
  assert.equal(d.live.volume.size, 0);
  const t = teardownJson(s);
  assert.equal(t.status, "clean");
  assert.equal(t.trigger, "test");
  assert.equal(t.worktree.status, "match");
  assert.equal(readFileSync(join(s.runDir, "verify", "verify-report.json"), "utf8"), before);
  assert.equal(pendingVerifyEnvs(s.runDir).length, 0);
});

test("idempotent: a second run on a clean env is a success", () => {
  const s = setup();
  const d = fakeDocker({ container: ["dagrun-r1-app"] });
  assert.equal(run(s, d.exec).ok, true);
  assert.equal(run(s, d.exec, { all: true }).ok, true);
  assert.equal(teardownJson(s).status, "clean");
});

test("refuses foreign / other-run names: docker is never asked to remove them", () => {
  const s = setup({
    target: { kind: "local-disposable", host: "localhost", port: 1, ownedResources: [
      { kind: "container", name: "postgres" },
      { kind: "container", name: "dagrun-r10-app" },
      { kind: "network", name: "--force" },
      { kind: "container", name: "dagrun-r1-app" },
    ] },
  });
  const d = fakeDocker({ container: ["postgres", "dagrun-r10-app", "dagrun-r1-app"] });
  const r = run(s, d.exec);
  assert.equal(r.ok, false);
  assert.deepEqual([...d.live.container].sort(), ["dagrun-r10-app", "postgres"]);
  assert.ok(!d.calls.some((c) => c.includes("postgres") && (c[0] === "rm" || c.includes("rm"))));
  assert.ok(!d.calls.some((c) => c.includes("--force")));
  const t = teardownJson(s);
  assert.equal(t.status, "leftovers");
  assert.equal(t.leftovers.filter((l: string) => l.includes("REFUSED")).length, 3);
});

test("leftovers (stubborn container) -> status leftovers, ok false, stays pending for retry", () => {
  const s = setup();
  const d = fakeDocker({ container: ["dagrun-r1-app"] }, { stubborn: ["dagrun-r1-app"] });
  const r = run(s, d.exec);
  assert.equal(r.ok, false);
  const t = teardownJson(s);
  assert.equal(t.status, "leftovers");
  assert.ok(t.leftovers.some((l: string) => l.includes("dagrun-r1-app")));
  assert.equal(pendingVerifyEnvs(s.runDir).length, 1);
});

test("docker unreachable is leftovers (unverifiable), never a silent clean", () => {
  const s = setup();
  const r = run(s, fakeDocker({}, { down: true }).exec);
  assert.equal(r.ok, false);
  assert.match(teardownJson(s).leftovers.join("\n"), /could not verify/);
});

test("worktree drift (git status != recorded dirtyFiles) is detected and fails loud", () => {
  const s = setup();
  writeFileSync(join(s.wt, "scratch.txt"), "edited during manual testing");
  const r = run(s, fakeDocker({ container: ["dagrun-r1-app"] }).exec);
  assert.equal(r.ok, false);
  const t = teardownJson(s);
  assert.equal(t.status, "clean"); // resources are gone; drift is reported separately
  assert.equal(t.worktree.status, "drift");
  assert.match(t.worktree.detail, /scratch\.txt/);
});

test("tempdir: removed when prefixed and outside the worktree; refused inside it", () => {
  const s = setup();
  const good = join(tmpdir(), `dagrun-r1-${Date.now()}`);
  mkdirSync(good, { recursive: true });
  const inside = join(s.wt, "dagrun-r1-inside");
  mkdirSync(inside);
  const s2 = setup({ target: { kind: "local-disposable", host: "localhost", port: 1, ownedResources: [{ kind: "tempdir", name: good }, { kind: "tempdir", name: inside }] } });
  // worktree for the run under test is s.wt (where `inside` lives)
  const r = run({ ...s2, wt: s.wt }, fakeDocker({}).exec);
  assert.equal(existsSync(good), false);
  assert.equal(existsSync(inside), true);
  assert.equal(r.ok, false);
});

test("legacy schema-2 report (free-text ownedResources) is cleanable; an already-clean v2 is not pending", () => {
  const legacy = {
    schemaVersion: 2, outcome: "DEMONSTRATED",
    target: { kind: "local-disposable", host: "127.0.0.1", ownedResources: ["dagrun-r1-candidate", "dagrun-r1-net", "dagrun-r1-camunda (image, removed after demo)"] },
    candidate: { dirtyFiles: [" M a.txt"] },
    cleanup: { status: "clean", leftovers: [] },
  };
  const s = setup(legacy);
  assert.equal(pendingVerifyEnvs(s.runDir).length, 0);
  const d = fakeDocker({ container: ["dagrun-r1-candidate"], network: ["dagrun-r1-net"], image: ["dagrun-r1-camunda:latest"] });
  const r = run(s, d.exec, { all: true });
  assert.equal(d.live.container.size + d.live.network.size + d.live.image.size, 0);
  assert.equal(r.reports[0]?.file.status, "clean");
  assert.equal(findVerifyEnvs(s.runDir)[0]?.schemaVersion, 2);
});

test("archived attempts (verify-attempts/attempt-N) are found and torn down too", () => {
  const s = setup();
  const att = join(s.runDir, "verify-attempts", "attempt-1");
  mkdirSync(att, { recursive: true });
  writeFileSync(join(att, "verify-report.json"), JSON.stringify(s.report));
  const d = fakeDocker({ container: ["dagrun-r1-app"] });
  const r = run(s, d.exec);
  assert.equal(r.reports.length, 2);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(readFileSync(join(att, "teardown.json"), "utf8")).worktree.status, "unchecked");
});

test("source-only / resource-less reports have nothing to tear down", () => {
  const s = setup({ capability: "source", target: { kind: "local-disposable", host: "localhost", ownedResources: [] }, teardown: { status: "not-applicable" } });
  assert.equal(pendingVerifyEnvs(s.runDir).length, 0);
  assert.equal(run(s, fakeDocker({}).exec).reports.length, 0);
});
