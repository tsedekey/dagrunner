/**
 * reviewers-config.test.ts — the `reviewers` block of config.json is validated
 * at LOAD time (a typo is a load error, never a silently empty roster).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_REVIEWERS_CONFIG,
  matchesPathPattern,
  parseReviewersConfig,
} from "./reviewers-config.js";
import { resolveConfig } from "./xdg.js";

test("absent block → documented defaults (and a fresh copy each time)", () => {
  const a = parseReviewersConfig(undefined);
  assert.deepEqual(a, DEFAULT_REVIEWERS_CONFIG);
  assert.equal(a.org, "camunda");
  assert.equal(a.team, "core-features-alpha");
  assert.equal(a.queueCap, 3);
  assert.equal(a.familiarityMonths, 12);
  assert.equal(a.recentReviewDays, 30);
  a.away.push("x");
  assert.deepEqual(parseReviewersConfig(undefined).away, []);
});

test("partial block merges over defaults; logins are lower-cased", () => {
  const c = parseReviewersConfig({ away: ["KortHout"], queueCap: 5, team: "my-team" });
  assert.deepEqual(c.away, ["korthout"]);
  assert.equal(c.queueCap, 5);
  assert.equal(c.team, "my-team");
  assert.equal(c.beTeam, DEFAULT_REVIEWERS_CONFIG.beTeam);
});

test("malformed block → named load errors", () => {
  assert.throws(() => parseReviewersConfig("nope"), /reviewers.*must be an object/);
  assert.throws(() => parseReviewersConfig({ queueCap: 0 }), /reviewers\.queueCap.*positive integer/);
  assert.throws(() => parseReviewersConfig({ queueCap: "3" }), /reviewers\.queueCap/);
  assert.throws(() => parseReviewersConfig({ familiarityMonths: 1.5 }), /reviewers\.familiarityMonths/);
  assert.throws(() => parseReviewersConfig({ team: "has space" }), /reviewers\.team.*slug/);
  assert.throws(() => parseReviewersConfig({ org: "" }), /reviewers\.org/);
  assert.throws(() => parseReviewersConfig({ away: "korthout" }), /reviewers\.away.*array/);
  assert.throws(() => parseReviewersConfig({ away: ["bad login!"] }), /reviewers\.away\[0\]/);
  assert.throws(() => parseReviewersConfig({ bePaths: [""] }), /reviewers\.bePaths\[0\]/);
  assert.throws(() => parseReviewersConfig({ fePaths: ["src/**/x.ts"] }), /reviewers\.fePaths\[0\].*glob/);
  assert.throws(() => parseReviewersConfig({ queueKap: 3 }), /unknown key "queueKap"/);
});

test("matchesPathPattern: *.ext, dir/ prefix, bare filename, exact path", () => {
  assert.equal(matchesPathPattern("a/b/C.java", "*.java"), true);
  assert.equal(matchesPathPattern("a/b/C.javax", "*.java"), false);
  assert.equal(matchesPathPattern("operate/client/src/a.ts", "operate/client/"), true);
  assert.equal(matchesPathPattern("operate/clientx/a.ts", "operate/client/"), false);
  assert.equal(matchesPathPattern("zeebe/engine/pom.xml", "pom.xml"), true);
  assert.equal(matchesPathPattern("zeebe/engine/mypom.xml", "pom.xml"), false);
  assert.equal(matchesPathPattern("a/b.txt", "a/b.txt"), true);
});

test("resolveConfig: reviewers block is validated at load (bad block exits loudly)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-revcfg-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ DEVHARNESS_SRC: "/x", reviewers: { queueCap: -1 } }),
  );
  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  let err = "";
  process.exit = ((c?: number) => {
    throw new Error(`exit:${String(c)}`);
  }) as typeof process.exit;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.throws(() => resolveConfig(dir), /exit:1/);
  } finally {
    process.exit = origExit;
    process.stderr.write = origErr;
  }
  assert.match(err, /reviewers\.queueCap/);

  writeFileSync(join(dir, "config.json"), JSON.stringify({ DEVHARNESS_SRC: "/x", reviewers: { away: ["Eve"] } }));
  assert.deepEqual(resolveConfig(dir).reviewers?.away, ["eve"]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ DEVHARNESS_SRC: "/x" }));
  assert.equal(resolveConfig(dir).reviewers, undefined);
});
