/**
 * client-app.ts — the DOM/network half of the page's inline client script:
 * fetch + EventSource wiring, keyed re-rendering that preserves user state,
 * timers, theme, copy. Everything that turns run data into markup lives in
 * client-core.ts (pure, unit-tested under node:vm); this half only moves
 * strings into the DOM and keeps scroll/focus/open/tab state across live
 * updates. Verified in a real browser (see DECISIONS.md § ui-mockup-port-and-live-tail).
 *
 * Same authoring rules as client-core.ts: a `String.raw` literal, so NO
 * backticks and NO `${` inside APP_JS.
 *
 * State preserved across every live update (the point of "live that works"):
 *   - which nodes the user opened, and each node's selected tab / file
 *     (`S.ui`, keyed by node id — never derived from the DOM);
 *   - scroll positions of the tab panel and the Output tail (re-applied after a
 *     row's HTML is replaced; the tail follows new lines only if it was at the
 *     bottom) and of the run chips / the feed;
 *   - keyboard focus (re-focused by `data-fk` after a replace);
 *   - rows whose HTML did not change are not touched at all.
 */

export const APP_JS = String.raw`
(function () {
  'use strict';
  var D = window.DRUI;
  if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var MAX_ITEMS = 700;

  /* ---------- theme: system / light / dark (#light / #dark in the URL forces one) ---------- */
  (function theme() {
    var btn = $('theme'), modes = ['system', 'light', 'dark'], m = 'system';
    try { m = localStorage.getItem('dr-theme') || 'system'; } catch (e) {}
    var hm = /(light|dark)/.exec(location.hash); if (hm) m = hm[1];
    function apply() {
      if (m === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', m);
      btn.textContent = 'Theme: ' + m.charAt(0).toUpperCase() + m.slice(1);
      btn.setAttribute('aria-label', 'Theme ' + m + '. Click to change.');
    }
    apply();
    window.addEventListener('hashchange', function () {
      var h = /(light|dark)/.exec(location.hash);
      if (h) { m = h[1]; apply(); }
    });
    btn.addEventListener('click', function () {
      m = modes[(modes.indexOf(m) + 1) % 3];
      try { localStorage.setItem('dr-theme', m); } catch (e) {}
      apply();
    });
  })();

  /* ---------- state ---------- */
  function newUi() { return { open: {}, tab: {}, file: {}, gateHistoryOpen: false }; }
  var S = {
    runs: [], runsLoaded: false, runId: null, view: null, error: null,
    items: [], seen: {}, fresh: {}, feedTotal: 0,
    ui: newUi(), outputs: {}, art: {}, seenRunning: {}, lastGate: null,
    es: null, conn: 'connecting', retry: null, token: 0
  };

  /* ---------- DOM patching that keeps scroll + focus ---------- */
  function patch(el, html) {
    if (el.__h === html) return false;
    var active = document.activeElement, fk = null;
    if (active && el.contains(active) && active.getAttribute) {
      fk = (active.getAttribute('data-fk') || '') + '|' + (active.getAttribute('data-node') || '');
    }
    var saved = {};
    Array.prototype.forEach.call(el.querySelectorAll('[data-scroll]'), function (n) {
      var k = n.getAttribute('data-scroll');
      (saved[k] = saved[k] || []).push({ top: n.scrollTop, bottom: n.scrollHeight - n.scrollTop - n.clientHeight < 24 });
    });
    el.__h = html;
    el.innerHTML = html;
    var idx = {};
    Array.prototype.forEach.call(el.querySelectorAll('[data-scroll]'), function (n) {
      var k = n.getAttribute('data-scroll'), i = idx[k] = (idx[k] == null ? 0 : idx[k] + 1);
      var prev = saved[k] && saved[k][i];
      if (k === 'tail') n.scrollTop = !prev || prev.bottom ? n.scrollHeight : prev.top;
      else if (prev) n.scrollTop = prev.top;
    });
    if (fk) {
      var cands = el.querySelectorAll('[data-fk]');
      for (var i = 0; i < cands.length; i++) {
        if ((cands[i].getAttribute('data-fk') || '') + '|' + (cands[i].getAttribute('data-node') || '') === fk) {
          try { cands[i].focus({ preventScroll: true }); } catch (e) {}
          break;
        }
      }
    }
    return true;
  }

  function ctx() {
    return {
      ui: S.ui,
      art: function (node, name) { var a = S.art[node + '/' + name]; return a ? a.html : null; },
      output: function (node) { var o = S.outputs[node]; return o ? { items: o.items, loaded: o.loaded } : { items: [], loaded: false }; }
    };
  }

  /* ---------- rendering ---------- */
  function renderRuns() {
    var el = $('runs'), sl = el.scrollLeft;
    var html = S.runsLoaded ? D.runsHtml(S.runs, S.runId) : '<p class="muted">Loading runs…</p>';
    if (patch(el, html)) el.scrollLeft = sl;
  }
  function renderHero() {
    var el = $('hero');
    if (S.view) patch(el, D.heroHtml(S.view));
    else if (S.error) patch(el, D.T('<p class="err">Could not load run {id}: {e}</p>', { id: S.runId || '', e: S.error }));
    else patch(el, S.runId ? '<p class="muted">Loading run…</p>' : '<p class="muted">Select a run above.</p>');
  }
  function renderGate() {
    var el = $('gate'), html = S.view ? D.gateHtml(S.view, S.ui) : '';
    patch(el, html);
    el.hidden = !html;
  }
  function renderPipe() {
    var pipe = $('pipe');
    if (!S.view) { patch(pipe, ''); return; }
    var steps = D.stepsOf(S.view, ctx());
    var existing = {};
    Array.prototype.forEach.call(pipe.children, function (li) { existing[li.getAttribute('data-key')] = li; });
    steps.forEach(function (s, i) {
      var li = existing[s.key]; delete existing[s.key];
      if (!li) { li = document.createElement('li'); li.setAttribute('data-key', s.key); }
      var cls = 'step ' + s.status;
      if (li.className !== cls) li.className = cls;
      patch(li, s.html);
      var want = pipe.children[i];
      if (want !== li) pipe.insertBefore(li, want || null);
    });
    Object.keys(existing).forEach(function (k) { pipe.removeChild(existing[k]); });
    pipe.__h = null;
  }
  function renderFeed() {
    var box = $('feedbox'), f = D.feedHtml(S.items, $('agentMsgs').checked, S.fresh);
    S.fresh = {};
    var cnt = f.count + ' events';
    var hidden = S.feedTotal - S.items.length;
    if (hidden > 0) cnt += ' · ' + hidden + ' older agent items not shown';
    $('feedCount').textContent = cnt;
    if (box.__h === f.html) return;
    var top = box.scrollTop, h = box.scrollHeight;
    box.__h = f.html;
    $('feed').innerHTML = f.html;
    // Newest is at the top, so the live edge is scrollTop 0. Follow it only if the reader is there;
    // otherwise keep their place by compensating for the rows inserted above.
    if (top > 24) box.scrollTop = top + (box.scrollHeight - h);
  }
  function renderConn() {
    var terminal = S.view && D.isTerminal(S.view.runStatus);
    var text, cls;
    if (S.error && !S.view) { text = 'Server unreachable — retrying…'; cls = 'bad'; }
    else if (!S.runId) { text = S.runsLoaded ? 'No run selected' : 'Connecting…'; cls = S.runsLoaded ? 'idle' : 'wait'; }
    else if (S.conn === 'live') { text = terminal ? 'Run finished' : 'Live · connected'; cls = terminal ? 'idle' : 'live'; }
    else if (S.conn === 'reconnecting') { text = 'Reconnecting…'; cls = 'wait'; }
    else { text = 'Connecting…'; cls = 'wait'; }
    $('connText').textContent = text;
    $('conn').className = 'watch ' + cls;
  }
  function renderTitle() {
    document.title = S.view ? 'dagrun ui — ' + S.view.runId + ' · ' + (D.RUNSTATUS[S.view.runStatus] || S.view.runStatus) : 'dagrun ui';
  }
  function renderAll() { renderRuns(); renderHero(); renderGate(); renderPipe(); renderFeed(); renderConn(); renderTitle(); tick(); }

  /* ---------- ticking readouts: only textContent of [data-since] spans, never a re-render ---------- */
  function tick() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-since]'), function (el) {
      var since = new Date(el.getAttribute('data-since')).getTime();
      var until = el.getAttribute('data-until');
      var end = until ? new Date(until).getTime() : Date.now();
      if (!isNaN(since) && !isNaN(end)) el.textContent = D.fmtDur(Math.max(0, end - since));
    });
  }
  setInterval(tick, 1000);

  /* ---------- lazy artifact + output loading ---------- */
  function getJson(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.json(); }); }

  function ensureArtifacts() {
    if (!S.view) return;
    var token = S.token, runId = S.runId;
    Object.keys(S.ui.open).forEach(function (id) {
      if (!S.ui.open[id] || (S.ui.tab[id] || 'artifacts') !== 'artifacts') return;
      var vm = D.nodeVM(S.view, id);
      var f = D.pickFile(D.fileList(vm), S.ui.file[id]);
      if (!f || f.expected) return;
      var key = id + '/' + f.name, sig = f.size + ':' + f.mtime, e = S.art[key];
      if (e && (e.sig === sig || e.loading)) return;
      S.art[key] = { html: e ? e.html : null, sig: e ? e.sig : null, loading: true };
      getJson('/api/runs/' + encodeURIComponent(runId) + '/artifact?node=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(f.name))
        .then(function (v) { return { html: v.html, sig: v.size + ':' + v.mtime }; })
        .catch(function (err) { return { html: D.T('<div class="placeholder">Could not load {n}: {e}</div>', { n: f.name, e: err.message }), sig: sig }; })
        .then(function (r) {
          if (token !== S.token) return;
          S.art[key] = { html: r.html, sig: r.sig, loading: false };
          renderPipe();
          ensureArtifacts(); // the file may have changed again while it was loading
        });
    });
  }
  function outputOf(id) { return S.outputs[id] || (S.outputs[id] = { items: [], seen: {}, loaded: false, loading: false }); }
  function ensureOutputs() {
    if (!S.view) return;
    var token = S.token, runId = S.runId;
    Object.keys(S.ui.open).forEach(function (id) {
      if (!S.ui.open[id] || S.ui.tab[id] !== 'output') return;
      var o = outputOf(id);
      if (o.loaded || o.loading) return;
      o.loading = true;
      getJson('/api/runs/' + encodeURIComponent(runId) + '/output?node=' + encodeURIComponent(id))
        .then(function (r) { D.mergeItems(o.items, o.seen, r.items || []); })
        .catch(function () {})
        .then(function () { if (token !== S.token) return; o.loading = false; o.loaded = true; renderPipe(); });
    });
  }

  /* ---------- applying data ---------- */
  function defaultTab(status) { return status === 'running' ? 'output' : 'artifacts'; }
  function applyView(v) {
    S.view = v; S.error = null;
    S.runs.forEach(function (r) { if (r.runId === v.runId) { r.status = v.runStatus; r.cost = v.totalCost; r.updatedAt = v.updatedAt; } });
    // Open what the reader most wants to watch: the awaiting gate, and each node the first time it is seen running.
    var g = v.gate ? v.gate.nodeId : null;
    if (g && g !== S.lastGate) { S.ui.open[g] = true; }
    S.lastGate = g;
    v.nodeOrder.forEach(function (id) {
      var n = v.nodes[id];
      if (n && n.status === 'running' && !S.seenRunning[id]) {
        S.seenRunning[id] = true;
        S.ui.open[id] = true;
        if (!S.ui.tab[id]) S.ui.tab[id] = 'output';
      }
    });
    ensureArtifacts(); ensureOutputs();
    renderAll();
  }
  function applyItems(items, live) {
    var added = D.mergeItems(S.items, S.seen, items);
    if (S.items.length > MAX_ITEMS) {
      var drop = S.items.splice(0, S.items.length - MAX_ITEMS);
      drop.forEach(function (it) { delete S.seen[it.id]; });
    }
    var touchedOutput = false;
    added.forEach(function (it) {
      if (live) S.fresh[it.id] = true;
      if (it.node && D.isAgent(it)) {
        var o = outputOf(it.node);
        D.mergeItems(o.items, o.seen, [it]);
        if (o.items.length > 300) o.items.splice(0, o.items.length - 300);
        if (S.ui.open[it.node] && S.ui.tab[it.node] === 'output') touchedOutput = true;
      }
    });
    if (added.length) { renderFeed(); if (touchedOutput) renderPipe(); }
  }

  /* ---------- connection: REST first paint, then SSE; the server re-sends snapshot + history on every (re)connect ---------- */
  function closeEs() { if (S.es) { S.es.close(); S.es = null; } if (S.retry) { clearTimeout(S.retry); S.retry = null; } }
  function connect(id, token) {
    closeEs();
    if (!window.EventSource) return;
    var es = new EventSource('/api/runs/' + encodeURIComponent(id) + '/stream');
    S.es = es; S.conn = 'connecting'; renderConn();
    es.onopen = function () { S.conn = 'live'; renderConn(); };
    es.onerror = function () {
      S.conn = 'reconnecting'; renderConn();
      if (es.readyState === 2) { S.retry = setTimeout(function () { if (token === S.token) connect(id, token); }, 3000); }
    };
    es.addEventListener('snapshot', function (ev) { if (token === S.token) { try { applyView(JSON.parse(ev.data)); renderConn(); } catch (e) {} } });
    es.addEventListener('feed', function (ev) {
      if (token !== S.token) return;
      try { var d = JSON.parse(ev.data); if (typeof d.total === 'number') S.feedTotal = Math.max(S.feedTotal, d.total); applyItems(d.items || [], !d.history); } catch (e) {}
    });
  }
  function load(id) {
    var token = S.token;
    Promise.all([getJson('/api/runs/' + encodeURIComponent(id)), getJson('/api/runs/' + encodeURIComponent(id) + '/feed')]).then(function (r) {
      if (token !== S.token) return;
      S.feedTotal = r[1].total || 0;
      applyItems(r[1].items || [], false);
      applyView(r[0]);
      connect(id, token);
    }).catch(function (err) {
      if (token !== S.token) return;
      S.error = err.message; S.view = null; renderAll();
      S.retry = setTimeout(function () { if (token === S.token) load(id); }, 3000);
    });
  }
  function selectRun(id, push) {
    closeEs();
    S.token++; S.runId = id; S.view = null; S.error = null; S.items = []; S.seen = {}; S.fresh = {}; S.feedTotal = 0;
    S.ui = newUi(); S.outputs = {}; S.art = {}; S.seenRunning = {}; S.lastGate = null; S.conn = 'connecting';
    if (push) { try { history.pushState(null, '', '?run=' + encodeURIComponent(id) + location.hash); } catch (e) {} }
    $('feed').innerHTML = ''; $('feedbox').__h = null;
    renderAll();
    load(id);
  }

  /* ---------- live run list: poll so a run started after page load appears and chip statuses move ---------- */
  function loadRuns() {
    getJson('/api/runs').then(function (list) {
      S.runs = D.sortRuns(list); S.runsLoaded = true;
      if (!S.runId) {
        var want = new URLSearchParams(location.search).get('run');
        var pick = S.runs.filter(function (r) { return r.runId === want; })[0] || S.runs.filter(function (r) { return r.error === undefined; })[0];
        if (pick) { try { history.replaceState(null, '', '?run=' + encodeURIComponent(pick.runId) + location.hash); } catch (e) {} selectRun(pick.runId, false); return; }
      }
      renderRuns(); renderConn();
    }).catch(function (err) { S.runsLoaded = true; if (!S.runId) { S.error = err.message; } renderAll(); });
  }
  setInterval(loadRuns, 5000);

  /* ---------- interaction (delegated: rows are replaced on live updates, listeners must survive) ---------- */
  function openNode(id, tab) {
    S.ui.open[id] = true;
    if (tab) S.ui.tab[id] = tab;
    if (!S.ui.tab[id]) S.ui.tab[id] = defaultTab(S.view && S.view.nodes[id] ? S.view.nodes[id].status : 'pending');
    ensureArtifacts(); ensureOutputs(); renderPipe();
  }
  function copy(text, btn) {
    var done = function (okk) { btn.textContent = okk ? 'Copied' : 'Select + ⌘C'; setTimeout(function () { btn.textContent = 'Copy command'; }, 1600); };
    var fallback = function () { var r = document.createRange(); r.selectNodeContents($('gateCmd')); var w = getSelection(); w.removeAllRanges(); w.addRange(r); done(false); };
    try { navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); } catch (e) { fallback(); }
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-run],[data-act]') : null;
    if (!t) return;
    if (t.hasAttribute('data-run')) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let "open in new tab" work
      e.preventDefault(); selectRun(t.getAttribute('data-run'), true); return;
    }
    var act = t.getAttribute('data-act'), node = t.getAttribute('data-node');
    if (act === 'row') {
      if (S.ui.open[node]) { delete S.ui.open[node]; renderPipe(); }
      else openNode(node);
    } else if (act === 'tab') { S.ui.tab[node] = t.getAttribute('data-tab'); ensureArtifacts(); ensureOutputs(); renderPipe(); }
    else if (act === 'file') { S.ui.file[node] = t.getAttribute('data-name'); ensureArtifacts(); renderPipe(); }
    else if (act === 'copy') { copy($('gateCmd').textContent || '', t); }
    else if (act === 'see-node') {
      openNode(node, 'artifacts');
      var b = document.querySelector('.rowbtn[data-node="' + String(node).replace(/["\\]/g, '') + '"]');
      if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
    }
  });
  document.addEventListener('keydown', function (e) {
    var cur = document.activeElement;
    if (!cur || cur.getAttribute('data-act') !== 'tab') return;
    var list = cur.parentNode, tabs = Array.prototype.slice.call(list.querySelectorAll('[data-act="tab"]'));
    var i = tabs.indexOf(cur), j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = tabs.length - 1;
    if (j == null) return;
    e.preventDefault();
    var node = tabs[j].getAttribute('data-node');
    S.ui.tab[node] = tabs[j].getAttribute('data-tab');
    ensureArtifacts(); ensureOutputs(); renderPipe();
  });
  // <details> 'toggle' does not bubble; capture it so the gate's decision-history stays open across re-renders.
  document.addEventListener('toggle', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-act') === 'gate-history') S.ui.gateHistoryOpen = t.open;
  }, true);
  $('agentMsgs').addEventListener('change', renderFeed);
  window.addEventListener('popstate', function () {
    var id = new URLSearchParams(location.search).get('run');
    if (id && id !== S.runId) selectRun(id, false);
  });

  renderAll();
  loadRuns();
})();
`;
