/**
 * reviewers-config.ts — the optional `reviewers` block of config.json, which
 * drives the pr node's reviewer SUGGESTION (core/reviewers.ts, `dagrun
 * reviewers`). Org and team slugs are config-driven, never hard-coded in the
 * suggestion code; the defaults below are Eddie's team (documented in
 * DECISIONS.md § reviewer-suggestion) and exist so an unconfigured install works.
 *
 * Validated at LOAD time: an unknown key, a bad slug/login, a non-integer cap or
 * an unsupported glob is an error naming the field — never a silently empty
 * roster at PR time. An ABSENT block means "defaults"; a PRESENT-but-malformed
 * block is a load error.
 */

export type ReviewersConfig = {
  /** GitHub org that owns the teams and whose PR queues are counted. */
  org: string;
  /** Whole-team slug (used for mixed / unmatched diffs). */
  team: string;
  /** Backend subteam slug (backend-only diffs). */
  beTeam: string;
  /** Frontend subteam slug (frontend-only diffs). */
  feTeam: string;
  /** Path patterns that mark a changed file as backend. See matchesPathPattern. */
  bePaths: string[];
  /** Path patterns that mark a changed file as frontend. */
  fePaths: string[];
  /** GitHub logins that are away — never suggested (lower-cased). */
  away: string[];
  /** GitHub logins never suggested for any reason (lower-cased). */
  exclude: string[];
  /** Open review-requested PRs at/above which a candidate is excluded from Stretch and penalised in Expert. */
  queueCap: number;
  /** Look-back window for path familiarity, in months. */
  familiarityMonths: number;
  /** Look-back window for recent reviews / pair history, in days. */
  recentReviewDays: number;
};

export const DEFAULT_REVIEWERS_CONFIG: Readonly<ReviewersConfig> = {
  org: "camunda",
  team: "core-features-alpha",
  beTeam: "core-features-alpha-be",
  feTeam: "core-features-alpha-fe",
  // Camunda monorepo: backend is Java (+ maven/proto); frontend is the four
  // webapp client trees plus TS/JS/style sources anywhere (e.g. qa e2e).
  bePaths: ["*.java", "*.proto", "pom.xml"],
  fePaths: [
    "operate/client/",
    "tasklist/client/",
    "identity/client/",
    "optimize/client/",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.scss",
    "*.css",
  ],
  away: [],
  exclude: [],
  queueCap: 3,
  familiarityMonths: 12,
  recentReviewDays: 30,
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const KEYS = Object.keys(DEFAULT_REVIEWERS_CONFIG);

/**
 * Path pattern semantics (deliberately tiny — no glob engine):
 *   "*.ext"   — basename ends with ".ext"
 *   "dir/"    — path starts with "dir/"
 *   "name"    — basename equals "name" (no slash in the pattern)
 *   "a/b.txt" — exact path
 */
export function matchesPathPattern(path: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!pattern.includes("/")) return path === pattern || path.endsWith(`/${pattern}`);
  return path === pattern;
}

function str(v: unknown, field: string, re: RegExp, what: string): string {
  if (typeof v !== "string" || !re.test(v)) {
    throw new Error(`reviewers.${field} must be a ${what} (got ${JSON.stringify(v)})`);
  }
  return v;
}

function list(v: unknown, field: string, each: (item: unknown, at: string) => string): string[] {
  if (!Array.isArray(v)) throw new Error(`reviewers.${field} must be an array (got ${JSON.stringify(v)})`);
  return v.map((item, i) => each(item, `${field}[${String(i)}]`));
}

function posInt(v: unknown, field: string, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
    throw new Error(`reviewers.${field} must be a positive integer ≤ ${String(max)} (got ${JSON.stringify(v)})`);
  }
  return v;
}

function pathPattern(item: unknown, at: string): string {
  if (typeof item !== "string" || item.trim() === "") {
    throw new Error(`reviewers.${at} must be a non-empty string (got ${JSON.stringify(item)})`);
  }
  const star = item.indexOf("*");
  if (/[?[\]{}]/.test(item) || (star !== -1 && !(star === 0 && item.startsWith("*.") && !item.slice(1).includes("*")))) {
    throw new Error(
      `reviewers.${at} uses an unsupported glob (${JSON.stringify(item)}): only "*.ext", "dir/", a bare filename or an exact path are supported`,
    );
  }
  return item;
}

function login(item: unknown, at: string): string {
  return str(item, at, LOGIN, "GitHub login").toLowerCase();
}

/** Validate the raw `reviewers` value from config.json; `undefined` → defaults. Throws a field-naming Error. */
export function parseReviewersConfig(raw: unknown): ReviewersConfig {
  const out: ReviewersConfig = {
    ...DEFAULT_REVIEWERS_CONFIG,
    bePaths: [...DEFAULT_REVIEWERS_CONFIG.bePaths],
    fePaths: [...DEFAULT_REVIEWERS_CONFIG.fePaths],
    away: [],
    exclude: [],
  };
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`reviewers must be an object (got ${JSON.stringify(raw)})`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!KEYS.includes(k)) {
      throw new Error(`reviewers: unknown key "${k}" (allowed: ${KEYS.join(", ")})`);
    }
  }
  if ("org" in r) out.org = str(r["org"], "org", SLUG, "GitHub org slug");
  if ("team" in r) out.team = str(r["team"], "team", SLUG, "team slug");
  if ("beTeam" in r) out.beTeam = str(r["beTeam"], "beTeam", SLUG, "team slug");
  if ("feTeam" in r) out.feTeam = str(r["feTeam"], "feTeam", SLUG, "team slug");
  if ("bePaths" in r) out.bePaths = list(r["bePaths"], "bePaths", pathPattern);
  if ("fePaths" in r) out.fePaths = list(r["fePaths"], "fePaths", pathPattern);
  if ("away" in r) out.away = list(r["away"], "away", login);
  if ("exclude" in r) out.exclude = list(r["exclude"], "exclude", login);
  if ("queueCap" in r) out.queueCap = posInt(r["queueCap"], "queueCap", 100);
  if ("familiarityMonths" in r) out.familiarityMonths = posInt(r["familiarityMonths"], "familiarityMonths", 120);
  if ("recentReviewDays" in r) out.recentReviewDays = posInt(r["recentReviewDays"], "recentReviewDays", 365);
  return out;
}
