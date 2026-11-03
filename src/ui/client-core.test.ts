/**
 * client-core.test.ts — evaluates the page's pure client renderers under
 * node:vm (no browser, no DOM) and proves: escape-by-default templating,
 * hostile run data renders inert everywhere it can reach markup, and the
 * real-data quirks drive the right display (gate card, skip reasons, …).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { CORE_JS } from "./client-core.js";

// The renderers live in a vm context as untyped JS; `any` is the honest type for that boundary.
/* eslint-disable @typescript-eslint/no-explicit-any */
function load(): any {
  const win: Record<string, unknown> = {};
  vm.runInNewContext(CORE_JS, { window: win, Intl, Date, Object, Array, String, Number, Math });
  return win["DRUI"];
}
const D: any = load();

const ALLOWED_TAGS = new Set(
  "a b i em strong code pre span div p br button ol ul li dl dt dd details summary time h1 h2 h3 h4 section header table thead tbody tr th td blockquote svg circle path rect".split(" "),
);
/** Structural inertness: only known tags, and no `on*` / `style`-less surprises — a quote break-out would surface as an unknown/`on…` attribute. */
function assertInert(html: string, label: string): void {
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    assert.ok(ALLOWED_TAGS.has((m[1] ?? "").toLowerCase()), `${label}: unexpected tag <${m[1]}>`);
    for (const a of (m[2] ?? "").matchAll(/\s+([^\s=>/]+)(?:="[^"]*")?/g)) {
      assert.doesNotMatch(a[1] ?? "", /^on/i, `${label}: event-handler attribute ${a[1]}`);
    }
  }
  // Every '<' must have been consumed by a recognized tag above (a stray unparsed tag would be live markup).
  const stripped = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g, "");
  assert.doesNotMatch(stripped, /</, `${label}: stray '<' left in markup`);
}

const X = `<script>alert(1)</script><img src=x onerror=alert(2)>" onmouseover="alert(3)`;

test("T(): {x} escapes, {{x}} inserts trusted markup, inserted text is never re-scanned for placeholders", () => {
  assert.equal(D.T("<b>{x}</b>", { x: "<i>&" }), "<b>&lt;i&gt;&amp;</b>");
  assert.equal(D.T("<b>{{x}}</b>", { x: "<i>ok</i>" }), "<b><i>ok</i></b>");
  assert.equal(D.T("{a}{b}", { a: "{b}", b: "B" }), "{b}B", "a value containing a placeholder is not expanded again");
  assert.equal(D.T("{missing}", {}), "");
});

test("safeHref: only http(s); javascript:/data: are dropped", () => {
  assert.equal(D.safeHref("https://github.com/o/r/issues/1"), "https://github.com/o/r/issues/1");
  assert.equal(D.safeHref("javascript:alert(1)"), "");
  assert.equal(D.safeHref("data:text/html,<script>"), "");
  assert.equal(D.safeHref("  http://x.y "), "http://x.y");
});

function hostileView(over: Record<string, unknown> = {}): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const node = (status: string, extra: Record<string, unknown> = {}) => ({
    status, iteration: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", durationMs: 60000, cost: 1.5,
    attempts: [], gateHistory: [], model: X, sessionId: X, error: X, skipReason: null, artifacts: [],
    files: [{ name: X, path: X, registered: true, bookkeeping: false, size: 1, mtime: null }], ...extra,
  });
  return {
    runId: X, workflow: X, runStatus: "paused", status: "awaiting-gate", stale: false, currentNodes: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z", branch: X, baseBranch: X,
    issueUrl: "javascript:alert(1)", planTitle: X, totalCost: 3, companion: { sessionId: X },
    nodeOrder: [X, "b"],
    defs: { [X]: { command: X, model: X, effort: X, dependsOn: [], produces: [X, "p.md"], optional: true, hasWhen: true, gate: { maxIterations: 5, amendTargets: [X] } },
            b: { command: "/b", model: "sonnet", effort: null, dependsOn: [X], produces: [], optional: false, hasWhen: false, gate: null } },
    nodes: { [X]: node("awaiting-gate", { gateHistory: [{ decision: "reject", action: X, target: X, timestamp: "2026-01-01T00:05:00.000Z", decisionId: X, revision: X, resumePoint: X, comment: X }], attempts: [{ iteration: 0, status: X, durationMs: 1, cost: 1 }, { iteration: 1, status: X, durationMs: 1, cost: 1 }] }),
             b: node("skipped", { skipReason: X }) },
    gate: { nodeId: X, reason: X, since: null, revision: X, openedAt: null, round: 2, iteration: 1, maxIterations: 5, actions: [X], amendTargets: [X], approveContinuesTo: [X], evidence: [{ name: X, sha: X }], validation: [{ nodeId: X, check: X, ok: false }], upstream: [X], companion: { sessionId: X, status: X, reconstructed: true, cwd: X }, decisions: 1 },
    ...over,
  };
}

