/**
 * siblings-run-id.test.ts — every phase script of the run-scoped sibling
 * commands (pr-triage, ci-babysit) must resolve the run id exactly like phase 0:
 * `--run-id <id>` argument > $DAGRUN_RUN_ID > sanitized branch name.
 *
 * Bug: only phase-0 parsed `--run-id`; phases 1+ used the branch-derived id, so
 * from a non-dagrunner checkout with `--run-id X` they failed with
 * "State file not found … runs/<branch>/pr-triage/…".
 *
 * Method: run each phase under `zsh -x` in a throwaway git repo with a throwaway
 * HOME and read the traced ARTIFACTS_DIR assignment. The scripts fail fast right
 * after (no state files exist), which is fine — we only inspect the path they
 * resolved. Nothing outside the temp dirs is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = new URL("../../payload/siblings/scripts/", import.meta.url).pathname;
const zshAvailable = spawnSync("zsh", ["-c", "true"]).status === 0;

/** Phases (>= 1) that exist for each run-scoped sibling; phase 0 already parses --run-id. */
function laterPhases(sibling: string): string[] {
  return readdirSync(join(SCRIPTS, sibling))
    .filter((f) => /^phase-[1-9]\w*-.*\.sh$/.test(f))
    .sort();
}

function sandbox(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dr-sib-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "feature/foo", repo]);
  // rev-parse --abbrev-ref HEAD needs a commit
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return { repo, home: join(root, "home") };
}

function resolvedArtifactsDir(sibling: string, phase: string, args: string[], env: Record<string, string> = {}): string {
  const { repo, home } = sandbox();
  const r = spawnSync("zsh", ["-x", join(SCRIPTS, sibling, phase), ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, ...env },
  });
  const m = /ARTIFACTS_DIR=(\S+)/.exec(r.stderr);
  assert.ok(m, `${sibling}/${phase}: no ARTIFACTS_DIR assignment traced.\n${r.stderr.slice(0, 600)}`);
  return m[1] as string;
}

for (const sibling of ["pr-triage", "ci-babysit"]) {
  test(`${sibling}: every later phase honours --run-id (not the branch-derived id)`, { skip: !zshAvailable }, () => {
    const phases = laterPhases(sibling);
    assert.ok(phases.length > 0);
    for (const phase of phases) {
      const dir = resolvedArtifactsDir(sibling, phase, ["--run-id 12345-1"]);
      assert.match(dir, /\/runs\/12345-1\//, `${sibling}/${phase} resolved ${dir}`);
      assert.ok(!dir.includes("feature-foo"), `${sibling}/${phase} fell back to the branch id: ${dir}`);
    }
  });

  test(`${sibling}: without --run-id the precedence is DAGRUN_RUN_ID then the sanitized branch`, { skip: !zshAvailable }, () => {
    for (const phase of laterPhases(sibling)) {
      assert.match(resolvedArtifactsDir(sibling, phase, []), /\/runs\/feature-foo\//, `${phase}: branch fallback`);
      assert.match(resolvedArtifactsDir(sibling, phase, [""], { DAGRUN_RUN_ID: "env-7" }), /\/runs\/env-7\//, `${phase}: env`);
      // explicit argument wins over the env var, like phase 0
      assert.match(
        resolvedArtifactsDir(sibling, phase, ["--pr 9 --run-id arg-3"], { DAGRUN_RUN_ID: "env-7" }),
        /\/runs\/arg-3\//,
        `${phase}: arg beats env`,
      );
    }
  });
}
