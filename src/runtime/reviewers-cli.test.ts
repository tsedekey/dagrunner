/**
 * reviewers-cli.test.ts — the I/O half of the reviewer suggestion, driven by a
 * FAKE exec (no gh, no network, no real repo): signal gathering, artifact
 * writing, and fail-loud on every lookup failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_REVIEWERS_CONFIG, type ReviewersConfig } from "../config/reviewers-config.js";
import { suggestReviewers, type Exec } from "./reviewers-cli.js";
import type { ReviewersResult } from "../core/reviewers.js";

const SHA = (n: number): string => String(n).padStart(40, "0");

type Fixture = {
  author?: string;
  teams?: Record<string, string[] | "404">;
  changed?: string[];
  /** git log output blocks: [email, files[]] — sha assigned in order. */
  commits?: Array<[string, string[]]>;
  /** email → login for the GraphQL commit-author lookup (non-noreply emails). */
  emailLogins?: Record<string, string | null>;
  /** login → [pending, reviewed, pair-a, pair-b] */
  counts?: Record<string, [number, number, number, number]>;
  graphqlFails?: boolean;
};

function setup(fx: Fixture): { runDir: string; exec: Exec; calls: string[] } {
  const home = mkdtempSync(join(tmpdir(), "dr-revcli-"));
  const runDir = join(home, "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      runId: "r1",
      worktreePath: "/wt",
      baseBranch: "main",
      branch: "feat",
      status: "paused",
      nodes: {},
    }),
  );
  const calls: string[] = [];
  const commits = fx.commits ?? [];
  const exec: Exec = (file, args) => {
    const line = `${file} ${args.join(" ")}`;
    calls.push(line);
    if (file === "git") {
      if (args.includes("merge-base")) return "BASESHA\n";
      if (args.includes("diff")) return (fx.changed ?? []).join("\0") + "\0";
      if (args.includes("log")) {
        return commits
          .map(([email, files], i) => `@@${SHA(i + 1)} ${email}\n\n${files.join("\n")}\n`)
          .join("");
      }
      throw new Error(`unexpected git: ${line}`);
    }
    if (args[0] === "api" && args[1] === "user") return `${fx.author ?? "me"}\n`;
    if (args[0] === "api" && args.includes("--paginate")) {
      const m = /orgs\/([^/]+)\/teams\/([^/]+)\/members/.exec(args.join(" "));
      const slug = m?.[2] ?? "";
      const t = fx.teams?.[slug];
      if (t === undefined || t === "404") throw new Error(`gh: Not Found (HTTP 404) for team ${slug}`);
      return t.join("\n") + "\n";
    }
    if (args[0] === "repo" && args[1] === "view") return "camunda/camunda\n";
    if (args[0] === "api" && args[1] === "graphql") {
      if (fx.graphqlFails) throw new Error("gh: API rate limit exceeded (HTTP 403)");
      const q = args[args.length - 1] ?? "";
      if (q.includes("object(oid:")) {
        const data: Record<string, unknown> = {};
        for (const m of q.matchAll(/(c\d+): object\(oid:"([0-9a-f]{40})"\)/g)) {
          const idx = Number(m[2]) - 1;
          const email = commits[idx]?.[0] ?? "";
          const login = fx.emailLogins?.[email] ?? null;
          data[m[1] ?? ""] = login === null ? { author: { user: null } } : { author: { user: { login } } };
        }
        return JSON.stringify({ data: { repository: data } });
      }
      const data: Record<string, unknown> = {};
      for (const m of q.matchAll(/(p|r|a|b)(\d+): search\(query: "([^"]*)"/g)) {
        const text = m[3] ?? "";
        const kind = m[1] ?? "";
        const login = /(?:review-requested|reviewed-by):([A-Za-z0-9-]+)/.exec(text)?.[1] ?? "";
        const authorQ = /author:([A-Za-z0-9-]+)/.exec(text)?.[1];
        const c = fx.counts?.[login] ?? [0, 0, 0, 0];
        // a: candidate reviewed author's PRs ("reviewed-by:<cand> author:<author>")
        // b: author reviewed candidate's PRs ("reviewed-by:<author> author:<cand>")
        let n = 0;
        if (kind === "p") n = c[0];
        else if (kind === "r") n = c[1];
        else if (kind === "a") n = c[2];
        else if (kind === "b") {
          const cand = authorQ ?? "";
          n = (fx.counts?.[cand] ?? [0, 0, 0, 0])[3];
        }
        data[`${kind}${m[2] ?? ""}`] = { issueCount: n };
      }
      return JSON.stringify({ data });
    }
    throw new Error(`unexpected gh: ${line}`);
  };
  return { runDir, exec, calls };
}

