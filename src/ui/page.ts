/**
 * page.ts — the single self-contained HTML page `dagrun ui` serves.
 *
 * Pure string templating (CLAUDE.md: "vanilla HTML string-templating, no
 * React/Vite/Tailwind/build step"). Takes already-computed view data (all fs
 * reads and artifact rendering happen in server.ts) so this module is a pure
 * function of its input and unit-testable without a filesystem or an HTTP
 * server. CSS and JS are inlined directly into the document — deliberately
 * NOT split into separate static files, since that would need a dist-copy
 * build step this project's "no build step" rule forbids (DECISIONS.md
 * § agent-driven-slice3-ui); the brief's "inline or same-origin" constraint
 * explicitly allows this.
 *
 * Progressive, not JS-required: every node row is a native `<details>` (no JS
 * needed to expand/collapse) and artifact content is rendered server-side, so
 * a no-JS page load already shows the real timeline. The inline `<script>`
 * only adds: an SSE-driven live event tail, a ticking elapsed-time readout,
 * theme toggle persistence, and a "copy gate show command" button.
 */

import { escapeHtml } from "./render.js";
import type { RunListEntry } from "./discover.js";
import type { RunSnapshot } from "./run-snapshot.js";
import type { GateHistoryEntry } from "../core/state.js";

export type NodeArtifactView = {
  path: string;
  name: string;
  registered: boolean;
  size: number | null;
  mtime: string | null;
  /** Already-rendered HTML (see render.ts), or a "not previewed" note — never raw untrusted markup. */
  html: string;
};

export type NodeView = {
  id: string;
  status: string;
  iteration: number;
  durationMs: number | null;
  cost: number;
  startedAt: string | null;
  endedAt: string | null;
  artifacts: NodeArtifactView[];
  gateHistory: GateHistoryEntry[];
};

export type PageData = {
  runs: RunListEntry[];
  selectedRunId: string | null;
  /** Set when selectedRunId was given but failed to load (bad id, corrupt state, etc). */
  selectedError: string | null;
  run: RunSnapshot | null;
  nodeViews: NodeView[];
};

const STATUS_META: Record<
  string,
  { icon: string; label: string; cls: string }
> = {
  pending: { icon: "○", label: "pending", cls: "pending" },
  running: { icon: "◐", label: "running", cls: "running" },
  done: { icon: "✓", label: "done", cls: "done" },
  skipped: { icon: "⊘", label: "skipped", cls: "skipped" },
  failed: { icon: "✗", label: "failed", cls: "failed" },
  "awaiting-gate": { icon: "⏸", label: "awaiting decision", cls: "awaiting" },
};

