import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNodeFiles } from "./node-files.js";

test("registered first (state order), then unregistered alphabetical; bookkeeping and dirs excluded; size+mtime", () => {
  const run = mkdtempSync(join(tmpdir(), "dr-nf-"));
  const dir = join(run, "fix");
  mkdirSync(join(dir, "sub"), { recursive: true });
  for (const f of ["summary.md", "changes.diff", "a.md", "transcript.log", "burn.json", "gate.json", "gate-context.md"]) writeFileSync(join(dir, f), "12345");
  const files = listNodeFiles(run, "fix", [join(dir, "summary.md")]);
  assert.deepEqual(files.map((f) => [f.path.slice(dir.length + 1), f.registered]), [
    ["summary.md", true], ["a.md", false], ["changes.diff", false],
  ]);
  assert.equal(files[0]?.size, 5);
  assert.match(files[0]?.mtime ?? "", /^\d{4}-\d\d-\d\dT/);
});

test("a registered file is listed even when bookkeeping-named or missing (as today)", () => {
  const run = mkdtempSync(join(tmpdir(), "dr-nf-"));
  mkdirSync(join(run, "n"));
  writeFileSync(join(run, "n", "transcript.log"), "x");
  const files = listNodeFiles(run, "n", [join(run, "n", "transcript.log"), join(run, "n", "gone.md")]);
  assert.deepEqual(files.map((f) => [f.registered, f.size === null]), [[true, false], [true, true]]);
});

test("missing node dir lists nothing", () => {
  assert.deepEqual(listNodeFiles(mkdtempSync(join(tmpdir(), "dr-nf-")), "none", []), []);
});
