/**
 * reviewers.ts — the PURE half of the pr node's reviewer suggestion: subteam
 * selection by changed files, roster filters, Expert/Stretch scoring and
 * rendering. No gh, no git, no fs beyond reading the artifact in
 * reviewersAdvisory — the I/O half is runtime/reviewers-cli.ts, which feeds this
 * module signals through an injected exec so everything here is fixture-testable.
 *
 * Two slots, REPORT-ONLY (nothing is ever posted to GitHub):
 *   Expert  — highest path familiarity, adjusted for load (queue, recent
 *             reviews, pair history). Needs familiarity > 0: a person who never
 *             touched these paths is not an "expert".
 *   Stretch — LOWEST familiarity among candidates strictly under the queue cap,
 *             boosted when they have not reviewed lately (knowledge sharing).
 * Expert and Stretch are different people; with fewer than two eligible
 * candidates the missing slot is reported as missing, never padded.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesPathPattern, type ReviewersConfig } from "../config/reviewers-config.js";

/** Scoring weights — named, documented defaults (DECISIONS.md § reviewer-suggestion). Familiarity is a 0..1 ratio of changed files touched. */
export const SCORING = {
  /** Expert: subtracted when the queue is full (scaled linearly below the cap, saturating at it). */
  EXPERT_QUEUE_PENALTY: 0.3,
  /** Expert: mild reward for a light recent-review load (fairness nudge). */
  EXPERT_FAIRNESS_BOOST: 0.05,
  /** Both slots: mild penalty when author and candidate reviewed each other's PRs recently. */
  PAIR_PENALTY: 0.1,
  /** Stretch: reward for "has not reviewed lately". */
  STRETCH_FAIRNESS_BOOST: 0.5,
  /** Stretch: prefer a shorter queue among those under the cap. */
  STRETCH_QUEUE_PENALTY: 0.2,
  /** Reviews in the window at which the fairness signal saturates. */
  RECENT_SATURATION: 10,
  /** Pair-history count at which the penalty saturates. */
  PAIR_SATURATION: 3,
} as const;

export type ChangeKind = "be" | "fe" | "whole";

export type ChangeClassification = {
  kind: ChangeKind;
  be: number;
  fe: number;
  /** Files that matched neither side (docs, CI yaml, …) — ignored when one side matched. */
  neutral: number;
  reason: string;
};

/** Backend-only → "be"; frontend-only → "fe"; both sides or nothing matched → "whole". */
export function classifyChange(
  paths: string[],
  cfg: Pick<ReviewersConfig, "bePaths" | "fePaths">,
): ChangeClassification {
  let be = 0;
  let fe = 0;
  let neutral = 0;
  for (const p of paths) {
    const isBe = cfg.bePaths.some((pat) => matchesPathPattern(p, pat));
    const isFe = cfg.fePaths.some((pat) => matchesPathPattern(p, pat));
    if (isBe) be++;
    if (isFe) fe++;
    if (!isBe && !isFe) neutral++;
  }
  const kind: ChangeKind = be > 0 && fe === 0 ? "be" : fe > 0 && be === 0 ? "fe" : "whole";
  const why =
    kind === "whole" && be === 0 && fe === 0
      ? "no changed file matched the backend/frontend path mapping"
      : kind === "whole"
        ? "mixed backend and frontend changes"
        : kind === "be"
          ? "backend-only diff"
          : "frontend-only diff";
  return {
    kind,
    be,
    fe,
    neutral,
    reason: `${why} (${String(be)} backend, ${String(fe)} frontend, ${String(neutral)} neutral of ${String(paths.length)} changed files)`,
  };
}

export function teamSlugFor(
  kind: ChangeKind,
  cfg: Pick<ReviewersConfig, "team" | "beTeam" | "feTeam">,
): string {
  return kind === "be" ? cfg.beTeam : kind === "fe" ? cfg.feTeam : cfg.team;
}

export type ExcludedLogin = { login: string; why: "author" | "away" | "excluded" };

/** Hard filters: the PR author, `away` and `exclude` (case-insensitive). */
export function filterRoster(
  members: string[],
  o: { author: string; away: string[]; exclude: string[] },
): { eligible: string[]; excluded: ExcludedLogin[] } {
  const author = o.author.toLowerCase();
  const away = new Set(o.away.map((l) => l.toLowerCase()));
  const exclude = new Set(o.exclude.map((l) => l.toLowerCase()));
  const eligible: string[] = [];
  const excluded: ExcludedLogin[] = [];
  for (const m of members) {
    const l = m.toLowerCase();
    if (l === author) excluded.push({ login: m, why: "author" });
    else if (away.has(l)) excluded.push({ login: m, why: "away" });
    else if (exclude.has(l)) excluded.push({ login: m, why: "excluded" });
    else eligible.push(m);
  }
  return { eligible, excluded };
}

