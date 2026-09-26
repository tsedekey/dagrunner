/**
 * run-lock.test.ts — a second driver on a run with a LIVE lock holder is refused
 * before any state is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resumeRun } from "./run-engine.js";

test("resumeRun refuses a run whose lock is held by a live process, leaving state.json byte-identical", async () => {
  const home = mkdtempSync(join(tmpdir(), "dr-runlock-"));
  const runDir = join(home, "runs", "7-1");
  mkdirSync(runDir, { recursive: true });
  const state = {
    runId: "7-1", workflow: "bugfix", createdAt: "T", updatedAt: "T", status: "running",
    worktreePath: join(home, "wt"), branch: "b", sourcePlanPath: "/p",
    nodes: { reproduce: { status: "running", artifacts: [], iteration: 0, cost: 0, gateHistory: [] } },
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  const before = readFileSync(join(runDir, "state.json"), "utf8");
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  writeFileSync(join(home, "active.lock"), JSON.stringify({ runId: "7-1", pid: holder.pid, startedAt: "T" }));

  const errs: string[] = [];
  const realExit = process.exit;
  const realErr = process.stderr.write.bind(process.stderr);
  process.exit = ((c?: number) => { throw new Error(`exit ${c}`); }) as typeof process.exit;
  process.stderr.write = ((s: string) => { errs.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    await assert.rejects(() => resumeRun({ runId: "7-1", homeDir: home, config: { DEVHARNESS_SRC: home } }), /exit 1/);
  } finally {
    process.exit = realExit;
    process.stderr.write = realErr;
    holder.kill();
  }
  assert.match(errs.join(""), /already being driven by pid \d+/);
  assert.equal(readFileSync(join(runDir, "state.json"), "utf8"), before, "state must not be reconciled/rewritten");
  assert.equal(JSON.parse(readFileSync(join(home, "active.lock"), "utf8")).pid, holder.pid, "live holder's lock untouched");
});
