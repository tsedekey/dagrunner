/**
 * artifact.test.ts — the lazy artifact-preview endpoint's reader: allowlist,
 * size cap, path confinement, and inert rendering of hostile content.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MAX_PREVIEW_BYTES, readArtifactView } from "./artifact.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-artifact-"));
  const nodeDir = join(home, "runs", "9-1", "fix");
  mkdirSync(nodeDir, { recursive: true });
  return { home, nodeDir };
}

test("a markdown artifact is rendered to safe HTML with size/mtime metadata", () => {
  const { home, nodeDir } = setup();
  writeFileSync(join(nodeDir, "summary.md"), "# Title\n\nhello");
  const r = readArtifactView(home, "9-1", "fix", "summary.md");
  assert.ok(r.ok);
  assert.equal(r.view.kind, "markdown");
  assert.match(r.view.html, /<h1>Title<\/h1>/);
  assert.equal(r.view.size, 14);
});

test("XSS: a <script>/onerror payload inside an artifact renders inert for every kind", () => {
  const { home, nodeDir } = setup();
  const payload = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
  writeFileSync(join(nodeDir, "a.md"), `# ${payload}\n\n${payload}\n\n| h |\n|---|\n| ${payload} |\n\n\`\`\`\n${payload}\n\`\`\``);
  writeFileSync(join(nodeDir, "a.json"), JSON.stringify({ [payload]: payload }));
  writeFileSync(join(nodeDir, "a.diff"), `+${payload}\n-${payload}\n ${payload}`);
  writeFileSync(join(nodeDir, "a.txt"), payload);
  for (const f of ["a.md", "a.json", "a.diff", "a.txt"]) {
    const r = readArtifactView(home, "9-1", "fix", f);
    assert.ok(r.ok, f);
    assert.doesNotMatch(r.view.html, /<script|<img/i, `${f} must not contain a live tag`);
    assert.match(r.view.html, /&lt;script&gt;/, f);
  }
});

test("an oversized file and a non-text extension degrade to a note, never a read", () => {
  const { home, nodeDir } = setup();
  writeFileSync(join(nodeDir, "big.md"), "x".repeat(MAX_PREVIEW_BYTES + 1));
  writeFileSync(join(nodeDir, "pic.png"), "binary");
  const big = readArtifactView(home, "9-1", "fix", "big.md");
  assert.ok(big.ok);
  assert.match(big.view.html, /Not previewed — \d+ bytes exceeds/);
  const pic = readArtifactView(home, "9-1", "fix", "pic.png");
  assert.ok(pic.ok);
  assert.match(pic.view.html, /not a recognized text artifact type/);
});

test("path confinement: separators, dot-dot, bad node ids and symlinks that escape the run dir are all refused", () => {
  const { home, nodeDir } = setup();
  writeFileSync(join(home, "secret.md"), "top secret");
  symlinkSync(join(home, "secret.md"), join(nodeDir, "link.md"));
  for (const [node, name] of [["fix", "../../../secret.md"], ["fix", "a/b.md"], ["..", "x.md"], ["fix", ".."], ["fix", ""], ["a/b", "x.md"]] as const) {
    const r = readArtifactView(home, "9-1", node, name);
    assert.equal(r.ok, false, `${node}/${name}`);
  }
  const link = readArtifactView(home, "9-1", "fix", "link.md");
  assert.equal(link.ok, false);
});

test("a missing file is a not-found result, not a throw", () => {
  const { home } = setup();
  const r = readArtifactView(home, "9-1", "fix", "nope.md");
  assert.equal(r.ok, false);
});