export type CandidateSignals = {
  login: string;
  /** Distinct changed files this candidate committed to within the familiarity window. */
  familiarFiles: number;
  /** False when no commit on the changed paths could be resolved to this login (counted as 0). */
  identityMapped: boolean;
  /** Open PRs where the candidate is a requested reviewer. */
  pending: number;
  /** PRs the candidate reviewed within the recent window. */
  reviewed: number;
  /** PRs reviewed in either direction between author and candidate within the recent window. */
  pair: number;
};

export type ReviewerPick = {
  login: string;
  role: "expert" | "stretch";
  score: number;
  reason: string;
};

export type ScoredCandidate = CandidateSignals & { expertScore: number; stretchScore: number | null };

export type PickResult = {
  expert: ReviewerPick | null;
  stretch: ReviewerPick | null;
  notes: string[];
  scored: ScoredCandidate[];
};

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function reasonFor(
  c: CandidateSignals,
  changedFiles: number,
  cfg: Pick<ReviewersConfig, "queueCap" | "familiarityMonths" | "recentReviewDays">,
): string {
  let s =
    `touched ${String(c.familiarFiles)} of ${String(changedFiles)} changed files in ${String(cfg.familiarityMonths)}mo, ` +
    `${plural(c.pending, "pending review", "pending reviews")}, ` +
    `${plural(c.reviewed, "review", "reviews")} in ${String(cfg.recentReviewDays)}d`;
  if (c.pending >= cfg.queueCap) s += `, at queue cap (${String(cfg.queueCap)})`;
  if (c.pair > 0) s += `, ${plural(c.pair, "PR", "PRs")} reviewed with the author in ${String(cfg.recentReviewDays)}d`;
  if (c.familiarFiles === 0 && !c.identityMapped) {
    s += "; no commit identity resolved to this login (counted as 0)";
  }
  return s;
}

export function pickReviewers(input: {
  candidates: CandidateSignals[];
  changedFiles: number;
  cfg: Pick<ReviewersConfig, "queueCap" | "familiarityMonths" | "recentReviewDays">;
}): PickResult {
  const { candidates, changedFiles, cfg } = input;
  const notes: string[] = [];
  const denom = Math.max(1, changedFiles);

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const f = Math.min(c.familiarFiles, denom) / denom;
    const q = Math.min(c.pending / cfg.queueCap, 1);
    const r = Math.min(c.reviewed, SCORING.RECENT_SATURATION) / SCORING.RECENT_SATURATION;
    const p = Math.min(c.pair, SCORING.PAIR_SATURATION) / SCORING.PAIR_SATURATION;
    const expertScore = f - SCORING.EXPERT_QUEUE_PENALTY * q + SCORING.EXPERT_FAIRNESS_BOOST * (1 - r) - SCORING.PAIR_PENALTY * p;
    const underCap = c.pending < cfg.queueCap;
    const stretchScore = underCap
      ? 1 - f + SCORING.STRETCH_FAIRNESS_BOOST * (1 - r) - SCORING.PAIR_PENALTY * p - SCORING.STRETCH_QUEUE_PENALTY * q
      : null;
    return { ...c, expertScore: r3(expertScore), stretchScore: stretchScore === null ? null : r3(stretchScore) };
  });

  // Deterministic: score desc, then login asc.
  const byScore = (key: "expertScore" | "stretchScore") => (a: ScoredCandidate, b: ScoredCandidate) =>
    (b[key] ?? -Infinity) - (a[key] ?? -Infinity) || a.login.localeCompare(b.login);

  if (candidates.length === 0) {
    notes.push("No eligible candidates after filtering (author / away / exclude) — nothing to suggest.");
    return { expert: null, stretch: null, notes, scored };
  }

  const expertPool = scored.filter((c) => c.familiarFiles > 0).sort(byScore("expertScore"));
  const expertC = expertPool[0];
  const expert: ReviewerPick | null =
    expertC === undefined
      ? null
      : { login: expertC.login, role: "expert", score: expertC.expertScore, reason: reasonFor(expertC, changedFiles, cfg) };
  if (expert === null) {
    notes.push(
      `No Expert: no candidate touched any of the ${String(changedFiles)} changed files in ${String(cfg.familiarityMonths)}mo (or none could be mapped to a commit identity).`,
    );
  }

  const stretchPool = scored
    .filter((c) => c.stretchScore !== null && c.login !== expert?.login)
    .sort(byScore("stretchScore"));
  const stretchC = stretchPool[0];
  const stretch: ReviewerPick | null =
    stretchC === undefined || stretchC.stretchScore === null
      ? null
      : { login: stretchC.login, role: "stretch", score: stretchC.stretchScore, reason: reasonFor(stretchC, changedFiles, cfg) };

  if (candidates.length < 2) {
    notes.push(`Only ${String(candidates.length)} eligible candidate — fewer than 2 eligible, so a second reviewer is not suggested.`);
  } else if (stretch === null) {
    notes.push(
      `No Stretch: every remaining candidate is at/above the queue cap (${String(cfg.queueCap)} pending review requests).`,
    );
  }
  return { expert, stretch, notes, scored };
}

