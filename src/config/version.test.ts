/**
 * version.test.ts — co-located unit tests for getVersionInfo / formatVersionBanner.
 *
 * getVersionInfo takes an optional moduleUrl override precisely so these tests
 * can fixture a fake project layout (temp dir with its own package.json and,
 * for the compiled-path cases, dist/build-meta.json) instead of depending on
 * the real repo's package.json version — which changes on every commit under
 * the mandatory version-bump policy.
 *
 * Run with:
 *   node --test --import tsx src/config/version.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { getVersionInfo, formatVersionBanner } from "./version.js";

/** Build a fake project root with package.json, returning its path. */
function fixtureProject(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "dr-version-fixture-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version }),
    "utf8",
  );
  return root;
}

test("getVersionInfo: dev-mode (src/ path) returns isDev true without touching build-meta.json", () => {
  const root = fixtureProject("9.9.9");
  const srcConfigDir = join(root, "src", "config");
  mkdirSync(srcConfigDir, { recursive: true });
  const moduleUrl = pathToFileURL(join(srcConfigDir, "version.ts")).toString();

  const info = getVersionInfo(moduleUrl);

  assert.equal(info.isDev, true);
  assert.equal(info.version, "9.9.9");
  assert.equal(info.buildTime, "unbuilt (dev)");
});

test("getVersionInfo: compiled-path (dist/ path) reads a fixture build-meta.json", () => {
  const root = fixtureProject("9.9.9");
  const distConfigDir = join(root, "dist", "config");
  mkdirSync(distConfigDir, { recursive: true });
  writeFileSync(
    join(root, "dist", "build-meta.json"),
    JSON.stringify({ version: "9.9.9", buildTime: "2026-07-01T14:32:05.000Z" }),
    "utf8",
  );
  const moduleUrl = pathToFileURL(join(distConfigDir, "version.js")).toString();

  const info = getVersionInfo(moduleUrl);

  assert.equal(info.isDev, false);
  assert.equal(info.version, "9.9.9");
  assert.equal(info.buildTime, "2026-07-01 14:32:05 UTC");
});

test("getVersionInfo: compiled-path with missing build-meta.json fails loud", () => {
  const root = fixtureProject("9.9.9");
  const distConfigDir = join(root, "dist", "config");
  mkdirSync(distConfigDir, { recursive: true });
  // dist/build-meta.json intentionally NOT written — broken build.
  const moduleUrl = pathToFileURL(join(distConfigDir, "version.js")).toString();

  assert.throws(
    () => getVersionInfo(moduleUrl),
    /broken build.*build-meta\.json/,
  );
});

test("formatVersionBanner: built (non-dev) format", () => {
  const banner = formatVersionBanner({
    version: "9.9.9",
    buildTime: "2026-07-01 14:32:05 UTC",
    isDev: false,
  });
  assert.equal(banner, "dagrun v9.9.9 — built 2026-07-01 14:32:05 UTC");
});

test("formatVersionBanner: dev format", () => {
  const banner = formatVersionBanner({
    version: "9.9.9",
    buildTime: "unbuilt (dev)",
    isDev: true,
  });
  assert.equal(banner, "dagrun v9.9.9 — (dev, unbuilt)");
});
