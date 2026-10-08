/**
 * artifact.ts — read ONE artifact file for the lazy preview endpoint
 * (`GET /api/runs/:id/artifact?node=&name=`) and render it to safe HTML.
 *
 * Artifact CONTENT never rides in the per-tick snapshot (it can be 500 KB);
 * the client fetches a file only when the user opens it, and re-fetches when
 * the snapshot says its mtime/size changed. Rendering is render.ts — the single
 * escaping path for content. Read-only; refuses anything that could escape the
 * run directory (separators, dot-dot, symlinks pointing elsewhere); keeps the
 * text-extension allowlist and size cap of the original viewer.
 */

import { realpathSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { artifactKindFor, escapeHtml, renderArtifact, type ArtifactKind } from "./render.js";

const TEXT_EXTENSIONS = new Set([".md", ".json", ".diff", ".patch", ".txt", ".log", ".yaml", ".yml"]);
/** Defensive cap independent of any upstream writer's own cap (e.g. changes.diff's 2MB) — this is a viewer, not a file browser. */
export const MAX_PREVIEW_BYTES = 500_000;

export type ArtifactView = {
  node: string;
  name: string;
  kind: ArtifactKind;
  size: number;
  mtime: string;
  /** Escaped HTML (render.ts) or a "not previewed" note — never raw untrusted markup. */
  html: string;
};

export type ArtifactResult = { ok: true; view: ArtifactView } | { ok: false; status: 400 | 404; error: string };

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (s: string): boolean => s !== "" && s !== "." && s !== ".." && SAFE_SEGMENT.test(s);

export function readArtifactView(homeDir: string, runId: string, node: string, name: string): ArtifactResult {
  if (!isSafeSegment(node) || !isSafeSegment(name)) {
    return { ok: false, status: 400, error: "invalid node or file name" };
  }
  const runDir = join(homeDir, "runs", runId);
  const path = join(runDir, node, name);
  let real: string;
  let runReal: string;
  try {
    real = realpathSync(path);
    runReal = realpathSync(runDir);
  } catch {
    return { ok: false, status: 404, error: "not found" };
  }
  if (!real.startsWith(runReal + sep)) {
    return { ok: false, status: 400, error: "path escapes the run directory" };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, status: 404, error: "not found" };
  }
  if (!st.isFile()) return { ok: false, status: 404, error: "not a file" };
  const base = { node, name, kind: artifactKindFor(name), size: st.size, mtime: st.mtime.toISOString() };
  if (st.size > MAX_PREVIEW_BYTES) {
    return {
      ok: true,
      view: { ...base, html: `<p class="muted">Not previewed — ${st.size} bytes exceeds the ${MAX_PREVIEW_BYTES}B preview cap. Path: <code>${escapeHtml(path)}</code></p>` },
    };
  }
  if (!TEXT_EXTENSIONS.has(extname(name))) {
    return {
      ok: true,
      view: { ...base, html: `<p class="muted">Not previewed — not a recognized text artifact type. Path: <code>${escapeHtml(path)}</code></p>` },
    };
  }
  try {
    return { ok: true, view: { ...base, html: renderArtifact(name, readFileSync(real, "utf8")) } };
  } catch (e) {
    return {
      ok: true,
      view: { ...base, html: `<p class="muted">Could not read file: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>` },
    };
  }
}
