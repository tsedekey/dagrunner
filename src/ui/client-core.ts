/**
 * client-core.ts — the PURE half of the page's inline client script: view data
 * in, HTML string out. No DOM, no fetch, no clock — so it is evaluated under
 * `node:vm` in tests (client-core.test.ts), which is how escaping and the
 * per-run-data quirks are proven without a browser.
 *
 * AUTHORING RULES for CORE_JS (it is a `String.raw` template literal inlined
 * into the page — no build step, no static asset):
 *   - never write a backtick or `${` inside it (they would end/interpolate the
 *     literal); build strings with `T()` or concatenation;
 *   - backslashes are literal (String.raw) — write regexes naturally;
 *   - ESCAPE BY DEFAULT: `T('<b>{x}</b>', {x})` HTML-escapes `{x}`; only
 *     `{{x}}` inserts pre-built HTML. Every piece of run data (artifact text,
 *     assistant messages, tool commands, issue titles, branch names, node ids)
 *     is untrusted and must enter the DOM through `{x}`/`esc()`; hrefs go
 *     through `safeHref()` (http/https only). Artifact content is the one
 *     exception: it arrives already escaped from render.ts (the server-side
 *     single escaping path for content) and is inserted as `{{html}}`.
 */

export const CORE_JS = String.raw`
(function (root) {
  'use strict';
  var D = {};

  /* ---------- escaping: the only way text enters markup ---------- */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  /** {name} -> escaped value; {{name}} -> trusted, pre-built HTML. Single pass: inserted text is never re-scanned. */
  function T(tpl, v) {
    return tpl.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, function (m, raw, e) {
      var x = v[raw || e];
      if (x == null) x = '';
      return raw ? String(x) : esc(x);
    });
  }
  function safeHref(u) { u = String(u == null ? '' : u).trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  D.esc = esc; D.T = T; D.safeHref = safeHref;

  /* ---------- status vocabulary: label + glyph, never colour alone ---------- */
  var STATUS = {
    pending: 'Pending', running: 'Running', 'awaiting-gate': 'Awaiting gate',
    done: 'Done', skipped: 'Skipped', failed: 'Failed'
  };
  var RUNSTATUS = { running: 'Running', paused: 'Paused at gate', done: 'Done', failed: 'Failed', aborted: 'Aborted' };
  var SKIP_TEXT = { decision: 'Skipped by decision', optional: 'Skipped (optional)', when: 'Skipped (condition not met)' };
  function icon(status, size) {
    var s = size || 14;
    var o = '<svg class="st-ico st-ico--' + esc(status) + '" width="' + s + '" height="' + s + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">';
    switch (status) {
      case 'done': return o + '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="var(--ico-on, #fff)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'running': return o + '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="2"/><path class="spin" d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      case 'awaiting-gate': return o + '<circle cx="8" cy="8" r="7" fill="currentColor"/><rect x="5.3" y="4.6" width="1.9" height="6.8" rx=".6" fill="var(--ico-on, #fff)"/><rect x="8.8" y="4.6" width="1.9" height="6.8" rx=".6" fill="var(--ico-on, #fff)"/></svg>';
      case 'failed': return o + '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="var(--ico-on, #fff)" stroke-width="1.8" stroke-linecap="round"/></svg>';
      case 'skipped': return o + '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/><path d="M4.8 8h6.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      default: return o + '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
    }
  }
  /** Known statuses only reach class names; anything else renders as pending. */
  function stClass(status) { return STATUS[status] ? status : 'pending'; }
  function pill(status, label) {
    var st = stClass(status);
    return '<span class="st st--' + st + '">' + icon(st) + '<span>' + esc(label || STATUS[st]) + '</span></span>';
  }
  /** Run status -> the node-status vocabulary used for colour/icon. */
  function runSt(status) { return status === 'paused' ? 'awaiting-gate' : status === 'aborted' ? 'failed' : status; }
  var TERMINAL = { done: 1, failed: 1, aborted: 1 };
  function isTerminal(runStatus) { return !!TERMINAL[runStatus]; }
  D.icon = icon; D.pill = pill; D.runSt = runSt; D.isTerminal = isTerminal; D.STATUS = STATUS; D.RUNSTATUS = RUNSTATUS;

  /* ---------- formatting ---------- */
  var tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  var tfs = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  var df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  function ok(iso) { return iso && !isNaN(new Date(iso).getTime()); }
  function fmtTime(iso, sec) { return ok(iso) ? (sec ? tfs : tf).format(new Date(iso)) : '–'; }
  function fmtDay(iso) { return ok(iso) ? df.format(new Date(iso)) : '–'; }
  function fmtWhen(iso) { return ok(iso) ? fmtDay(iso) + ', ' + fmtTime(iso) : '–'; }
  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return '–';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + String(r).padStart(2, '0') + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  function fmtUsd(n) { return '$' + (n || 0).toFixed(2); }
  function short(id, n) { return id ? String(id).slice(0, n || 8) : '–'; }
  D.fmtTime = fmtTime; D.fmtDay = fmtDay; D.fmtWhen = fmtWhen; D.fmtDur = fmtDur; D.fmtUsd = fmtUsd; D.short = short;

  /** A ticking "so far" duration: the app's 1 s timer fills text from data-since; data-until (terminal) freezes it. */
  function ticker(sinceIso, untilIso) {
    if (!ok(sinceIso)) return '–';
    return T('<span data-since="{s}"{{u}}>{d}</span>', {
      s: sinceIso,
      u: ok(untilIso) ? ' data-until="' + esc(untilIso) + '"' : '',
      d: fmtDur((ok(untilIso) ? new Date(untilIso).getTime() : Date.now()) - new Date(sinceIso).getTime())
    });
  }
  D.ticker = ticker;

  /* ---------- per-node view model ---------- */
  var EMPTY_NODE = { status: 'pending', iteration: 0, attempts: [], files: [], gateHistory: [], cost: 0, skipReason: null };
  function nodeVM(view, id) {
    var n = view.nodes[id] || EMPTY_NODE;
    var d = (view.defs && view.defs[id]) || null;
    var attempts = n.attempts || [];
    return { id: id, n: n, d: d, status: stClass(n.status), attempts: attempts, files: n.files || [], gh: n.gateHistory || [] };
  }
  D.nodeVM = nodeVM;

  /** Pipeline steps: nodes grouped by dependency depth (same depth = parallel). Legacy nodes the workflow no longer defines chain linearly. */
  function layers(view) {
    var order = view.nodeOrder, layer = {}, has = {};
    order.forEach(function (id) { has[id] = true; });
    order.forEach(function (id, i) {
      var d = view.defs[id];
      var deps = d ? d.dependsOn.filter(function (x) { return has[x]; }) : (i > 0 ? [order[i - 1]] : []);
      layer[id] = deps.reduce(function (m, p) { return Math.max(m, (layer[p] == null ? 0 : layer[p]) + 1); }, 0);
    });
    var groups = {};
    order.forEach(function (id) { (groups[layer[id]] = groups[layer[id]] || []).push(id); });
    return Object.keys(groups).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return groups[k]; });
  }
  function groupStatus(view, ids) {
    var st = ids.map(function (id) { return nodeVM(view, id).status; });
    if (st.indexOf('failed') >= 0) return 'failed';
    if (st.indexOf('awaiting-gate') >= 0) return 'awaiting-gate';
    if (st.indexOf('running') >= 0) return 'running';
    if (st.every(function (s) { return s === 'done' || s === 'skipped'; })) return st.every(function (s) { return s === 'skipped'; }) ? 'skipped' : 'done';
    return 'pending';
  }
  D.layers = layers; D.groupStatus = groupStatus;

  function finishedCount(view) {
    return view.nodeOrder.filter(function (id) { var s = nodeVM(view, id).status; return s === 'done' || s === 'skipped'; }).length;
  }
  D.finishedCount = finishedCount;

  /* ---------- runs row ---------- */
  function runsHtml(runs, selectedId) {
    if (!runs.length) return '<p class="muted">No runs found.</p>';
    return runs.map(function (r) {
      if (r.error !== undefined) {
        return T('<a class="runcard" href="?run={id}" data-run="{id}"{{cur}} title="{err}"><span class="rid">{rid}</span><span class="rm">{{p}}</span></a>', {
          id: r.runId, err: r.error, rid: r.runId.length > 18 ? r.runId.slice(0, 17) + '…' : r.runId,
          cur: r.runId === selectedId ? ' aria-current="true"' : '', p: pill('failed', 'Unreadable')
        });
      }
      return T('<a class="runcard" href="?run={id}" data-run="{id}"{{cur}}><span class="rid">{rid}</span><span class="rm">{{p}}</span><span class="rm">{meta}</span></a>', {
        id: r.runId, rid: r.runId.length > 18 ? r.runId.slice(0, 17) + '…' : r.runId,
        cur: r.runId === selectedId ? ' aria-current="true"' : '',
        p: pill(runSt(r.status), RUNSTATUS[r.status] || r.status),
        meta: r.workflow + ' · ' + fmtDay(r.updatedAt) + ' · ' + fmtUsd(r.cost)
      });
    }).join('');
  }
  D.runsHtml = runsHtml;
  /** Most recently updated first (a run's own updatedAt, not its directory mtime); unreadable entries last, in server order. */
  function sortRuns(list) {
    return list.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
      var ua = a.r.updatedAt || '', ub = b.r.updatedAt || '';
      if (!ua !== !ub) return ua ? -1 : 1;
      return ua === ub ? a.i - b.i : (ua < ub ? 1 : -1);
    }).map(function (x) { return x.r; });
  }
  D.sortRuns = sortRuns;

  /* ---------- hero ---------- */
  function heroHtml(view) {
    var done = finishedCount(view), total = view.nodeOrder.length;
    var live = view.runStatus === 'running' && !view.stale;
    var label = view.stale ? 'Running (no live driver — stale)' : (RUNSTATUS[view.runStatus] || view.runStatus);
    var href = safeHref(view.issueUrl);
    var issueNum = view.issueUrl ? String(view.issueUrl).split('/').pop() : '';
    var elapsed = live ? ticker(view.createdAt) : (isTerminal(view.runStatus) ? fmtDur(new Date(view.updatedAt) - new Date(view.createdAt)) : '');
    return T('<div class="eyebrow"><span>{wf} run <code>{id}</code></span><span><code>{branch}</code>{{base}}</span>{{issue}}</div>' +
      '<h1>{title}</h1>' +
      '<div class="meta"><span class="run-st">{{pill}}</span>' +
      '<span><span class="lab">Nodes</span><b>{done} of {total}</b> finished</span>' +
      '<span><span class="lab">Started</span><b>{started}</b></span>' +
      '{{elapsed}}' +
      '<span><span class="lab">Cost so far</span><b>{cost}</b></span>' +
      '{{comp}}</div>', {
      wf: view.workflow, id: view.runId, branch: view.branch,
      base: view.baseBranch ? ' from <code>' + esc(view.baseBranch) + '</code>' : '',
      issue: href ? '<a href="' + esc(href) + '" rel="noreferrer">issue #' + esc(issueNum) + '</a>' : '',
      title: view.planTitle || view.branch || view.runId,
      pill: pill(runSt(view.stale ? 'running' : view.runStatus), label),
      done: done, total: total, started: fmtWhen(view.createdAt),
      elapsed: elapsed ? '<span><span class="lab">' + (live ? 'Running for' : 'Took') + '</span><b>' + (live ? elapsed : esc(elapsed)) + '</b></span>' : '',
      cost: fmtUsd(view.totalCost),
      comp: view.companion ? '<span><span class="lab">Companion</span><b><code>' + esc(short(view.companion.sessionId)) + '</code></b></span>' : ''
    });
  }
  D.heroHtml = heroHtml;

  /* ---------- decisions ---------- */
  function allDecisions(view) {
    var out = [];
    view.nodeOrder.forEach(function (id) {
      ((view.nodes[id] || EMPTY_NODE).gateHistory || []).forEach(function (g) { out.push(Object.assign({ node: id }, g)); });
    });
    return out.sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
  }
  function decisionsHtml(list) {
    if (!list.length) return '<p class="muted">No decisions recorded yet.</p>';
    return '<ol class="decisions">' + list.map(function (g) {
      var action = g.action || g.decision;
      var cls = /^[a-z]+$/.test(String(action)) ? String(action) : 'other';
      return T('<li class="dec dec--{cls}"><div class="dec-head"><span class="dec-action">{action}</span><span>{node}{{tgt}}</span><time>{when}</time></div>' +
        '<dl class="dec-meta"><div><dt>Decision</dt><dd><code>{did}</code></dd></div><div><dt>Revision</dt><dd><code>{rev}</code></dd></div>{{then}}</dl>{{comment}}</li>', {
        cls: cls, action: action, node: g.node,
        tgt: g.target && g.target !== g.node ? ' → ' + esc(g.target) : '',
        when: fmtWhen(g.timestamp), did: g.decisionId || '–', rev: g.revision || '–',
        then: g.resumePoint ? T('<div><dt>Then</dt><dd>{r}</dd></div>', { r: g.resumePoint }) : '',
        comment: g.comment ? T('<details class="dec-comment"><summary>Feedback ({n} chars)</summary><p>{c}</p></details>', { n: String(g.comment).length, c: g.comment }) : ''
      });
    }).join('') + '</ol>';
  }
  D.decisionsHtml = decisionsHtml; D.allDecisions = allDecisions;

  /* ---------- gate letter ---------- */
  function gateHtml(view, ui) {
    var g = view.gate;
    if (!g) return '';
    var c = g.companion;
    var cmd = 'dagrun gate show ' + view.runId;
    var actions = g.actions.map(function (a) { return '<b>' + esc(a) + '</b>' + (a === 'amend' && g.amendTargets.length ? ' (' + esc(g.amendTargets.join(', ')) + ')' : ''); }).join(' · ');
    var flow = g.approveContinuesTo.length ? g.approveContinuesTo.map(function (n, i) { return (i ? '<i>→</i>' : '') + '<span>' + esc(n) + '</span>'; }).join('') : '<span class="muted">–</span>';
    var evidence = g.evidence.map(function (e) { return '<code>' + esc(e.name) + '</code> <span class="muted">' + esc(e.sha) + '</span>'; }).join(', ') +
      g.validation.map(function (v) { return ' · ' + (v.ok ? '✓' : '✗') + ' ' + esc(v.nodeId) + '/' + esc(v.check); }).join('') +
      (g.upstream.length ? '<br><span class="muted">upstream: ' + g.upstream.map(esc).join(', ') + '</span>' : '');
    return T('<div>' +
      '<h2 id="gateH">{{ico}} Waiting for a decision at {node}</h2>' +
      '<p>The {node} round is finished and its output is ready for review. Decisions are made in the companion conversation, not here. This page only watches the run.</p>' +
      '{{decides}}' +
      '<p class="who">{{who}}</p>' +
      '<div class="cmdrow"><code class="cmd" id="gateCmd">{cmd}</code><button class="btn" type="button" data-act="copy" data-fk="copy">Copy command</button><button class="btn" type="button" data-act="see-node" data-node="{node}" data-fk="see">Read the {node} artifacts</button></div>' +
      '</div>' +
      '<dl class="gfacts">' +
      '<div><dt>Revision</dt><dd>{{rev}}</dd></div>' +
      '<div><dt>Round</dt><dd>{round} of {max} allowed <span class="muted">(state.json iteration {iter})</span></dd></div>' +
      '<div><dt>Allowed actions</dt><dd>{{actions}}</dd></div>' +
      '<div><dt>Approve continues to</dt><dd class="flow">{{flow}}</dd></div>' +
      '<div><dt>Evidence</dt><dd>{{evidence}}</dd></div>' +
      '</dl>' +
      '<details data-act="gate-history"{{open}}><summary>Decision history · {n} recorded</summary>{{decisions}}</details>', {
      ico: icon('awaiting-gate', 22), node: g.nodeId, cmd: cmd,
      decides: g.decidesNode ? '<p class="decides">Approving also decides whether <code>' + esc(g.decidesNode) + '</code> runs (<code>--run-next yes|no</code>).' +
        (g.advice ? ' Agent advice in ' + esc(g.nodeId) + '/summary.md: <em>' + esc(g.advice) + '</em>' : '') + '</p>' : '',
      who: c ? 'Owned by companion session <code>' + esc(c.sessionId || '–') + '</code> (' + esc(c.status) + (c.reconstructed ? ', reconstructed' : '') + ')' +
        (c.cwd ? ', started in <code>' + esc(String(c.cwd).replace(/^\/Users\/[^/]+/, '~')) + '</code>' : '') + '.' : 'No companion session recorded for this run (legacy gate).',
      rev: g.revision ? '<code>' + esc(g.revision) + '</code>' : '<em class="muted">not opened yet — run <code>' + esc(cmd) + '</code></em>',
      round: g.round, max: g.maxIterations, iter: g.iteration, actions: actions, flow: flow,
      evidence: evidence || '<span class="muted">none recorded yet</span>',
      open: ui && ui.gateHistoryOpen ? ' open' : '', n: g.decisions, decisions: decisionsHtml(allDecisions(view))
    });
  }
  D.gateHtml = gateHtml;

  /* ---------- node row ---------- */
  function tabsFor() { return [['artifacts', 'Artifacts'], ['output', 'Output'], ['details', 'Details']]; }

  function fileList(vm) {
    var base = vm.files.filter(function (f) { return !f.bookkeeping; }).concat(vm.files.filter(function (f) { return f.bookkeeping; }));
    var have = {};
    vm.files.forEach(function (f) { have[f.name] = true; });
    ((vm.d && vm.d.produces) || []).forEach(function (p) { if (!have[p]) base.push({ name: p, expected: true, registered: false, bookkeeping: false }); });
    return base;
  }
  function pickFile(files, wanted) {
    return files.filter(function (f) { return f.name === wanted; })[0] ||
      files.filter(function (f) { return f.registered; })[0] ||
      files.filter(function (f) { return !f.expected && !f.bookkeeping; })[0] || files[0] || null;
  }
  D.fileList = fileList; D.pickFile = pickFile;

  function outputHtml(items, loaded) {
    if (!loaded) return '<div class="placeholder">Loading the agent transcript…</div>';
    if (!items.length) return '<div class="placeholder">No agent output for this node yet. Messages and tool calls appear here as the node works.</div>';
    return '<ol class="tail" data-scroll="tail" aria-live="polite">' + items.map(function (e) {
      return T('<li class="tail-{k}"><time>{t}</time>{{who}}<span>{x}</span></li>', {
        k: e.kind === 'tool' ? 'tool' : 'text', t: fmtTime(e.ts, true),
        who: e.kind === 'tool' ? '<b>' + esc(e.tool || 'tool') + '</b>' : '<b>says</b>', x: e.text
      });
    }).join('') + '</ol>';
  }

  function detailsHtml(view, vm) {
    var d = vm.d, n = vm.n;
    var att = vm.attempts.length > 1 ? '<dt>Attempts</dt><dd>' + vm.attempts.map(function (a) {
      return esc('#' + a.iteration + ' ' + a.status + ' · ' + fmtDur(a.durationMs) + ' · ' + fmtUsd(a.cost));
    }).join('<br>') + '</dd>' : '';
    return '<dl class="kv">' +
      (d ? T('<dt>Command</dt><dd><code>{c}</code></dd>', { c: d.command }) : '') +
      T('<dt>Model</dt><dd>{m}</dd>', { m: (n.model || (d && d.model) || '–') + (d && d.effort ? ' · effort ' + d.effort : '') }) +
      (d ? T('<dt>Depends on</dt><dd>{x}</dd><dt>Produces</dt><dd>{p}</dd>', {
        x: (d.dependsOn.join(', ') || '–') + (d.joinRule ? ' (' + d.joinRule + ')' : ''), p: d.produces.join(', ') || '–' }) : '') +
      (d && d.gate ? T('<dt>Gate</dt><dd>up to {m} iterations{dn}</dd>', { m: d.gate.maxIterations, dn: d.gate.decidesNode ? ', decides ' + d.gate.decidesNode : '' }) : '') +
      T('<dt>Started</dt><dd>{s}</dd><dt>Ended</dt><dd>{e}</dd><dt>Session</dt><dd><code>{sid}</code></dd>', { s: fmtWhen(n.startedAt), e: fmtWhen(n.endedAt), sid: n.sessionId || '–' }) +
      att +
      (n.error ? T('<dt>Error</dt><dd class="err">{e}</dd>', { e: n.error }) : '') +
      '</dl>' + (vm.gh.length ? '<h3 class="col-h" style="margin-top:1rem">Decisions</h3>' + decisionsHtml(vm.gh.map(function (g) { return Object.assign({ node: vm.id }, g); })) : '');
  }

  /** ctx: { ui:{open,tab,file}, art(node,name)->html|null, output(node)->{items,loaded} } */
  function detailHtml(view, vm, ctx) {
    var id = vm.id, tl = tabsFor();
    var t = ctx.ui.tab[id] || 'artifacts';
    var body = '';
    if (t === 'artifacts') {
      var files = fileList(vm), f = pickFile(files, ctx.ui.file[id]);
      var fbody = '';
      if (f) {
        if (f.expected) fbody = T('<div class="placeholder">Not produced yet. This node must write <code>{n}</code>.</div>', { n: f.name });
        else { var h = ctx.art(id, f.name); fbody = h == null ? '<div class="placeholder">Loading…</div>' : h; }
      }
      body = T('<div class="files" role="group" aria-label="{id} files">{{chips}}</div>' +
        '<p class="note">● registered in state.json{live}</p>{{fbody}}', {
        id: id,
        chips: files.map(function (x) {
          return T('<button class="file{c}" type="button" data-act="file" data-node="{id}" data-name="{n}" data-fk="f:{n}" aria-pressed="{p}">{n}{r}</button>', {
            c: x.expected ? ' expected' : (x.bookkeeping ? ' bk' : ''), id: id, n: x.name, p: !!(f && x.name === f.name), r: x.registered ? ' ●' : ''
          });
        }).join('') || '<span class="muted">No files yet.</span>',
        live: vm.status === 'running' ? ' · files appear as the agent writes them' : '', fbody: fbody
      });
    } else if (t === 'output') {
      var o = ctx.output(id);
      body = outputHtml(o.items, o.loaded);
    } else body = detailsHtml(view, vm);
    return T('<div class="detail" id="det-{id}"><div class="tabs" role="tablist" aria-label="{id} sections">{{tabs}}</div><div role="tabpanel" data-scroll="panel">{{body}}</div></div>', {
      id: id, body: body,
      tabs: tl.map(function (x) {
        return T('<button class="tab" type="button" role="tab" data-act="tab" data-node="{id}" data-tab="{k}" data-fk="t:{k}" aria-selected="{s}" tabindex="{ti}">{l}</button>', { id: id, k: x[0], l: x[1], s: t === x[0], ti: t === x[0] ? 0 : -1 });
      }).join('')
    });
  }

  function rowHtml(view, id, ctx) {
    var vm = nodeVM(view, id), st = vm.status, n = vm.n, d = vm.d;
    var isOpen = !!ctx.ui.open[id];
    var statusText = st === 'skipped' && n.skipReason ? SKIP_TEXT[n.skipReason] : STATUS[st];
    var bits = [];
    var tier = (d && d.model) || n.model;
    if (tier) bits.push(esc(tier) + (d && d.effort ? ' · ' + esc(d.effort) : ''));
    var dur = '';
    if (st === 'running' && n.startedAt) dur = ticker(n.startedAt) + ' so far';
    else if (n.durationMs != null) dur = esc(fmtDur(n.durationMs)) + (vm.attempts.length > 1 ? ' last iteration only' : '');
    if (dur) bits.push(dur);
    if (st !== 'pending' && st !== 'skipped') bits.push('cost ' + (st === 'running' ? 'at session end' : (n.cost ? fmtUsd(n.cost) : '–')));
    if (d && d.gate && st !== 'pending') bits.push('iteration ' + esc(n.iteration));
    if (st === 'pending' && d && d.optional) bits.push('optional');
    if (st === 'pending' && d && d.hasWhen) bits.push('conditional');
    return T('<div class="row"><button class="rowbtn" type="button" data-act="row" data-node="{id}" data-fk="row" aria-expanded="{open}" aria-controls="det-{id}">' +
      '<span class="nname">{id} {{pill}}</span><span class="nmeta">{{bits}}</span>' +
      '<span class="nside">{{gate}}<span class="chev" aria-hidden="true">›</span></span></button>{{detail}}</div>', {
      id: id, open: isOpen, pill: pill(st, statusText),
      bits: bits.map(function (b) { return '<span>' + b + '</span>'; }).join(''),
      gate: d && d.gate ? '<span class="badge' + (st === 'awaiting-gate' ? ' badge--gate' : '') + '">gate</span>' : '',
      detail: isOpen ? detailHtml(view, vm, ctx) : ''
    });
  }
  D.rowHtml = rowHtml;

  /** One pipeline step (a layer of 1+ nodes): { key, status, html }. */
  function stepsOf(view, ctx) {
    return layers(view).map(function (ids) {
      var st = groupStatus(view, ids);
      var inner = ids.length > 1
        ? '<p class="par-label">' + esc(ids.join(' and ')) + ' run in parallel</p><div class="parallel">' + ids.map(function (i) { return rowHtml(view, i, ctx); }).join('') + '</div>'
        : rowHtml(view, ids[0], ctx);
      return { key: ids.join('+'), status: st, html: '<span class="marker" style="color:var(--st-' + (st === 'awaiting-gate' ? 'gate' : st) + ')">' + icon(st, 20) + '</span>' + inner };
    });
  }
  D.stepsOf = stepsOf;

  /* ---------- activity feed (newest first) ---------- */
  var KIND = { run: '◆', session: '■', gate: '‖', decision: '✓', start: '▶', skip: '–', fail: '✕', info: '·', text: '“', tool: '›' };
  function isAgent(it) { return it.kind === 'text' || it.kind === 'tool'; }
  D.isAgent = isAgent;
  function feedItemHtml(it, isNew) {
    var kind = KIND[it.kind] ? it.kind : 'info';
    return T('<li class="ev ev-{kind}{cls}"><time datetime="{ts}"{{ap}}>{t}</time><span class="k" aria-hidden="true">{g}</span><span class="t">{{node}}{{tool}}{x}{{trunc}}</span></li>', {
      kind: kind, cls: (kind === 'text' ? ' ev-agent' : '') + (isNew ? ' new' : ''), ts: it.ts,
      ap: it.approx ? ' title="timestamp approximate"' : '', t: fmtTime(it.ts), g: KIND[kind],
      node: it.node ? '<span class="nt">' + esc(it.node) + '</span>' : '',
      tool: kind === 'tool' ? '<b class="tn">' + esc(it.tool || 'tool') + '</b> ' : '',
      x: it.text, trunc: it.truncated ? ' <span class="muted" title="summary salvaged from a transcript line cut at 8 KB">(truncated)</span>' : ''
    });
  }
  /** items: oldest-first array; fresh: {id:true} set of ids to flash. */
  function feedHtml(items, showAgent, fresh) {
    var list = items.filter(function (it) { return showAgent || !isAgent(it); }).slice().reverse();
    var day = '', h = '';
    list.forEach(function (it) {
      var d = fmtDay(it.ts);
      if (d !== day) { day = d; h += T('<li class="day">{d}</li>', { d: d }); }
      h += feedItemHtml(it, !!(fresh && fresh[it.id]));
    });
    return { html: h, count: list.length };
  }
  D.feedHtml = feedHtml;

  /** Insert items into an oldest-first array (by ts, stable), skipping known ids. Returns the new ids. */
  function mergeItems(items, seen, incoming) {
    var added = [];
    incoming.forEach(function (it) {
      if (seen[it.id]) return;
      seen[it.id] = true;
      var i = items.length;
      while (i > 0 && items[i - 1].ts > it.ts) i--;
      items.splice(i, 0, it);
      added.push(it);
    });
    return added;
  }
  D.mergeItems = mergeItems;

  root.DRUI = D;
})(typeof window !== 'undefined' ? window : this);
`;