// ---------------------------------------------------------------------------
// Result artifact
// ---------------------------------------------------------------------------

export type ReviewersResult = {
  /** ok = both slots; insufficient = fewer than 2 suggested (honest, not an error); error = lookup failed (loud). */
  status: "ok" | "insufficient" | "error";
  generatedAt: string;
  author: string;
  team: { org: string; slug: string; selection: ChangeKind; reason: string };
  changedFiles: number;
  rosterSize: number;
  expert: ReviewerPick | null;
  stretch: ReviewerPick | null;
  notes: string[];
  excluded: ExcludedLogin[];
  candidates: ScoredCandidate[];
  error?: string;
};

export const REVIEWERS_JSON = "reviewers.json";
export const REVIEWERS_MD = "reviewers.md";

export function renderReviewersMd(r: ReviewersResult): string {
  const head = "# Reviewer suggestions (report-only — nothing was posted to GitHub)\n\n";
  if (r.status === "error") {
    return (
      head +
      `**FAILED — no reviewer was suggested.** ${r.error ?? "unknown error"}\n\n` +
      "There is deliberately no fallback roster. Fix the cause (gh auth, team slug in config.json `reviewers`, network) " +
      "and re-run `dagrun reviewers <run-id>`.\n"
    );
  }
  const line = (label: string, p: ReviewerPick | null): string =>
    p === null ? `- **${label}:** none\n` : `- **${label}:** @${p.login} — ${p.reason}\n`;
  let md = head;
  md += `Roster: ${r.team.org}/${r.team.slug} — ${r.team.reason}; ${String(r.rosterSize)} members, ${String(r.candidates.length)} eligible.\n\n`;
  md += line("Expert", r.expert) + line("Stretch", r.stretch);
  if (r.notes.length > 0) md += "\nNotes:\n" + r.notes.map((n) => `- ${n}\n`).join("");
  if (r.excluded.length > 0) {
    md += `\nFiltered out: ${r.excluded.map((e) => `@${e.login} (${e.why})`).join(", ")}\n`;
  }
  return md;
}

export type ReviewersCheck = { nodeId: "pr"; check: "reviewer-suggestion"; ok: boolean; detail?: string };

/**
 * Pre-PR gate advisory (a brief `validation` entry; never blocking, not part of
 * the revision hash). An ABSENT or unreadable artifact is a ✗, not silence: a
 * pr node that skipped the step must not look like a pr node that ran it.
 */
export function reviewersAdvisory(runDir: string): ReviewersCheck[] {
  const file = join(runDir, "pr", REVIEWERS_JSON);
  const mk = (ok: boolean, detail?: string): ReviewersCheck[] => [
    { nodeId: "pr", check: "reviewer-suggestion", ok, ...(detail !== undefined ? { detail } : {}) },
  ];
  if (!existsSync(file)) {
    return mk(false, `advisory (non-blocking): pr/${REVIEWERS_JSON} is missing — the pr node did not run \`dagrun reviewers\`. Suggest reviewers manually or re-run the pr node.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return mk(false, `advisory (non-blocking): pr/${REVIEWERS_JSON} is not valid JSON (${(e as Error).message.split("\n")[0]})`);
  }
  const r = parsed as Partial<ReviewersResult>;
  if (r.status === "error") {
    return mk(false, `advisory (non-blocking): reviewer lookup FAILED — ${r.error ?? "unknown error"}. No reviewer is suggested; there is no fallback roster.`);
  }
  if (r.status !== "ok" && r.status !== "insufficient") {
    return mk(false, `advisory (non-blocking): pr/${REVIEWERS_JSON} has no valid status`);
  }
  return mk(true);
}
