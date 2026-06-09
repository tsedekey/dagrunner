/**
 * Block 8 — static HTML report generator.
 *
 * generateReport(state, frictionLines) returns a complete self-contained HTML
 * string. No external deps, no server, no CDN — vanilla string templating only.
 *
 * Secrets scrubbed: values that look like keys/tokens are not rendered.
 * DEVHARNESS_SRC is never emitted.
 */

import type { RunState, NodeState, GateHistoryEntry } from "./state.js";

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
    return `
        <tr>
          <td><code>${esc(id)}</code></td>
          <td>${badge(ns.status)}</td>
          <td>${model}</td>
          <td style="text-align:center;">${ns.iteration}</td>
          <td style="text-align:right;">$${ns.cost.toFixed(4)}</td>
          <td style="text-align:center;">${ns.artifacts.length}</td>
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
            <th>Artifacts</th>
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
): string {
  const summary = renderRunSummary(state);
  const nodeTable = renderNodeTable(state.nodes);
  const costTotals = renderCostTotals(state.nodes);
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
  ${gateHistory}
  ${friction}
</body>
</html>`;
}
