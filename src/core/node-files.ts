/**
 * node-files.ts — what is actually on disk in a node's artifact dir.
 *
 * `state.nodes[id].artifacts` is only written when a node finishes/approves, so
 * a viewer at a gate saw an empty list although the files existed. This lists
 * the real files (registered ones first, in state order, then the rest) so the
 * gate brief and `status --json` agree with the disk. Engine bookkeeping is
 * excluded unless a node already registered it.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type NodeFile = {
  path: string;
  registered: boolean;
  /** null only for a registered path that no longer exists. */
  size: number | null;
  mtime: string | null;
};

const BOOKKEEPING = new Set([
  "transcript.log",
  "burn.json",
  "gate.json",
  "gate-context.md",
  "gate-decision.md",
]);

const stat = (p: string): { size: number | null; mtime: string | null } => {
  try {
    const s = statSync(p);
    return { size: s.size, mtime: s.mtime.toISOString() };
  } catch {
    return { size: null, mtime: null };
  }
};

export function listNodeFiles(runDir: string, nodeId: string, registered: readonly string[]): NodeFile[] {
  const dir = join(runDir, nodeId);
  const out: NodeFile[] = registered.map((path) => ({ path, registered: true, ...stat(path) }));
  const have = new Set(registered);
  if (!existsSync(dir)) return out;
  const extra = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !BOOKKEEPING.has(e.name) && !have.has(join(dir, e.name)))
    .map((e) => e.name)
    .sort();
  for (const name of extra) {
    const path = join(dir, name);
    out.push({ path, registered: false, ...stat(path) });
  }
  return out;
}
