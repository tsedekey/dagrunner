import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawnDetached, withoutFlag, selfInvocation } from "./detach.js";
import { isPidAlive } from "../core/lock.js";

test("withoutFlag removes only the flag", () => {
  assert.deepEqual(withoutFlag(["a", "--detach", "--x", "y"], "--detach"), ["a", "--x", "y"]);
});

test("selfInvocation carries execArgv and the entry script", () => {
  const s = selfInvocation(["status", "--json"]);
  assert.equal(s.command, process.execPath);
  assert.deepEqual(s.args.slice(-2), ["status", "--json"]);
});

test("spawnDetached returns at once with a live pid; child output lands in the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-det-"));
  const log = join(dir, "sub", "driver.log");
  const t0 = Date.now();
  const pid = spawnDetached({
    command: process.execPath,
    args: ["-e", "console.log('child-out'); console.error('child-err'); setTimeout(()=>{}, 1500)"],
    logPath: log,
  });
  assert.ok(Date.now() - t0 < 1000, "must not wait for the child");
  assert.ok(pid > 0 && pid !== process.pid);
  assert.equal(isPidAlive(pid), true);
  for (let i = 0; i < 50 && !(existsSync(log) && /child-err/.test(readFileSync(log, "utf8"))); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = readFileSync(log, "utf8");
  assert.match(text, /child-out/);
  assert.match(text, /child-err/);
});

test("spawnDetached fails loud for a non-spawnable command", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-det-"));
  assert.throws(() => spawnDetached({ command: "/definitely/not/a/binary", args: [], logPath: join(dir, "l") }), /failed to spawn/);
});