function statusMeta(status: string): {
  icon: string;
  label: string;
  cls: string;
} {
  return STATUS_META[status] ?? { icon: "?", label: status, cls: "unknown" };
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function railHtml(runs: RunListEntry[], selectedRunId: string | null): string {
  const items = runs
    .map((r) => {
      if (r.error !== undefined) {
        return `<li class="run-entry run-error"><span class="run-id">${escapeHtml(r.runId)}</span><span class="run-error-msg">${escapeHtml(r.error)}</span></li>`;
      }
      const cls =
        r.runId === selectedRunId ? "run-entry selected" : "run-entry";
      return (
        `<li class="${cls}"><a href="/?run=${encodeURIComponent(r.runId)}">` +
        `<span class="run-id">${escapeHtml(r.runId)}</span>` +
        `<span class="run-workflow">${escapeHtml(r.workflow)}</span>` +
        `<span class="run-status status-${escapeHtml(statusMeta(r.status).cls)}">${statusMeta(r.status).icon} ${escapeHtml(r.status)}</span>` +
        `<span class="run-updated">${escapeHtml(r.updatedAt)}</span>` +
        `</a></li>`
      );
    })
    .join("\n");
  return (
    `<details id="rail" open>` +
    `<summary>Runs (${runs.length})</summary>` +
    `<nav aria-label="Run list"><ul class="run-list">${items || '<li class="run-empty">No runs found.</li>'}</ul></nav>` +
    `</details>`
  );
}

function kpiHtml(run: RunSnapshot): string {
  const meta = statusMeta(run.status);
  const current =
    run.currentNodes.length > 0
      ? run.currentNodes.join(", ")
      : (run.awaitingGate?.nodeId ?? "—");
  return (
    `<section class="kpi-strip" aria-label="Run summary">` +
    `<div class="kpi"><span class="kpi-label">Run</span><span class="kpi-value">${escapeHtml(run.runId)}</span></div>` +
    `<div class="kpi"><span class="kpi-label">Workflow</span><span class="kpi-value">${escapeHtml(run.workflow)}</span></div>` +
    `<div class="kpi"><span class="kpi-label">Status</span><span class="kpi-value status-${escapeHtml(meta.cls)}">${meta.icon} ${escapeHtml(meta.label)}${run.stale ? " (stale)" : ""}</span></div>` +
    `<div class="kpi"><span class="kpi-label">Elapsed</span><span class="kpi-value" data-elapsed data-created-at="${escapeHtml(run.createdAt)}" data-run-status="${escapeHtml(run.status)}">—</span></div>` +
    `<div class="kpi"><span class="kpi-label">Total cost</span><span class="kpi-value">${fmtCost(run.totalCost)}</span></div>` +
    `<div class="kpi"><span class="kpi-label">Current node</span><span class="kpi-value">${escapeHtml(current)}</span></div>` +
    `</section>`
  );
}

function decisionHistoryHtml(history: GateHistoryEntry[]): string {
  if (history.length === 0)
    return `<p class="muted">No decisions recorded yet.</p>`;
  const rows = history
    .map(
      (h) =>
        `<li><code>${escapeHtml(h.decisionId ?? "(legacy, no id)")}</code> — ` +
        `${escapeHtml(h.action ?? h.decision)}${h.target !== undefined ? ` → ${escapeHtml(h.target)}` : ""} ` +
        `at ${escapeHtml(h.timestamp)}${h.mode === "night" ? " (night-mode auto)" : ""}` +
        `${h.comment !== undefined && h.comment !== "" ? `<br><span class="muted">${escapeHtml(h.comment)}</span>` : ""}</li>`,
    )
    .join("\n");
  return `<ul class="decision-history">${rows}</ul>`;
}

function gateBannerHtml(run: RunSnapshot): string {
  const ag = run.awaitingGate;
  if (ag === null) return "";
  const brief = run.gateBrief;
  const copyCmd = `dagrun gate show ${run.runId}`;
  const actions = brief?.pendingDecision.actions ?? [
    "approve",
    "amend",
    "hold",
  ];
  const companionSessionId =
    brief?.companion.sessionId ?? run.companion?.sessionId ?? null;
  const resumeHint = brief?.companion.resumeHint;
  const history = run.nodes[ag.nodeId]?.gateHistory ?? [];
  return (
    `<section class="gate-banner" aria-label="Gate awaiting decision" role="status">` +
    `<h2>⏸ Awaiting decision — gate "${escapeHtml(ag.nodeId)}"</h2>` +
    `<p>${escapeHtml(ag.reason)}</p>` +
    `<dl class="gate-facts">` +
    `<dt>Revision</dt><dd>${brief !== null ? `<code>${escapeHtml(brief.revision)}</code>` : `<em>not opened yet — run <code>${escapeHtml(copyCmd)}</code></em>`}</dd>` +
    `<dt>Opened</dt><dd>${escapeHtml(brief?.openedAt ?? ag.since ?? "unknown")}</dd>` +
    `<dt>Allowed actions</dt><dd>${actions.map(escapeHtml).join(", ")}</dd>` +
    `<dt>Owning companion</dt><dd>${companionSessionId !== null ? `<code>${escapeHtml(companionSessionId)}</code>` : "none recorded"}${resumeHint !== undefined ? `<br><code class="resume-hint">${escapeHtml(resumeHint)}</code>` : ""}</dd>` +
    `</dl>` +
    `<h3>Decision history</h3>` +
    decisionHistoryHtml(history) +
    `<p class="gate-readonly-note"><strong>Read-only.</strong> Decisions happen in the companion conversation, not here — this viewer has no decide/approve control.</p>` +
    `<p class="copy-row"><code id="gate-show-cmd">${escapeHtml(copyCmd)}</code> ` +
    `<button type="button" data-copy-target="gate-show-cmd" class="copy-btn">Copy command</button></p>` +
    `</section>`
  );
}

function artifactHtml(a: NodeArtifactView): string {
  return (
    `<div class="artifact">` +
    `<h4>${escapeHtml(a.name)} ${a.registered ? '<span class="badge badge-registered">registered</span>' : '<span class="badge badge-extra">extra</span>'}` +
    `<span class="artifact-meta">${a.size !== null ? `${a.size}B` : ""} ${a.mtime !== null ? escapeHtml(a.mtime) : ""}</span></h4>` +
    `<div class="artifact-content">${a.html}</div>` +
    `</div>`
  );
}

function nodeRowHtml(n: NodeView, expanded: boolean, runId: string): string {
  const meta = statusMeta(n.status);
  const artifacts =
    n.artifacts.length > 0
      ? n.artifacts.map(artifactHtml).join("\n")
      : `<p class="muted">No artifacts yet.</p>`;
  return (
    `<details class="node-row status-${escapeHtml(meta.cls)}"${expanded ? " open" : ""} data-node="${escapeHtml(n.id)}">` +
    `<summary>` +
    `<span class="status-icon" aria-hidden="true">${meta.icon}</span>` +
    `<span class="status-label">${escapeHtml(meta.label)}</span>` +
    `<span class="node-id">${escapeHtml(n.id)}</span>` +
    `<span class="node-meta">iter ${n.iteration} · ${fmtMs(n.durationMs)} · ${fmtCost(n.cost)}</span>` +
    `</summary>` +
    `<div class="node-body">` +
    `<div class="artifact-list">${artifacts}</div>` +
    (n.gateHistory.length > 0
      ? `<div class="node-gate-history"><h4>Gate history</h4>${decisionHistoryHtml(n.gateHistory)}</div>`
      : "") +
    `<div class="live-tail" data-live-tail-for="${escapeHtml(n.id)}">` +
    `<h4>Live output</h4>` +
    `<pre class="tail-content" data-tail-content>(no live events yet)</pre>` +
    `<noscript>Live output requires JavaScript. Poll instead: <code>dagrun status ${escapeHtml(runId)} --json</code></noscript>` +
    `</div>` +
    `</div>` +
    `</details>`
  );
}

function timelineHtml(run: RunSnapshot, nodeViews: NodeView[]): string {
  const rows = nodeViews
    .map((n) =>
      nodeRowHtml(
        n,
        n.status === "running" || n.status === "awaiting-gate",
        run.runId,
      ),
    )
    .join("\n");
  return `<section class="timeline" aria-label="Node timeline">${rows}</section>`;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f9; --fg: #1b1d23; --panel: #ffffff; --border: #d8dae0; --muted: #6b7280;
  --pending: #9aa1ab; --running: #2563eb; --done: #16a34a; --skipped: #9333ea;
  --failed: #dc2626; --awaiting: #d97706; --link: #2563eb; --add: #16a34a; --del: #dc2626;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161a; --fg: #e6e7ea; --panel: #1c1f26; --border: #33363f; --muted: #9aa1ab; }
}
:root[data-theme="dark"] { --bg: #14161a; --fg: #e6e7ea; --panel: #1c1f26; --border: #33363f; --muted: #9aa1ab; }
:root[data-theme="light"] { --bg: #f7f7f9; --fg: #1b1d23; --panel: #ffffff; --border: #d8dae0; --muted: #6b7280; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
a { color: var(--link); }
.layout { display: flex; min-height: 100vh; }
#rail { width: 280px; flex: none; border-right: 1px solid var(--border); background: var(--panel); }
#rail > summary { padding: 0.75rem 1rem; font-weight: 600; cursor: pointer; }
.run-list { list-style: none; margin: 0; padding: 0 0.5rem 1rem; }
.run-entry a { display: block; padding: 0.5rem; border-radius: 6px; text-decoration: none; color: inherit; }
.run-entry.selected a { background: var(--border); }
.run-entry { display: block; font-size: 0.85rem; }
.run-entry a > span { display: block; }
.run-id { font-weight: 600; }
.run-workflow, .run-updated { color: var(--muted); font-size: 0.75rem; }
.run-error { color: var(--failed); padding: 0.5rem; }
main { flex: 1; padding: 1rem 1.5rem 3rem; max-width: 980px; }
.kpi-strip { display: flex; flex-wrap: wrap; gap: 1.25rem; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
.kpi { display: flex; flex-direction: column; }
.kpi-label { font-size: 0.7rem; text-transform: uppercase; color: var(--muted); }
.kpi-value { font-size: 1.05rem; font-weight: 600; }
.status-pending { color: var(--pending); } .status-running { color: var(--running); }
.status-done { color: var(--done); } .status-skipped { color: var(--skipped); }
.status-failed { color: var(--failed); } .status-awaiting { color: var(--awaiting); }
.gate-banner { border: 2px solid var(--awaiting); border-radius: 8px; padding: 1rem; margin-bottom: 1.25rem; background: var(--panel); }
.gate-banner h2 { margin-top: 0; color: var(--awaiting); }
.gate-facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; }
.gate-facts dt { color: var(--muted); }
.gate-readonly-note { font-size: 0.9rem; }
.copy-row code { padding: 0.15rem 0.4rem; background: var(--bg); border-radius: 4px; }
.copy-btn { margin-left: 0.5rem; cursor: pointer; }
.node-row { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.6rem; background: var(--panel); }
.node-row > summary { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.9rem; cursor: pointer; list-style: none; }
.node-row > summary::-webkit-details-marker { display: none; }
.node-id { font-weight: 600; }
.node-meta { color: var(--muted); font-size: 0.85rem; margin-left: auto; }
.node-body { padding: 0 0.9rem 0.9rem; }
.artifact { border-top: 1px solid var(--border); padding: 0.6rem 0; }
.artifact h4 { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.4rem; font-size: 0.9rem; }
.artifact-meta { color: var(--muted); font-size: 0.75rem; margin-left: auto; }
.badge { font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: var(--border); }
.artifact-content pre { overflow-x: auto; padding: 0.6rem; background: var(--bg); border-radius: 6px; }
.diff-add { color: var(--add); } .diff-del { color: var(--del); }
.diff-file, .diff-hunk { color: var(--running); } .diff-meta { color: var(--muted); }
.live-tail { border-top: 1px dashed var(--border); margin-top: 0.6rem; padding-top: 0.6rem; }
.tail-content { max-height: 160px; overflow-y: auto; background: var(--bg); padding: 0.5rem; border-radius: 6px; font-size: 0.8rem; }
.muted { color: var(--muted); }
.decision-history { padding-left: 1.1rem; }
#theme-toggle { position: fixed; top: 0.6rem; right: 0.8rem; cursor: pointer; }
@media (max-width: 760px) {
  .layout { flex-direction: column; }
  #rail { width: 100%; border-right: none; border-bottom: 1px solid var(--border); }
  main { max-width: 100%; }
}
`;

const CLIENT_JS = `
(function () {
  var saved = localStorage.getItem('dagrun-ui-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('dagrun-ui-theme', next);
    });
  }
  document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy-target'));
      if (!el) return;
      var text = el.textContent || '';
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy command'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  });
  var elapsedEl = document.querySelector('[data-elapsed]');
  if (elapsedEl) {
    var createdAt = new Date(elapsedEl.getAttribute('data-created-at')).getTime();
    var runStatus = elapsedEl.getAttribute('data-run-status');
    var terminal = runStatus === 'done' || runStatus === 'failed' || runStatus === 'aborted';
    function tick() {
      var s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
      var m = Math.floor(s / 60), r = s % 60;
      elapsedEl.textContent = m + 'm' + (r < 10 ? '0' : '') + r + 's';
    }
    tick();
    if (!terminal) setInterval(tick, 1000);
  }
  var params = new URLSearchParams(location.search);
  var runId = params.get('run');
  if (runId && window.EventSource) {
    var es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/stream');
    es.addEventListener('event', function (ev) {
      try {
        var data = JSON.parse(ev.data);
        var node = data.node;
        if (node) {
          var tail = document.querySelector('[data-tail-content][data-live-tail-for="' + node + '"] , [data-live-tail-for="' + node + '"] [data-tail-content]');
          var region = document.querySelector('[data-live-tail-for="' + node + '"]');
          var pre = region ? region.querySelector('[data-tail-content]') : null;
          if (pre) {
            var line = (data.ts || '') + ' ' + data.type + (data.detail ? ' ' + JSON.stringify(data.detail) : '');
            var lines = pre.textContent === '(no live events yet)' ? [] : pre.textContent.split('\\n');
            lines.push(line);
            if (lines.length > 50) lines = lines.slice(lines.length - 50);
            pre.textContent = lines.join('\\n');
          }
        }
      } catch (e) {}
    });
    es.addEventListener('snapshot', function () {
      // A change landed — the safest, simplest refresh is a full reload of this page's
      // data-bearing HTML. Deliberately NOT automatic: a companion-owned decision should
      // not yank the page out from under someone reading an artifact. Just flag it.
      var flag = document.getElementById('stale-flag');
      if (flag) flag.hidden = false;
    });
  }
})();
`;

export function renderPage(data: PageData): string {
  const title =
    data.run !== null
      ? `dagrun ui — ${escapeHtml(data.run.runId)}`
      : "dagrun ui";
  const main =
    data.run !== null
      ? kpiHtml(data.run) +
        gateBannerHtml(data.run) +
        timelineHtml(data.run, data.nodeViews)
      : data.selectedError !== null
        ? `<p class="run-error">Could not load run${data.selectedRunId !== null ? ` "${escapeHtml(data.selectedRunId)}"` : ""}: ${escapeHtml(data.selectedError)}</p>`
        : `<p class="muted">Select a run from the list to view its timeline.</p>`;
  const staleFlag =
    data.run !== null
      ? `<p id="stale-flag" hidden class="muted">This run has new events — <a href="?run=${encodeURIComponent(data.run.runId)}">reload</a> to see them.</p>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<button id="theme-toggle" type="button" aria-label="Toggle light/dark theme">◐</button>
<div class="layout">
${railHtml(data.runs, data.selectedRunId)}
<main>
${staleFlag}
${main}
</main>
</div>
<noscript><p style="position:fixed;bottom:0;left:0;right:0;padding:0.4rem 1rem;background:#333;color:#fff;font-size:0.8rem;">JavaScript is off — this page shows a snapshot. Poll <code>dagrun status &lt;run&gt; --json</code> for live updates, or reload.</p></noscript>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
