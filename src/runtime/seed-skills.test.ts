import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktreeSkills } from "./run-engine.js";

const root = new URL("../../", import.meta.url).pathname;

test("seedWorktreeSkills: payload skills land in .claude/skills/<name>/SKILL.md (explicit dir for Copilot)", () => {
  const dest = mkdtempSync(join(tmpdir(), "dr-seed-skill-"));
  seedWorktreeSkills(root, dest);
  const md = readFileSync(join(dest, "skills", "review", "SKILL.md"), "utf8");
  assert.match(md, /^---\nname: review\n/);
  assert.ok(md.includes("$ARGUMENTS"));
});

test("seedWorktreeSkills: removes a stale seeded commands/<skill>.md so the skill is the only /review", () => {
  const dest = mkdtempSync(join(tmpdir(), "dr-seed-skill-stale-"));
  mkdirSync(join(dest, "commands"), { recursive: true });
  writeFileSync(join(dest, "commands", "review.md"), "old command");
  writeFileSync(join(dest, "commands", "fix.md"), "keep me");
  seedWorktreeSkills(root, dest);
  assert.equal(existsSync(join(dest, "commands", "review.md")), false);
  assert.equal(existsSync(join(dest, "commands", "fix.md")), true);
});

test("seedWorktreeSkills: throws loudly when payload/skills is missing (broken install)", () => {
  const fakeRoot = mkdtempSync(join(tmpdir(), "dr-seed-skill-broken-"));
  assert.throws(() => seedWorktreeSkills(fakeRoot, mkdtempSync(join(tmpdir(), "d-"))), /payload\/skills.*not found/);
});

test("the review skill is the only /review: no payload command of that name", () => {
  assert.equal(existsSync(join(root, "payload", "commands", "review.md")), false);
});
