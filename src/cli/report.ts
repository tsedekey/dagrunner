/**
 * Block 8 — static HTML report generator.
 *
 * generateReport(state, frictionLines, burnByNode) returns a complete
 * self-contained HTML string. No external deps, no server, no CDN — vanilla
 * string templating only.
 *
 * Secrets scrubbed: values that look like keys/tokens are not rendered.
 * DEVHARNESS_SRC is never emitted.
 *
 * Burn Monitor Deliverable 2: renders each node's already-captured
 * burn.json (D1) — cache-creation/read split, output tokens, per-tier mix
 * (derived.tierMix) AND the raw per-model breakdown (models[] — the D1
 * empirical motivation: a node's modelUsage can carry multiple distinct
 * model ids, e.g. the review node's opus-tier parent + sonnet-tier
 * reviewer-subagent fan-out), plus hotspot badges (cold-reload-tax /
 * tier-leak / fat-fixed-prefix / output-heavy) computed by the pure
 * functions in runtime/burn.ts. This module stays pure (no fs) — cli.ts
 * reads burn.json per node and passes the resulting map in. intraNode
 * stays null / phase stays "rollup" for the lifetime of this deliverable
 * — no transcript-level rendering here.
 */

import type { RunState, NodeState, GateHistoryEntry } from "../core/state.js";
import {
  type BurnDoc,
  type BurnDocOk,
  type BurnModelEntry,
  type HotspotFlag,
  type Tier,
  type TierMix,
  cacheColdRatio,
  computeFatPrefixFlaggedNodes,
  computeNodeHotspots,
  declaredTierFromModel,
} from "../runtime/burn.js";

// ---------------------------------------------------------------------------
// HTML-escape (prevents XSS from gate comments, paths, error strings)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Status badge colours
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  done: "#2e7d32",
  failed: "#c62828",
  skipped: "#757575",
  "awaiting-gate": "#e65100",
  pending: "#bdbdbd",
  running: "#1565c0",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  done: "#fff",
  failed: "#fff",
  skipped: "#fff",
  "awaiting-gate": "#fff",
  pending: "#333",
  running: "#fff",
};

function badge(status: string): string {
  const bg = STATUS_COLORS[status] ?? "#9e9e9e";
  const fg = STATUS_TEXT_COLORS[status] ?? "#fff";
  return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:3px;font-size:0.85em;font-weight:600;">${esc(status)}</span>`;
}

// ---------------------------------------------------------------------------
// Number formatting — locale-independent (no toLocaleString: default-locale
// behaviour is machine-dependent and would make the golden snapshot flaky
// across environments). Non-negative integers only (token counts).
// ---------------------------------------------------------------------------

function formatInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function renderRunSummary(state: RunState): string {
  return `
    <section>
      <h2>Run Summary</h2>
      <table>
        <tr><th>Run ID</th><td><code>${esc(state.runId)}</code></td></tr>
        <tr><th>Workflow</th><td>${esc(state.workflow)}</td></tr>
        <tr><th>Status</th><td>${badge(state.status)}</td></tr>
        <tr><th>Created</th><td>${esc(state.createdAt)}</td></tr>
        <tr><th>Updated</th><td>${esc(state.updatedAt)}</td></tr>
        <tr><th>Worktree</th><td><code>${esc(state.worktreePath)}</code></td></tr>
        <tr><th>Branch</th><td><code>${esc(state.branch)}</code></td></tr>
      </table>
    </section>`;
}

