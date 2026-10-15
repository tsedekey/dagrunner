/**
 * reviewers-cli.ts — `dagrun reviewers`: the I/O half of the pr node's
 * REPORT-ONLY reviewer suggestion (scoring lives in core/reviewers.ts).
 *
 * Why it is a dagrun subcommand and not a payload script: payload/ is copied
 * verbatim into the worktree and never compiled or tested, while src/ is
 * typechecked, unit-tested and shipped in dist. The pr node runs it as one plain
 * Bash command (`dagrun reviewers --run-dir <runDir>`); its own gh/git child
 * processes are not subject to the node's tool allowlist.
 *
 * Signals (all READS — there is no write verb anywhere in this file):
 *   roster        gh api orgs/<org>/teams/<slug>/members            (paginated)
 *   author        gh api user                                       (the PR does not exist yet:
 *                                                                    the same gh auth creates it)
 *   changed paths git diff <merge-base> HEAD                        (what the PR will contain)
 *   familiarity   git log <merge-base> --since=<N> months ago -- <changed paths>, commit email →
 *                 GitHub login: `ID+login@users.noreply.github.com` parsed locally, any other email
 *                 resolved with ONE batched GraphQL call (commit author.user.login). Unresolved
 *                 emails count as zero and the reason says so.
 *   load/fairness one batched GraphQL call of search aliases per ≤12 candidates (pending review
 *                 requests, reviews in the window, pair history both directions) — a per-candidate
 *                 `gh search prs` loop would trip the 30 req/min search limit on a 15-person roster.
 * Any lookup failure — auth, 404, empty roster, rate limit — FAILS LOUD: exit 1,
 * `status: "error"` persisted, no fallback roster.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readState } from "../core/state.js";
import type { ReviewersConfig } from "../config/reviewers-config.js";
import {
  REVIEWERS_JSON,
  REVIEWERS_MD,
  classifyChange,
  filterRoster,
  pickReviewers,
  renderReviewersMd,
  teamSlugFor,
  type CandidateSignals,
  type ReviewersResult,
} from "../core/reviewers.js";

/** Injected process runner: returns stdout, THROWS on non-zero exit. */
export type Exec = (file: "git" | "gh", args: string[], cwd?: string) => string;