const cfg = (o: Partial<ReviewersConfig> = {}): ReviewersConfig => ({
  ...DEFAULT_REVIEWERS_CONFIG,
  bePaths: [...DEFAULT_REVIEWERS_CONFIG.bePaths],
  fePaths: [...DEFAULT_REVIEWERS_CONFIG.fePaths],
  ...o,
});
const read = (runDir: string): ReviewersResult =>
  JSON.parse(readFileSync(join(runDir, "pr", "reviewers.json"), "utf8")) as ReviewersResult;

const TEAM = ["me", "alice", "bob", "carol", "dave"];

test("happy path: BE diff selects the -be subteam; Expert + Stretch written with numbers; author filtered", () => {
  const { runDir, exec, calls } = setup({
    author: "me",
    teams: { "core-features-alpha-be": TEAM, "core-features-alpha": ["x"] },
    changed: ["zeebe/a/A.java", "zeebe/a/B.java", "pom.xml", "README.md"],
    commits: [
      ["1+alice@users.noreply.github.com", ["zeebe/a/A.java", "zeebe/a/B.java", "pom.xml"]],
      ["bob@corp.example", ["zeebe/a/A.java"]],
    ],
    emailLogins: { "bob@corp.example": "bob" },
    counts: { alice: [1, 2, 0, 0], bob: [0, 5, 0, 0], carol: [0, 0, 0, 0], dave: [3, 0, 0, 0] },
  });
  const r = suggestReviewers({ runDir, config: cfg(), exec, now: new Date("2026-06-15T00:00:00Z") });
  assert.equal(r.exitCode, 0);
  const j = read(runDir);
  assert.equal(j.status, "ok");
  assert.equal(j.team.slug, "core-features-alpha-be");
  assert.equal(j.team.selection, "be");
  assert.equal(j.author, "me");
  assert.equal(j.changedFiles, 4);
  assert.equal(j.expert?.login, "alice");
  assert.match(j.expert?.reason ?? "", /touched 3 of 4 changed files in 12mo, 1 pending review, 2 reviews in 30d/);
  assert.equal(j.stretch?.login, "carol"); // 0 familiarity, 0 recent reviews, under cap (dave is at the cap)
  assert.notEqual(j.stretch?.login, j.expert?.login);
  assert.deepEqual(j.excluded, [{ login: "me", why: "author" }]);
  assert.ok(existsSync(join(runDir, "pr", "reviewers.md")));
  assert.match(r.md, /@alice/);
  // report-only: nothing but reads — no write verbs reached gh.
  for (const c of calls) {
    assert.doesNotMatch(c, /add-reviewer|pr edit|pr comment|--method|-X |POST|PATCH/);
  }
  assert.ok(calls.some((c) => c.includes("orgs/camunda/teams/core-features-alpha-be/members")));
  // queue = DIRECT requests only; plain `review-requested:` also matches team-addressed requests.
  const signalQuery = calls.find((c) => c.includes("search(query:")) ?? "";
  assert.match(signalQuery, /is:open user-review-requested:alice/);
  assert.doesNotMatch(signalQuery, /is:open review-requested:/);
  assert.ok(calls.some((c) => /log .*--since=12 months ago/.test(c)));
});

