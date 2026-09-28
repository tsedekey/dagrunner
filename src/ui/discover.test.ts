/**
 * discover.test.ts — run discovery/sorting, and the "malformed run becomes an
 * error card, never a crash" contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverRuns } from "./discover.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "dr-ui-discover-"));
}

function writeRun(
  home: string,
  id: string,
  over: Record<string, unknown> = {},
): string {
  const dir = join(home, "runs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      runId: id,
      workflow: "bugfix",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      worktreePath: "/w",
      branch: "b",
      sourcePlanPath: "/p",
      nodes: {},
      ...over,
    }),
  );
  return dir;
}

test("no runs dir: empty list, no throw", () => {
  const home = tempHome();
  assert.deepEqual(discoverRuns(home), []);
});

test("valid runs are returned with workflow/status/updatedAt", () => {
  const home = tempHome();
  writeRun(home, "9-1");
  const list = discoverRuns(home);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    runId: "9-1",
    workflow: "bugfix",
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

test("a run dir with unparseable state.json becomes an error card, not a crash", () => {
  const home = tempHome();
  const dir = join(home, "runs", "broken-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), "{ not json");
  const list = discoverRuns(home);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.runId, "broken-1");
  assert.ok(typeof list[0]?.error === "string" && list[0].error.length > 0);
  assert.equal(list[0]?.workflow, undefined);
});

test("a run dir with only driver.log (detached start still claiming its id) reports starting, not a crash", () => {
  const home = tempHome();
  const dir = join(home, "runs", "starting-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "driver.log"), "");
  const list = discoverRuns(home);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.runId, "starting-1");
  assert.match(list[0]?.error ?? "", /driver\.log/);
});

test("a bare empty run dir (no state.json, no driver.log) is skipped quietly", () => {
  const home = tempHome();
  mkdirSync(join(home, "runs", "empty-1"), { recursive: true });
  assert.deepEqual(discoverRuns(home), []);
});

test("sorted newest-first by directory mtime, mixing valid and error entries", async () => {
  const home = tempHome();
  writeRun(home, "old-1");
  // Ensure a distinct, later mtime for the second directory.
  await new Promise((r) => setTimeout(r, 15));
  writeRun(home, "new-1");
  const list = discoverRuns(home);
  assert.deepEqual(
    list.map((r) => r.runId),
    ["new-1", "old-1"],
  );
});
