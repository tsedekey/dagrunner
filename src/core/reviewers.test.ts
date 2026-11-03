/**
 * reviewers.test.ts — pure subteam selection / roster filters / Expert+Stretch
 * scoring for the pr node's reviewer suggestion, driven by fixtures (no gh, no git).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_REVIEWERS_CONFIG } from "../config/reviewers-config.js";
import { buildGateBrief } from "./gate.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import type { RunState } from "./state.js";
import {
  classifyChange,
  filterRoster,
  pickReviewers,
  renderReviewersMd,
  reviewersAdvisory,
  teamSlugFor,
  type CandidateSignals,
  type ReviewersResult,
} from "./reviewers.js";

const cfg = DEFAULT_REVIEWERS_CONFIG;
const cand = (login: string, o: Partial<CandidateSignals> = {}): CandidateSignals => ({
  login,
  familiarFiles: 0,
  identityMapped: true,
  pending: 0,
  reviewed: 0,
  pair: 0,
  ...o,
});
const pick = (candidates: CandidateSignals[], changedFiles = 20) =>
  pickReviewers({ candidates, changedFiles, cfg });

// --- subteam selection -------------------------------------------------------

test("classifyChange: backend-only → be team; frontend-only → fe team", () => {
  const be = classifyChange(["zeebe/engine/A.java", "pom.xml"], cfg);
  assert.equal(be.kind, "be");
  assert.equal(teamSlugFor(be.kind, cfg), "core-features-alpha-be");
  const fe = classifyChange(["operate/client/src/a.ts", "tasklist/client/b.scss"], cfg);
  assert.equal(fe.kind, "fe");
  assert.equal(teamSlugFor(fe.kind, cfg), "core-features-alpha-fe");
});

test("classifyChange: mixed or nothing matched → whole team; neutral files are ignored", () => {
  assert.equal(classifyChange(["A.java", "operate/client/a.ts"], cfg).kind, "whole");
  assert.equal(classifyChange(["README.md", ".github/ci.yml"], cfg).kind, "whole");
  assert.equal(classifyChange([], cfg).kind, "whole");
  const k = classifyChange(["A.java", "docs/readme.md"], cfg);
  assert.equal(k.kind, "be");
  assert.equal(k.neutral, 1);
  assert.equal(teamSlugFor("whole", cfg), "core-features-alpha");
});

test("classifyChange: honours configured path mapping", () => {
  const c = { ...cfg, bePaths: ["svc/"], fePaths: ["ui/"] };
  assert.equal(classifyChange(["svc/a.go"], c).kind, "be");
  assert.equal(classifyChange(["ui/a.vue"], c).kind, "fe");
  assert.equal(classifyChange(["A.java"], c).kind, "whole");
});

// --- roster filters ----------------------------------------------------------

test("filterRoster: drops author, away and exclude (case-insensitive), keeps the reasons", () => {
  const r = filterRoster(["Alice", "bob", "carol", "dave", "erin"], {
    author: "alice",
    away: ["BOB"],
    exclude: ["carol"],
  });
  assert.deepEqual(r.eligible, ["dave", "erin"]);
  assert.deepEqual(
    r.excluded.map((e) => `${e.login}:${e.why}`),
    ["Alice:author", "bob:away", "carol:excluded"],
  );
});

// --- scoring -----------------------------------------------------------------

test("Expert is the most familiar; Stretch the least familiar under the queue cap; never the same person", () => {
  const r = pick([
    cand("deep", { familiarFiles: 14 }),
    cand("some", { familiarFiles: 5 }),
    cand("none", { familiarFiles: 0 }),
  ]);
  assert.equal(r.expert?.login, "deep");
  assert.equal(r.stretch?.login, "none");
  assert.notEqual(r.expert?.login, r.stretch?.login);
});

test("queue cap: at/above cap is excluded from Stretch and penalised (not excluded) in Expert", () => {
  const stretchOnlyCapped = pick([
    cand("deep", { familiarFiles: 10 }),
    cand("capped-fresh", { familiarFiles: 0, pending: 3 }),
    cand("ok", { familiarFiles: 2, pending: 1 }),
  ]);
  assert.equal(stretchOnlyCapped.stretch?.login, "ok", "capped-fresh must not be the Stretch");

  // Expert penalty: a slightly more familiar but capped person loses to a near-equal free one…
  const close = pick([
    cand("capped", { familiarFiles: 10, pending: 3 }),
    cand("free", { familiarFiles: 9, pending: 0 }),
  ]);
  assert.equal(close.expert?.login, "free");
  // …but a much more familiar capped expert is still chosen.
  const far = pick([
    cand("capped", { familiarFiles: 18, pending: 3 }),
    cand("free", { familiarFiles: 3, pending: 0 }),
  ]);
  assert.equal(far.expert?.login, "capped");
  assert.match(far.expert?.reason ?? "", /at queue cap/);
});

test("Stretch is boosted for 'has not reviewed lately'; pair history is a mild penalty", () => {
  const fair = pick([
    cand("expert", { familiarFiles: 12 }),
    cand("busy", { familiarFiles: 0, reviewed: 9 }),
    cand("rested", { familiarFiles: 0, reviewed: 0 }),
  ]);
  assert.equal(fair.stretch?.login, "rested");

  const pair = pick([
    cand("expert", { familiarFiles: 12 }),
    cand("paired", { familiarFiles: 0, pair: 3 }),
    cand("unpaired", { familiarFiles: 0, pair: 0 }),
  ]);
  assert.equal(pair.stretch?.login, "unpaired");
});

test("fewer than 2 candidates: reported honestly, never padded", () => {
  const none = pick([]);
  assert.equal(none.expert, null);
  assert.equal(none.stretch, null);
  assert.match(none.notes.join("\n"), /no eligible candidates/i);

  const one = pick([cand("solo", { familiarFiles: 4 })]);
  assert.equal(one.expert?.login, "solo");
  assert.equal(one.stretch, null);
  assert.match(one.notes.join("\n"), /fewer than 2 eligible/i);

  // A lone zero-familiarity candidate is a Stretch, not a fake Expert.
  const lone = pick([cand("newbie", { familiarFiles: 0 })]);
  assert.equal(lone.expert, null);
  assert.equal(lone.stretch?.login, "newbie");
});

test("no Expert when nobody touched the paths; Stretch still picked", () => {
  const r = pick([cand("a"), cand("b", { reviewed: 5 })]);
  assert.equal(r.expert, null);
  assert.equal(r.stretch?.login, "a");
  assert.match(r.notes.join("\n"), /no candidate touched/i);
});

test("all candidates over the cap: no Stretch (explained), Expert still named", () => {
  const r = pick([
    cand("a", { familiarFiles: 6, pending: 4 }),
    cand("b", { familiarFiles: 1, pending: 3 }),
  ]);
  assert.equal(r.expert?.login, "a");
  assert.equal(r.stretch, null);
  assert.match(r.notes.join("\n"), /queue cap/i);
});

test("deterministic tie-break by login", () => {
  const r = pick([cand("zed", { familiarFiles: 5 }), cand("amy", { familiarFiles: 5 }), cand("mid")]);
  assert.equal(r.expert?.login, "amy");
});

test("reasons carry the actual numbers; unmapped identity is stated", () => {
  const r = pick(
    [
      cand("deep", { familiarFiles: 14, pending: 1, reviewed: 2 }),
      cand("ghost", { familiarFiles: 0, identityMapped: false, pending: 0, reviewed: 1 }),
    ],
    22,
  );
  assert.equal(
    r.expert?.reason,
    "touched 14 of 22 changed files in 12mo, 1 pending review, 2 reviews in 30d",
  );
  assert.match(r.stretch?.reason ?? "", /touched 0 of 22 changed files in 12mo/);
  assert.match(r.stretch?.reason ?? "", /no commit identity resolved.*counted as 0/);
});

// --- rendering + gate advisory -----------------------------------------------

const sample = (over: Partial<ReviewersResult> = {}): ReviewersResult => ({
  status: "ok",
  generatedAt: "2026-01-01T00:00:00.000Z",
  author: "me",
  team: { org: "camunda", slug: "core-features-alpha-be", selection: "be", reason: "2 backend, 0 frontend, 1 neutral" },
  changedFiles: 3,
  rosterSize: 5,
  expert: { login: "deep", role: "expert", score: 0.9, reason: "touched 3 of 3 changed files in 12mo, 0 pending reviews, 0 reviews in 30d" },
  stretch: { login: "new", role: "stretch", score: 1, reason: "touched 0 of 3 changed files in 12mo, 0 pending reviews, 0 reviews in 30d" },
  notes: [],
  excluded: [{ login: "me", why: "author" }],
  candidates: [],
  ...over,
});

test("renderReviewersMd: states report-only, names both slots with reasons; error variant is loud", () => {
  const md = renderReviewersMd(sample());
  assert.match(md, /report-only/i);
  assert.match(md, /Expert.*@deep.*touched 3 of 3/);
  assert.match(md, /Stretch.*@new/);
  assert.match(md, /core-features-alpha-be/);
  const bad = renderReviewersMd(sample({ status: "error", error: "gh: 404 Not Found", expert: null, stretch: null }));
  assert.match(bad, /FAILED/);
  assert.match(bad, /404 Not Found/);
  assert.match(bad, /no reviewer was suggested/i);
});

test("reviewersAdvisory: absent → ✗, error → ✗ with detail, ok/insufficient → ✓", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-rev-"));
  mkdirSync(join(dir, "pr"));
  const absent = reviewersAdvisory(dir);
  assert.equal(absent.length, 1);
  assert.equal(absent[0]?.ok, false);
  assert.equal(absent[0]?.check, "reviewer-suggestion");

  writeFileSync(join(dir, "pr", "reviewers.json"), JSON.stringify(sample({ status: "error", error: "boom" })));
  const err = reviewersAdvisory(dir);
  assert.equal(err[0]?.ok, false);
  assert.match(err[0]?.detail ?? "", /boom/);

  writeFileSync(join(dir, "pr", "reviewers.json"), JSON.stringify(sample()));
  assert.equal(reviewersAdvisory(dir)[0]?.ok, true);
  writeFileSync(join(dir, "pr", "reviewers.json"), "{not json");
  assert.equal(reviewersAdvisory(dir)[0]?.ok, false);
});

test("buildGateBrief: only the pr gate carries the reviewer advisory, and it never changes the revision", () => {
  const run = mkdtempSync(join(tmpdir(), "dr-rev-gate-"));
  const node = (status: "done" | "awaiting-gate") => ({ status, artifacts: [], iteration: 0, cost: 0, gateHistory: [] });
  const st: RunState = {
    runId: "r", workflow: "bugfix", createdAt: "T", updatedAt: "T", status: "paused",
    worktreePath: run, branch: "feat", sourcePlanPath: "/p", baseBranch: "main",
    nodes: { reproduce: node("done"), implement: node("done"), review: node("done"), fix: node("done"), pr: node("awaiting-gate") },
  };
  const build = (gate: string) => buildGateBrief({ runDir: run, state: st, workflow: bugfixWorkflow, gateNodeId: gate, configDirs: [] });
  const missing = build("pr");
  const entry = missing.validation.find((v) => v.check === "reviewer-suggestion");
  assert.equal(entry?.ok, false);
  assert.equal(build("fix").validation.some((v) => v.check === "reviewer-suggestion"), false);

  mkdirSync(join(run, "pr"), { recursive: true });
  writeFileSync(join(run, "pr", "reviewers.json"), JSON.stringify(sample()));
  const ok = build("pr");
  assert.equal(ok.validation.find((v) => v.check === "reviewer-suggestion")?.ok, true);
  assert.equal(ok.revision, missing.revision);
});

test("payload/commands/pr.md: one literal dagrun reviewers command, report-only, never into body.md", () => {
  const md = readFileSync(new URL("../../payload/commands/pr.md", import.meta.url), "utf8");
  assert.match(md, /dagrun reviewers --run-dir "<runDir>"/);
  assert.match(md, /Report-only/);
  assert.match(md, /never put a reviewer name or `@handle` into `body\.md`/);
  assert.match(md, /REVIEWER SUGGESTION FAILED/);
  // The only mention of the posting verbs is the prohibition itself.
  const step = md.slice(md.indexOf("## Step 5"), md.indexOf("## Step 6"));
  assert.match(step, /Never run `gh pr edit --add-reviewer`/);
  assert.doesNotMatch(step, /\$DAGRUN_/);
});