test("XSS: a hostile run (every string field carries <script>/onerror/attribute-breakout) renders inert in hero, runs row, gate card and node rows", () => {
  const view = hostileView();
  const ctx = {
    ui: { open: { [X]: true, b: true }, tab: { [X]: "artifacts", b: "details" }, file: {}, gateHistoryOpen: true },
    art: () => "<p>server-rendered</p>",
    output: () => ({ items: [], loaded: true }),
  };
  assertInert(D.heroHtml(view), "hero");
  assert.doesNotMatch(D.heroHtml(view), /href="javascript/);
  assertInert(D.runsHtml([{ runId: X, workflow: X, status: X, updatedAt: "2026-01-01T00:00:00.000Z", cost: 1 }, { runId: X, error: X }], X), "runs");
  assertInert(D.gateHtml(view, ctx.ui), "gate");
  for (const s of D.stepsOf(view, ctx)) assertInert(s.html, "step");
  for (const tab of ["artifacts", "output", "details"]) {
    ctx.ui.tab[X] = tab;
    ctx.ui.tab["b"] = tab;
    for (const s of D.stepsOf(view, ctx)) assertInert(s.html, `step/${tab}`);
  }
});

test("XSS: assistant messages and tool commands in the feed and the Output tab render inert; the text is visible escaped", () => {
  const items = [
    { id: "t:1", ts: "2026-01-01T00:00:01.000Z", kind: "text", node: X, text: X, source: "transcript" },
    { id: "t:2", ts: "2026-01-01T00:00:02.000Z", kind: "tool", node: X, tool: X, text: X, source: "transcript", truncated: true, approx: true },
    { id: "e:1", ts: "2026-01-01T00:00:03.000Z", kind: "gate", node: X, text: X, source: "events" },
    { id: "e:2", ts: "2026-01-01T00:00:03.000Z", kind: X, text: X, source: "events" },
  ];
  const feed = D.feedHtml(items, true, { "t:1": true });
  assertInert(feed.html, "feed");
  assert.match(feed.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(feed.count, 4);
  const view = hostileView();
  const ctx = { ui: { open: { [X]: true }, tab: { [X]: "output" }, file: {}, gateHistoryOpen: false }, art: () => null, output: () => ({ items, loaded: true }) };
  for (const s of D.stepsOf(view, ctx)) assertInert(s.html, "output tab");
});

test("an artifact's server-escaped HTML is the ONE thing inserted unescaped, and only through the artifact slot", () => {
  const view = hostileView({ nodeOrder: ["n"], defs: {}, nodes: { n: { status: "done", iteration: 0, attempts: [], gateHistory: [], files: [{ name: "a.md", registered: true, bookkeeping: false }], cost: 0 } }, gate: null });
  const ctx = { ui: { open: { n: true }, tab: {}, file: {}, gateHistoryOpen: false }, art: () => '<div class="md"><p>&lt;script&gt;x&lt;/script&gt;</p></div>', output: () => ({ items: [], loaded: true }) };
  const html = D.stepsOf(view, ctx)[0].html as string;
  assert.match(html, /<div class="md"><p>&lt;script&gt;x&lt;\/script&gt;<\/p><\/div>/);
  assertInert(html, "artifact slot");
});

test("agent-messages toggle: off hides text+tool items but keeps engine events", () => {
  const items = [
    { id: "1", ts: "2026-01-01T00:00:01.000Z", kind: "text", text: "a" },
    { id: "2", ts: "2026-01-01T00:00:02.000Z", kind: "tool", tool: "Bash", text: "ls" },
    { id: "3", ts: "2026-01-01T00:00:03.000Z", kind: "start", node: "n", text: "n started" },
  ];
  assert.equal(D.feedHtml(items, false, {}).count, 1);
  assert.equal(D.feedHtml(items, true, {}).count, 3);
  // newest first
  const html = D.feedHtml(items, true, {}).html as string;
  assert.ok(html.indexOf("n started") < html.indexOf(">ls<") || html.indexOf("n started") < html.indexOf("ls"));
});

test("mergeItems: chronological insert, id de-dupe across a reconnect, returns only the genuinely new items", () => {
  const items: Array<{ id: string; ts: string }> = [];
  const seen: Record<string, boolean> = {};
  const a = { id: "a", ts: "2026-01-01T00:00:01.000Z" };
  const c = { id: "c", ts: "2026-01-01T00:00:03.000Z" };
  const b = { id: "b", ts: "2026-01-01T00:00:02.000Z" };
  assert.equal(D.mergeItems(items, seen, [a, c]).length, 2);
  assert.equal(D.mergeItems(items, seen, [a, b, c]).length, 1, "history replay after reconnect adds only b");
  assert.equal(items.map((i) => i.id).join(), "a,b,c");
});

test("gate card: absent when the view has no gate (run not paused / nothing awaiting); present with facts when it has", () => {
  assert.equal(D.gateHtml({ runId: "9-1", gate: null, nodeOrder: [], nodes: {}, defs: {} }, {}), "");
  const v = hostileView({ runId: "9-1" });
  v.gate = { nodeId: "fix", reason: "r", since: null, revision: "b04f.19", openedAt: null, round: 1, iteration: 0, maxIterations: 5, actions: ["approve", "amend", "hold"], amendTargets: ["fix"], approveContinuesTo: ["fix", "pr"], evidence: [{ name: "summary.md", sha: "d28f372f55cd" }], validation: [{ nodeId: "reproduce", check: "noPlaceholders", ok: true }], upstream: ["review"], companion: { sessionId: "53374b27-5801", status: "ok", reconstructed: false, cwd: "/Users/me/dev/x" }, decisions: 2 };
  const html = D.gateHtml(v, {}) as string;
  assert.match(html, /Waiting for a decision at fix/);
  assert.match(html, /1 of 5 allowed <span class="muted">\(state\.json iteration 0\)<\/span>/);
  assert.match(html, /<b>amend<\/b> \(fix\)/);
  assert.match(html, /<span>fix<\/span><i>→<\/i><span>pr<\/span>/);
  assert.match(html, /summary\.md<\/code> <span class="muted">d28f372f55cd/);
  assert.match(html, /✓ reproduce\/noPlaceholders/);
  assert.match(html, /upstream: review/);
  assert.match(html, /started in <code>~\/dev\/x<\/code>/);
  assert.match(html, /dagrun gate show 9-1/);
  assert.match(html, /Decision history · 2 recorded/);
  assert.doesNotMatch(html, /decide<\/button>|data-act="(approve|decide)"/, "read-only: no decide/approve control");
});

test("skipped nodes show the real reason (optional / condition), and the issue link keeps only a clean https url", () => {
  const view = (reason: string | null) => ({
    runId: "r", nodeOrder: ["step"], defs: { step: { dependsOn: [], produces: [], gate: null, optional: false, hasWhen: true } },
    nodes: { step: { status: "skipped", skipReason: reason, attempts: [], files: [], gateHistory: [], cost: 0, iteration: 0 } },
  });
  const ctx = { ui: { open: {}, tab: {}, file: {} }, art: () => null, output: () => ({ items: [], loaded: true }) };
  const row = (r: string | null) => D.stepsOf(view(r), ctx)[0].html as string;
  assert.match(row("optional"), /Skipped \(optional\)/);
  assert.match(row("when"), /Skipped \(condition not met\)/);
  const hero = D.heroHtml({ runId: "r", workflow: "bugfix", runStatus: "done", stale: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z", branch: "b", baseBranch: null, issueUrl: "https://github.com/o/r/issues/59478", planTitle: "T", totalCost: 1, companion: null, nodeOrder: [], nodes: {}, defs: {} }) as string;
  assert.match(hero, /<a href="https:\/\/github\.com\/o\/r\/issues\/59478" rel="noreferrer">issue #59478<\/a>/);
});

test("pipeline layers: dependency depth groups parallel nodes; legacy nodes without a definition chain linearly", () => {
  const view = { nodeOrder: ["a", "b", "c", "old"], defs: { a: { dependsOn: [] }, b: { dependsOn: ["a"] }, c: { dependsOn: ["a"] } }, nodes: {} };
  assert.equal(JSON.stringify(D.layers(view)), JSON.stringify([["a"], ["b", "c"], ["old"]]));
});

test("ticking readouts: a running node shows a data-since ticker (filled by the app timer, not re-rendered); a finished node shows a static duration", () => {
  const view = {
    runId: "r", nodeOrder: ["n"], defs: {},
    nodes: { n: { status: "running", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, durationMs: null, cost: 0, iteration: 0, attempts: [], files: [], gateHistory: [] } },
  };
  const ctx = { ui: { open: {}, tab: {}, file: {} }, art: () => null, output: () => ({ items: [], loaded: true }) };
  const running = D.stepsOf(view, ctx)[0].html as string;
  assert.match(running, /data-since="2026-01-01T00:00:00\.000Z"/);
  assert.match(running, /cost at session end/);
  view.nodes.n = { ...view.nodes.n, status: "done", endedAt: "2026-01-01T00:04:31.000Z", durationMs: 271000, cost: 2.28 } as never;
  const done = D.stepsOf(view, ctx)[0].html as string;
  assert.doesNotMatch(done, /data-since/);
  assert.match(done, /4m 31s/);
  assert.match(done, /cost \$2\.28/);
});

test("run chips sort by the run's own updatedAt, newest first; unreadable entries go last in server order", () => {
  const sorted = D.sortRuns([
    { runId: "old", updatedAt: "2026-01-01T00:00:00.000Z" },
    { runId: "bad1", error: "x" },
    { runId: "new", updatedAt: "2026-03-01T00:00:00.000Z" },
    { runId: "bad2", error: "y" },
    { runId: "mid", updatedAt: "2026-02-01T00:00:00.000Z" },
  ]);
  assert.equal(sorted.map((r: { runId: string }) => r.runId).join(), "new,mid,old,bad1,bad2");
});