function renderNodeTable(nodes: Record<string, NodeState>): string {
  const rows = Object.entries(nodes).map(([id, ns]: [string, NodeState]) => {
    const error = ns.error ? esc(ns.error) : "&mdash;";
    const model = ns.model ? esc(ns.model) : "&mdash;";
    const firstArtifact = ns.artifacts[0];
    const artifactCell =
      firstArtifact !== undefined
        ? `<a href="file://${esc(firstArtifact)}" style="font-family:monospace;font-size:0.85em;">${esc(firstArtifact.split("/").pop() ?? firstArtifact)}</a>`
        : "&mdash;";
    return `
        <tr>
          <td><code>${esc(id)}</code></td>
          <td>${badge(ns.status)}</td>
          <td style="font-size:0.85em;">${model}</td>
          <td style="text-align:center;">${ns.iteration}</td>
          <td style="text-align:right;">$${ns.cost.toFixed(4)}</td>
          <td>${artifactCell}</td>
          <td style="font-size:0.85em;color:#c62828;">${error}</td>
        </tr>`;
  });

  return `
    <section>
      <h2>Node Status</h2>
      <table>
        <thead>
          <tr>
            <th>Node</th>
            <th>Status</th>
            <th>Model</th>
            <th>Iterations</th>
            <th>Cost (USD)</th>
            <th>Artifact</th>
            <th>Last Error</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </section>`;
}

function renderCostTotals(nodes: Record<string, NodeState>): string {
  const total = Object.values(nodes).reduce(
    (sum: number, ns: NodeState) => sum + ns.cost,
    0,
  );
  return `
    <section>
      <h2>Cost Totals</h2>
      <table>
        <tr><th>Total Cost</th><td><strong>$${total.toFixed(4)}</strong></td></tr>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Burn & Hotspots (Burn Monitor Deliverable 2)
// ---------------------------------------------------------------------------

const HOTSPOT_COLORS: Record<HotspotFlag["kind"], string> = {
  "cold-reload-tax": "#ef6c00",
  "tier-leak": "#c62828",
  "fat-fixed-prefix": "#6a1b9a",
  "output-heavy": "#00838f",
};

function hotspotDetail(flag: HotspotFlag): string {
  switch (flag.kind) {
    case "cold-reload-tax":
      return `cold-reload tax — ${(flag.cacheColdRatio * 100).toFixed(0)}% cold`;
    case "tier-leak":
      return `tier leak — declared ${flag.declaredTier}, leaked into ${flag.leakedTiers.join(", ")}`;
    case "fat-fixed-prefix":
      return `fat fixed prefix — ${formatInt(flag.cacheCreationTokens)} cache-creation tokens`;
    case "output-heavy":
      return `output-heavy — ${(flag.outputShare * 100).toFixed(0)}% output`;
  }
}

function hotspotBadge(flag: HotspotFlag): string {
  const bg = HOTSPOT_COLORS[flag.kind];
  return `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:3px;font-size:0.8em;font-weight:600;margin:0 4px 4px 0;display:inline-block;">${esc(hotspotDetail(flag))}</span>`;
}

const REAL_TIERS_FOR_DISPLAY: ReadonlyArray<Exclude<Tier, "unknown">> = [
  "opus",
  "sonnet",
  "haiku",
];

/** Renders a node's per-tier token mix. tierMix.unknown tokens are ALWAYS
 * rendered visibly (never silently dropped) — burn.json's own fail-loud
 * principle (see runtime/burn.ts) extends to the report. */
function renderTierMix(mix: TierMix): string {
  const known = REAL_TIERS_FOR_DISPLAY.filter((t) => mix[t] > 0).map(
    (t) => `${t}: ${formatInt(mix[t])}`,
  );
  const knownHtml = known.length > 0 ? esc(known.join(", ")) : "&mdash;";
  if (mix.unknown > 0) {
    return `${knownHtml}<br><span style="color:#c62828;font-size:0.85em;">unclassified: ${formatInt(mix.unknown)} tokens</span>`;
  }
  return knownHtml;
}

/** Renders one line per model in `models[]` — the raw per-model breakdown
 * the SDK's `modelUsage` result carries (D1's whole empirical motivation:
 * the `review` node's `modelUsage` had two distinct keys, the opus-tier
 * parent and the sonnet-tier reviewer-subagent fan-out — tierMix alone
 * aggregates that away, so this renders `models[]` directly per node,
 * alongside the tier-mix aggregate). One line per model: its total
 * tokens (input+output+cacheRead+cacheCreation, matching computeTierMix's
 * definition) and its own costUSD. */
