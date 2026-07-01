/**
 * version.ts — dagrunner's own package version + build timestamp.
 *
 * Single source of truth for "which build of dagrun is this?" — surfaced by
 * `dagrun preflight` and `dagrun start` so the operator can confirm the
 * running binary before a workflow starts mutating anything.
 *
 * Scope note: this is dagrunner's OWN package version (package.json), not
 * the Claude CLI toolchain pin (EXPECTED_CLAUDE_CLI_VERSION) described in
 * the master doc §7 — that module does not exist yet and is out of scope
 * here. Do not conflate the two.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

export interface VersionInfo {
  /** dagrunner's own package.json version. */
  version: string;
  /** Human-readable build timestamp, e.g. "2026-07-01 14:32:05 UTC", or "unbuilt (dev)". */
  buildTime: string;
  /** True when running from src/ (via tsx), false when running from compiled dist/. */
  isDev: boolean;
}

interface BuildMeta {
  version: string;
  buildTime: string;
}

/** Render an ISO timestamp as "YYYY-MM-DD HH:MM:SS UTC" for a human glancing at a terminal. */
function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/**
 * Resolve version + build info for the running dagrun binary.
 *
 * @param moduleUrl  `import.meta.url` of this module by default. Overridable so
 *                   tests can fixture-inject a fake module URL / temp layout
 *                   without touching the real project tree.
 *
 * Walk-up: this file lives at `<root>/src/config/version.ts` (dev, via tsx) or
 * `<root>/dist/config/version.js` (compiled) — both are exactly two
 * directories below the project root. The walk-up itself makes no src/dist
 * assumption; only the build-meta branch below does.
 */
export function getVersionInfo(
  moduleUrl: string = import.meta.url,
): VersionInfo {
  const fileDir = dirname(fileURLToPath(moduleUrl));
  const projectRoot = join(fileDir, "..", "..");

  const pkgPath = join(projectRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  const version = pkg.version;

  const isDev = !fileDir.includes(`${sep}dist${sep}`);

  if (isDev) {
    return { version, buildTime: "unbuilt (dev)", isDev: true };
  }

  // Compiled build: a missing/unparsable build-meta.json is a broken release
  // build, not a dev-loop annoyance — fail loud.
  const buildMetaPath = join(projectRoot, "dist", "build-meta.json");
  if (!existsSync(buildMetaPath)) {
    throw new Error(
      `dagrun: broken build — missing ${buildMetaPath}. Run "npm run build".`,
    );
  }

  let buildMeta: BuildMeta;
  try {
    buildMeta = JSON.parse(readFileSync(buildMetaPath, "utf8")) as BuildMeta;
  } catch (e) {
    throw new Error(
      `dagrun: broken build — could not parse ${buildMetaPath}: ${(e as Error).message}`,
    );
  }

  return {
    version,
    buildTime: formatBuildTime(buildMeta.buildTime),
    isDev: false,
  };
}

/** One-line banner: "dagrun v0.1.1 — built 2026-07-01 14:32:05 UTC" or "... — (dev, unbuilt)". */
export function formatVersionBanner(info: VersionInfo): string {
  const built = info.isDev ? "(dev, unbuilt)" : `built ${info.buildTime}`;
  return `dagrun v${info.version} — ${built}`;
}