test("FE-only and mixed diffs pick the other rosters", () => {
  const fe = setup({
    teams: { "core-features-alpha-fe": ["me", "fran", "gus"], "core-features-alpha": ["nope"] },
    changed: ["operate/client/src/a.tsx"],
  });
  suggestReviewers({ runDir: fe.runDir, config: cfg(), exec: fe.exec });
  assert.equal(read(fe.runDir).team.slug, "core-features-alpha-fe");

  const mixed = setup({
    teams: { "core-features-alpha": ["me", "hal", "ivy"], "core-features-alpha-be": ["nope"] },
    changed: ["A.java", "operate/client/a.ts"],
  });
  suggestReviewers({ runDir: mixed.runDir, config: cfg(), exec: mixed.exec });
  assert.equal(read(mixed.runDir).team.slug, "core-features-alpha");
});

test("away + exclude are filtered; configured org/team slugs are used (not hard-coded)", () => {
  const { runDir, exec, calls } = setup({
    teams: { "my-team": ["me", "alice", "bob", "carol"] },
    changed: ["x.md"],
  });
  suggestReviewers({ runDir, config: cfg({ org: "acme", team: "my-team", away: ["alice"], exclude: ["bob"] }), exec });
  const j = read(runDir);
  assert.deepEqual(j.candidates.map((c) => c.login), ["carol"]);
  assert.equal(j.status, "insufficient");
  assert.equal(j.expert, null);
  assert.equal(j.stretch?.login, "carol");
  assert.ok(calls.some((c) => c.includes("orgs/acme/teams/my-team/members")));
  assert.ok(calls.some((c) => c.includes("org:acme")));
});

test("team lookup failure FAILS LOUD: exit 1, status error persisted, no fallback roster", () => {
  const { runDir, exec } = setup({ teams: {}, changed: ["A.java"] });
  const r = suggestReviewers({ runDir, config: cfg(), exec });
  assert.equal(r.exitCode, 1);
  const j = read(runDir);
  assert.equal(j.status, "error");
  assert.match(j.error ?? "", /404/);
  assert.equal(j.expert, null);
  assert.equal(j.stretch, null);
  assert.match(readFileSync(join(runDir, "pr", "reviewers.md"), "utf8"), /FAILED/);
});

test("empty roster FAILS LOUD", () => {
  const { runDir, exec } = setup({ teams: { "core-features-alpha-be": [] }, changed: ["A.java"] });
  const r = suggestReviewers({ runDir, config: cfg(), exec });
  assert.equal(r.exitCode, 1);
  assert.match(read(runDir).error ?? "", /empty|no members/i);
});

test("a rate-limited / failing signals lookup FAILS LOUD (never a silent zero)", () => {
  const { runDir, exec } = setup({
    teams: { "core-features-alpha-be": TEAM },
    changed: ["A.java"],
    graphqlFails: true,
  });
  const r = suggestReviewers({ runDir, config: cfg(), exec });
  assert.equal(r.exitCode, 1);
  assert.match(read(runDir).error ?? "", /rate limit/);
});

test("no changes vs base FAILS LOUD", () => {
  const { runDir, exec } = setup({ teams: { "core-features-alpha": TEAM }, changed: [] });
  const r = suggestReviewers({ runDir, config: cfg(), exec });
  assert.equal(r.exitCode, 1);
  assert.match(read(runDir).error ?? "", /no committed changes/i);
});

test("unmappable commit identity counts as zero and the reason says so", () => {
  const { runDir, exec } = setup({
    teams: { "core-features-alpha-be": ["me", "alice", "zed"] },
    changed: ["A.java"],
    commits: [["ghost@corp.example", ["A.java"]]],
    emailLogins: { "ghost@corp.example": null },
  });
  suggestReviewers({ runDir, config: cfg(), exec });
  const j = read(runDir);
  assert.equal(j.expert, null);
  assert.match(j.stretch?.reason ?? "", /no commit identity resolved/);
  assert.match(j.notes.join("\n"), /could not be mapped/i);
});

test("pair history is gathered in both directions", () => {
  const { runDir, exec } = setup({
    teams: { "core-features-alpha-be": ["me", "alice", "bob"] },
    changed: ["A.java"],
    commits: [["1+alice@users.noreply.github.com", ["A.java"]]],
    counts: { alice: [0, 0, 1, 2], bob: [0, 0, 0, 0] },
  });
  suggestReviewers({ runDir, config: cfg(), exec });
  const alice = read(runDir).candidates.find((c) => c.login === "alice");
  assert.equal(alice?.pair, 3);
});