function renderModelBreakdown(models: BurnModelEntry[]): string {
  if (models.length === 0) return "&mdash;";
  const lines = models.map((m) => {
    const total =
      m.inputTokens +
      m.outputTokens +
      m.cacheReadInputTokens +
      m.cacheCreationInputTokens;
    return `${m.model}: ${formatInt(total)} tok ($${m.costUSD.toFixed(4)})`;
  });
  return esc(lines.join(" | "));
}

function renderBurnSection(
  nodes: Record<string, NodeState>,
  burnByNode: Record<string, BurnDoc | undefined>,
): string {
  const okDocsByNode: Record<string, BurnDocOk> = {};
  for (const [id, doc] of Object.entries(burnByNode)) {
    if (doc !== undefined && !("error" in doc)) okDocsByNode[id] = doc;
  }
  const fatPrefixFlagged = computeFatPrefixFlaggedNodes(okDocsByNode);

  const rows = Object.entries(nodes).map(([id, ns]) => {
    const doc = burnByNode[id];

    if (doc === undefined) {
      return `
        <tr>
          <td><code>${esc(id)}</code></td>
          <td colspan="6" style="color:#757575;font-style:italic;">no burn data</td>
        </tr>`;
    }

    if ("error" in doc) {
      return `
        <tr>
          <td><code>${esc(id)}</code></td>
          <td colspan="6" style="color:#757575;font-style:italic;">no burn data (${esc(doc.error)})</td>
        </tr>`;
    }

    const declaredTier = declaredTierFromModel(ns.model);
    const flags = computeNodeHotspots({
      derived: doc.derived,
      declaredTier,
      fatPrefixFlagged: fatPrefixFlagged.has(id),
    });
    const badges =
      flags.length > 0 ? flags.map(hotspotBadge).join("") : "&mdash;";

    return `
        <tr>
          <td><code>${esc(id)}</code></td>
          <td style="text-align:right;">${formatInt(doc.derived.cacheCreationTokens)}</td>
          <td style="text-align:right;">${formatInt(doc.derived.cacheReadTokens)}</td>
          <td style="text-align:right;">${formatInt(doc.derived.outputTokens)}</td>
          <td>${renderTierMix(doc.derived.tierMix)}</td>
          <td style="font-size:0.85em;">${renderModelBreakdown(doc.models)}</td>
          <td>${badges}</td>
        </tr>`;
  });

  return `
    <section>
      <h2>Burn &amp; Hotspots</h2>
      <table>
        <thead>
          <tr>
            <th>Node</th>
            <th>Cache-Creation</th>
            <th>Cache-Read</th>
            <th>Output</th>
            <th>Tier Mix</th>
            <th>Per-Model</th>
            <th>Hotspots</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </section>`;
}

function renderBurnRollup(
  burnByNode: Record<string, BurnDoc | undefined>,
): string {
  const okDocs = Object.values(burnByNode).filter(
    (d): d is BurnDocOk => d !== undefined && !("error" in d),
  );
  if (okDocs.length === 0) return "";

  let cacheCreation = 0;
  let cacheRead = 0;
  let output = 0;
  const tierTotals: TierMix = { opus: 0, sonnet: 0, haiku: 0, unknown: 0 };
  for (const doc of okDocs) {
    cacheCreation += doc.derived.cacheCreationTokens;
    cacheRead += doc.derived.cacheReadTokens;
    output += doc.derived.outputTokens;
    for (const t of REAL_TIERS_FOR_DISPLAY) {
      tierTotals[t] += doc.derived.tierMix[t];
    }
    tierTotals.unknown += doc.derived.tierMix.unknown;
  }
  const runColdRatio = cacheColdRatio(cacheCreation, cacheRead);

  return `
    <section>
      <h2>Token Rollup</h2>
      <table>
        <tr><th>Cache-Creation Tokens</th><td style="text-align:right;">${formatInt(cacheCreation)}</td></tr>
        <tr><th>Cache-Read Tokens</th><td style="text-align:right;">${formatInt(cacheRead)}</td></tr>
        <tr><th>Output Tokens</th><td style="text-align:right;">${formatInt(output)}</td></tr>
        <tr><th>Cold-Reload Tax (run-wide)</th><td style="text-align:right;">${(runColdRatio * 100).toFixed(1)}%</td></tr>
        <tr><th>Opus Tokens</th><td style="text-align:right;">${formatInt(tierTotals.opus)}</td></tr>
        <tr><th>Sonnet Tokens</th><td style="text-align:right;">${formatInt(tierTotals.sonnet)}</td></tr>
        <tr><th>Haiku Tokens</th><td style="text-align:right;">${formatInt(tierTotals.haiku)}</td></tr>
        <tr><th>Unclassified Tokens</th><td style="text-align:right;">${formatInt(tierTotals.unknown)}</td></tr>
      </table>
    </section>`;
}

