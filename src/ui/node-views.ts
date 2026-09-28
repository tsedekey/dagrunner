/**
 * node-views.ts — turns a RunSnapshot's per-node artifact LISTING into actual
 * rendered PREVIEWS, by reading each file's content off disk. Split out from
 * server.ts so this fs-touching, rendering-dispatching logic is unit-testable
 * against a real temp directory without an HTTP server.
 *
 * Read-only. A file that is too large, not a recognized text type, or fails
 * to read degrades to a note in place of content — never throws, never
 * crashes the page render.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { RunSnapshot } from "./run-snapshot.js";
import type { NodeView, NodeArtifactView } from "./page.js";
import { escapeHtml, renderArtifact } from "./render.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".json",
  ".diff",
  ".patch",
  ".txt",
  ".log",
  ".yaml",
  ".yml",
]);
/** Defensive cap independent of any upstream writer's own cap (e.g. changes.diff's 2MB) — this is a viewer, not a file browser. */
export const MAX_PREVIEW_BYTES = 500_000;

function previewHtml(path: string, size: number | null): string {
  if (size !== null && size > MAX_PREVIEW_BYTES) {
    return `<p class="muted">Not previewed — ${size} bytes exceeds the ${MAX_PREVIEW_BYTES}B preview cap. Path: <code>${escapeHtml(path)}</code></p>`;
  }
  const ext = extname(path);
  if (!TEXT_EXTENSIONS.has(ext)) {
    return `<p class="muted">Not previewed — not a recognized text artifact type. Path: <code>${escapeHtml(path)}</code></p>`;
  }
  try {
    return renderArtifact(path, readFileSync(path, "utf8"));
  } catch (e) {
    return `<p class="muted">Could not read file: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

/** Build every node's view (including artifact previews) for a run, in the snapshot's declared pipeline order. */
export function buildNodeViews(snapshot: RunSnapshot): NodeView[] {
  return snapshot.nodeOrder.map((id): NodeView => {
    const n = snapshot.nodes[id];
    if (n === undefined) {
      // Node exists in the workflow definition but not yet in this run's state
      // (a stale run from an older workflow version) — render as untouched, never throw.
      return {
        id,
        status: "pending",
        iteration: 0,
        durationMs: null,
        cost: 0,
        startedAt: null,
        endedAt: null,
        artifacts: [],
        gateHistory: [],
      };
    }
    const artifacts: NodeArtifactView[] = n.artifacts.map(
      (a): NodeArtifactView => ({
        path: a.path,
        name: basename(a.path),
        registered: a.registered,
        size: a.size,
        mtime: a.mtime,
        html: previewHtml(a.path, a.size),
      }),
    );
    return {
      id,
      status: n.status,
      iteration: n.iteration,
      durationMs: n.durationMs,
      cost: n.cost,
      startedAt: n.startedAt,
      endedAt: n.endedAt,
      artifacts,
      gateHistory: n.gateHistory,
    };
  });
}
