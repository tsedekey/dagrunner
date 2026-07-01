#!/usr/bin/env node
/**
 * write-build-meta.mjs — stamps the actual compile instant into dist/build-meta.json.
 *
 * Runs as the last step of `npm run build`, right after tsc. Node-builtins-only
 * (no deps) so it works identically in dev and CI. Must run on every build —
 * a compiled dist/ with a stale or missing build-meta.json is a broken build
 * (see src/config/version.ts, which fails loud on that condition).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");

const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

const meta = {
  version: pkg.version,
  buildTime: new Date().toISOString(),
};

writeFileSync(
  join(projectRoot, "dist", "build-meta.json"),
  JSON.stringify(meta, null, 2) + "\n",
  "utf8",
);

process.stdout.write(
  `write-build-meta: dist/build-meta.json (version ${meta.version}, buildTime ${meta.buildTime})\n`,
);
