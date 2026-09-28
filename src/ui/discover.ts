/**
 * discover.ts — enumerate runs under `<homeDir>/runs` for `dagrun ui`'s run list.
 *
 * Deliberately does NOT reuse `runtime/run-engine.ts`'s `listRuns`: that helper
 * silently skips a run whose state.json fails to parse ("Corrupt state — skip"),
 * but the UI brief requires a corrupt/malformed run to surface as an error card
 * in the list, not vanish — "fail loud" for a viewer means "show the failure",
 * never "crash the whole server" and never "pretend it isn't there".
 *
 * Read-only: only reads state.json and directory mtimes. Never writes.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readState } from "../core/state.js";

export type RunListEntry =
  | {
      runId: string;
      workflow: string;
      status: string;
      updatedAt: string;
      error?: undefined;
    }
  | {
      runId: string;
      error: string;
      workflow?: undefined;
      status?: undefined;
      updatedAt?: undefined;
    };

/**
 * All run directories under `<homeDir>/runs`, sorted newest-first by directory
 * mtime (stable even for error entries, which have no updatedAt of their own).
 */
export function discoverRuns(homeDir: string): RunListEntry[] {
  const runsDir = join(homeDir, "runs");
  if (!existsSync(runsDir)) return [];

  const out: Array<RunListEntry & { _mtime: number }> = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    let mtime = 0;
    try {
      mtime = statSync(runDir).mtimeMs;
    } catch {
      mtime = 0;
    }
    const stateFile = join(runDir, "state.json");
    if (!existsSync(stateFile)) {
      if (existsSync(join(runDir, "driver.log"))) {
        out.push({
          runId: entry.name,
          error: "starting — no state.json yet (see driver.log)",
          _mtime: mtime,
        });
      }
      // Otherwise: a bare empty directory. Not an error worth reporting — skip quietly.
      continue;
    }
    try {
      const state = readState(stateFile);
      out.push({
        runId: state.runId,
        workflow: state.workflow,
        status: state.status,
        updatedAt: state.updatedAt,
        _mtime: mtime,
      });
    } catch (e) {
      out.push({
        runId: entry.name,
        error: e instanceof Error ? e.message : String(e),
        _mtime: mtime,
      });
    }
  }

  return out
    .sort((a, b) => b._mtime - a._mtime)
    .map(({ _mtime, ...rest }) => rest);
}