function renderGateHistory(nodes: Record<string, NodeState>): string {
  const sections: string[] = [];

  for (const [id, ns] of Object.entries(nodes)) {
    if (!ns.gateHistory || ns.gateHistory.length === 0) continue;

    const rows = ns.gateHistory.map((entry: GateHistoryEntry) => {
      const decisionColor =
        entry.decision === "approve" ? "#2e7d32" : "#c62828";
      const comment = entry.comment ? esc(entry.comment) : "&mdash;";
      return `
          <tr>
            <td style="color:${decisionColor};font-weight:600;">${esc(entry.decision)}</td>
            <td>${comment}</td>
            <td>${esc(entry.timestamp)}</td>
          </tr>`;
    });

    sections.push(`
      <h3>Node: <code>${esc(id)}</code></h3>
      <table>
        <thead>
          <tr><th>Decision</th><th>Comment</th><th>Timestamp</th></tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>`);
  }

  if (sections.length === 0) return "";

  return `
    <section>
      <h2>Gate History</h2>
      ${sections.join("")}
    </section>`;
}

function renderFriction(frictionLines: string[]): string {
  if (frictionLines.length === 0) return "";
  const last20 = frictionLines.slice(-20);
  return `
    <section>
      <h2>Friction Log (last ${last20.length} lines)</h2>
      <pre>${last20.map(esc).join("\n")}</pre>
    </section>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateReport(
  state: RunState,
  frictionLines: string[],
  burnByNode: Record<string, BurnDoc | undefined> = {},
): string {
  const summary = renderRunSummary(state);
  const nodeTable = renderNodeTable(state.nodes);
  const costTotals = renderCostTotals(state.nodes);
  const burnSection = renderBurnSection(state.nodes, burnByNode);
  const burnRollup = renderBurnRollup(burnByNode);
  const gateHistory = renderGateHistory(state.nodes);
  const friction = renderFriction(frictionLines);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>dagrun report — ${esc(state.runId)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 14px;
      line-height: 1.5;
      color: #212121;
      background: #fafafa;
      margin: 0;
      padding: 24px;
    }
    h1 { font-size: 1.4em; margin-bottom: 0.25em; }
    h2 { font-size: 1.1em; margin-top: 1.5em; margin-bottom: 0.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; }
    h3 { font-size: 1em; margin-top: 1em; margin-bottom: 0.4em; }
    section { margin-bottom: 2em; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.5em; }
    th, td { padding: 6px 10px; text-align: left; border: 1px solid #e0e0e0; }
    th { background: #f5f5f5; font-weight: 600; white-space: nowrap; }
    tr:nth-child(even) td { background: #fafafa; }
    code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 0.95em; }
    pre {
      background: #263238;
      color: #cfd8dc;
      padding: 12px 16px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.88em;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .header-bar {
      background: #1565c0;
      color: #fff;
      padding: 12px 24px;
      margin: -24px -24px 24px -24px;
    }
    .header-bar h1 { color: #fff; margin: 0; }
    .header-bar .subtitle { font-size: 0.85em; opacity: 0.85; }
  </style>
</head>
<body>
  <div class="header-bar">
    <h1>dagrun report</h1>
    <div class="subtitle">Run ID: ${esc(state.runId)} &nbsp;|&nbsp; ${esc(state.workflow)} &nbsp;|&nbsp; ${badge(state.status)}</div>
  </div>

  ${summary}
  ${nodeTable}
  ${costTotals}
  ${burnSection}
  ${burnRollup}
  ${gateHistory}
  ${friction}
</body>
</html>`;
}