export function defaultExec(): Exec {
  return (file, args, cwd) => {
    const r = spawnSync(file, args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    if (r.error !== undefined) throw new Error(`${file}: ${r.error.message}`);
    if (r.status !== 0) {
      const what = args.filter((a) => !a.startsWith("query")).slice(0, 3).join(" ");
      throw new Error(`${file} ${what} failed (exit ${String(r.status)}): ${r.stderr.trim().split("\n")[0] ?? ""}`);
    }
    return r.stdout;
  };
}

/** Candidates per GraphQL search request (4 aliases each). */
export const SEARCH_CHUNK = 12;
/** Commits resolved per GraphQL author-lookup request. */
export const EMAIL_CHUNK = 50;
/** Hard cap on non-noreply emails resolved per run (the rest are reported as unmapped). */
export const MAX_EMAIL_LOOKUPS = 150;
const PATH_CHUNK = 300;

const NOREPLY = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function graphql(exec: Exec, query: string): Record<string, unknown> {
  const out = exec("gh", ["api", "graphql", "-f", `query=${query}`]);
  let parsed: { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    throw new Error("gh api graphql returned non-JSON output");
  }
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw new Error(`gh api graphql: ${parsed.errors.map((e) => e.message ?? "error").join("; ")}`);
  }
  if (parsed.data === undefined) throw new Error("gh api graphql returned no data");
  return parsed.data;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** merge-base of HEAD and the run's base: origin/<base> first, then local <base> (mirrors core/changes-diff.ts). */
function mergeBase(exec: Exec, wt: string, base: string): string {
  const tried: string[] = [];
  for (const ref of [`origin/${base}`, base]) {
    try {
      return exec("git", ["-C", wt, "merge-base", ref, "HEAD"]).trim();
    } catch (e) {
      tried.push(`${ref}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`cannot compute a diff base for base_branch "${base}" — ${tried.join("; ")}`);
}

type Familiarity = {
  /** login (lower-case) → number of changed files that login committed to */
  files: Map<string, number>;
  mappedLogins: Set<string>;
  unresolvedEmails: number;
  truncatedEmails: number;
};

function gatherFamiliarity(
  exec: Exec,
  wt: string,
  base: string,
  paths: string[],
  months: number,
): Familiarity {
  const fileEmails = new Map<string, Set<string>>();
  const emailSha = new Map<string, string>();
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    const chunk = paths.slice(i, i + PATH_CHUNK);
    const out = exec("git", [
      "-C", wt, "-c", "core.quotepath=false", "log", base,
      `--since=${String(months)} months ago`, "--no-merges", "--format=@@%H %ae", "--name-only", "--", ...chunk,
    ]);
    let email = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("@@")) {
        const [sha = "", em = ""] = line.slice(2).split(" ");
        email = em.toLowerCase();
        if (email !== "" && !emailSha.has(email)) emailSha.set(email, sha);
      } else if (line.trim() !== "" && email !== "") {
        let set = fileEmails.get(line);
        if (set === undefined) fileEmails.set(line, (set = new Set()));
        set.add(email);
      }
    }
  }

  const emailLogin = new Map<string, string | null>();
  const toLookup: string[] = [];
  for (const email of emailSha.keys()) {
    const m = NOREPLY.exec(email);
    if (m !== null) emailLogin.set(email, (m[1] ?? "").toLowerCase());
    else if (email.includes("[bot]")) emailLogin.set(email, null);
    else toLookup.push(email);
  }
  const truncatedEmails = Math.max(0, toLookup.length - MAX_EMAIL_LOOKUPS);
  const lookup = toLookup.slice(0, MAX_EMAIL_LOOKUPS);
  for (const e of toLookup.slice(MAX_EMAIL_LOOKUPS)) emailLogin.set(e, null);

  if (lookup.length > 0) {
    const nwo = exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], wt).trim();
    if (!REPO.test(nwo)) throw new Error(`could not determine the GitHub repo of the worktree (got "${nwo}")`);
    const [owner = "", name = ""] = nwo.split("/");
    for (let i = 0; i < lookup.length; i += EMAIL_CHUNK) {
      const chunk = lookup.slice(i, i + EMAIL_CHUNK);
      const aliases = chunk.map((email, j) => {
        const sha = emailSha.get(email) ?? "";
        if (!SHA40.test(sha)) throw new Error(`unexpected commit id "${sha}" from git log`);
        return `c${String(j)}: object(oid:"${sha}") { ... on Commit { author { user { login } } } }`;
      });
      const data = graphql(exec, `query { repository(owner:"${owner}", name:"${name}") { ${aliases.join(" ")} } }`);
      const repo = (data["repository"] ?? {}) as Record<string, { author?: { user?: { login?: string } | null } } | null>;
      chunk.forEach((email, j) => {
        const login = repo[`c${String(j)}`]?.author?.user?.login;
        emailLogin.set(email, typeof login === "string" ? login.toLowerCase() : null);
      });
    }
  }

  const files = new Map<string, number>();
  const mappedLogins = new Set<string>();
  for (const l of emailLogin.values()) if (l !== null) mappedLogins.add(l);
  for (const emails of fileEmails.values()) {
    const logins = new Set<string>();
    for (const e of emails) {
      const l = emailLogin.get(e);
      if (l !== null && l !== undefined) logins.add(l);
    }
    for (const l of logins) files.set(l, (files.get(l) ?? 0) + 1);
  }
  const unresolvedEmails = [...emailLogin.values()].filter((l) => l === null).length;
  return { files, mappedLogins, unresolvedEmails, truncatedEmails };
}

type Load = { pending: number; reviewed: number; pair: number };

function gatherLoad(
  exec: Exec,
  org: string,
  author: string,
  candidates: string[],
  recentDays: number,
  now: Date,
): Map<string, Load> {
  const since = isoDay(new Date(now.getTime() - recentDays * 86_400_000));
  const out = new Map<string, Load>();
  for (let i = 0; i < candidates.length; i += SEARCH_CHUNK) {
    const chunk = candidates.slice(i, i + SEARCH_CHUNK);
    const q = (query: string, alias: string): string =>
      `${alias}: search(query: "${query}", type: ISSUE, first: 1) { issueCount }`;
    const parts: string[] = [];
    chunk.forEach((login, j) => {
      if (!LOGIN.test(login)) throw new Error(`refusing to query an invalid GitHub login "${login}"`);
      const k = String(j);
      parts.push(
        q(`is:pr is:open review-requested:${login} org:${org}`, `p${k}`),
        q(`is:pr reviewed-by:${login} -author:${login} org:${org} updated:>=${since}`, `r${k}`),
        q(`is:pr reviewed-by:${login} author:${author} org:${org} updated:>=${since}`, `a${k}`),
        q(`is:pr reviewed-by:${author} author:${login} org:${org} updated:>=${since}`, `b${k}`),
      );
    });
    const data = graphql(exec, `query { ${parts.join(" ")} }`);
    const count = (alias: string): number => {
      const n = (data[alias] as { issueCount?: unknown } | undefined)?.issueCount;
      if (typeof n !== "number") throw new Error(`search result "${alias}" missing from the GitHub response`);
      return n;
    };
    chunk.forEach((login, j) => {
      const k = String(j);
      out.set(login, { pending: count(`p${k}`), reviewed: count(`r${k}`), pair: count(`a${k}`) + count(`b${k}`) });
    });
  }
  return out;
}

export function suggestReviewers(args: {
  runDir: string;
  config: ReviewersConfig;
  exec: Exec;
  now?: Date;
}): { exitCode: 0 | 1; result: ReviewersResult; md: string } {
  const { runDir, config, exec } = args;
  const now = args.now ?? new Date();
  const outDir = join(runDir, "pr");
  const empty = (): ReviewersResult => ({
    status: "error",
    generatedAt: now.toISOString(),
    author: "",
    team: { org: config.org, slug: config.team, selection: "whole", reason: "" },
    changedFiles: 0,
    rosterSize: 0,
    expert: null,
    stretch: null,
    notes: [],
    excluded: [],
    candidates: [],
  });
  const persist = (result: ReviewersResult): { exitCode: 0 | 1; result: ReviewersResult; md: string } => {
    const md = renderReviewersMd(result);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, REVIEWERS_JSON), JSON.stringify(result, null, 2) + "\n", "utf8");
    writeFileSync(join(outDir, REVIEWERS_MD), md, "utf8");
    return { exitCode: result.status === "error" ? 1 : 0, result, md };
  };

  const partial = empty();
  try {
    const state = readState(join(runDir, "state.json"));
    const wt = state.worktreePath;
    const baseBranch = state.baseBranch ?? "main";

    const base = mergeBase(exec, wt, baseBranch);
    const changed = exec("git", ["-C", wt, "diff", "--name-only", "--no-renames", "-z", base, "HEAD"])
      .split("\0")
      .filter((p) => p !== "");
    if (changed.length === 0) {
      throw new Error(
        `no committed changes between ${base.slice(0, 12)} (merge-base with ${baseBranch}) and HEAD — run this after the pr node's backstop commit`,
      );
    }
    partial.changedFiles = changed.length;

    const author = exec("gh", ["api", "user", "--jq", ".login"]).trim();
    if (!LOGIN.test(author)) throw new Error(`could not determine the GitHub login of the PR author (got "${author}")`);
    partial.author = author;

    const kind = classifyChange(changed, config);
    const slug = teamSlugFor(kind.kind, config);
    partial.team = { org: config.org, slug, selection: kind.kind, reason: kind.reason };

    const members = exec("gh", [
      "api", "--paginate", `orgs/${config.org}/teams/${slug}/members?per_page=100`, "--jq", ".[].login",
    ])
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (members.length === 0) {
      throw new Error(`team ${config.org}/${slug} is empty (or its members are not visible to this gh account)`);
    }
    partial.rosterSize = members.length;

    const { eligible, excluded } = filterRoster(members, { author, away: config.away, exclude: config.exclude });
    partial.excluded = excluded;

    const notes: string[] = [];
    let candidates: CandidateSignals[] = [];
    if (eligible.length > 0) {
      const fam = gatherFamiliarity(exec, wt, base, changed, config.familiarityMonths);
      const load = gatherLoad(exec, config.org, author, eligible, config.recentReviewDays, now);
      candidates = eligible.map((login) => {
        const l = load.get(login) ?? { pending: 0, reviewed: 0, pair: 0 };
        const key = login.toLowerCase();
        return {
          login,
          familiarFiles: fam.files.get(key) ?? 0,
          identityMapped: fam.mappedLogins.has(key),
          ...l,
        };
      });
      if (fam.unresolvedEmails > 0) {
        notes.push(
          `${String(fam.unresolvedEmails)} commit email(s) on the changed paths could not be mapped to a GitHub login` +
            (fam.truncatedEmails > 0 ? ` (${String(fam.truncatedEmails)} skipped by the ${String(MAX_EMAIL_LOOKUPS)}-lookup cap)` : "") +
            " — their commits do not count towards anyone's familiarity.",
        );
      }
    }

    const picked = pickReviewers({ candidates, changedFiles: changed.length, cfg: config });
    const result: ReviewersResult = {
      ...partial,
      status: picked.expert !== null && picked.stretch !== null ? "ok" : "insufficient",
      expert: picked.expert,
      stretch: picked.stretch,
      notes: [...notes, ...picked.notes],
      candidates: picked.scored,
    };
    return persist(result);
  } catch (e) {
    return persist({ ...partial, status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
