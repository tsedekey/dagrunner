/**
 * page.ts — the single self-contained HTML page `dagrun ui` serves.
 *
 * Pure string templating (CLAUDE.md: "vanilla HTML string-templating, no
 * React/Vite/Tailwind/build step"): a STATIC shell + inline CSS + inline client
 * script. Nothing is loaded from the network (system fonts only), and CSS/JS
 * are deliberately NOT separate static files — that would need a dist-copy
 * build step the "no build step" rule forbids.
 *
 * Client-rendered: the shell has empty mount points; `client-core.ts` (pure,
 * unit-tested renderers) and `client-app.ts` (fetch/EventSource/DOM) fill them
 * from the JSON endpoints and keep them live. This is the design of the
 * approved mockup (direction 2, "timeline") and deliberately REVERSES the
 * earlier "no-JS-safe, server-rendered timeline" decision — see DECISIONS.md
 * § ui-mockup-port-and-live-tail. Without JS the page shows only a notice that
 * points at `dagrun status <run> --json`.
 */

import { CORE_JS } from "./client-core.js";
import { APP_JS } from "./client-app.js";

export const CSS = `
:root{
  --bg:#f6f7f9;--surface:#ffffff;--surface-2:#eef0f4;--ink:#1a1d24;--muted:#5b6270;--line:#dfe2e8;--spine:#cfd4dc;
  --accent:#3b4ba8;--accent-soft:#e8eafa;--code-bg:#f0f1f5;--focus:#3b4ba8;
  --st-done:#257547;--st-running:#2458c6;--st-gate:#9c4a05;--st-failed:#b3261e;--st-skipped:#5c616a;--st-pending:#5f6570;
  --gate-bg:#fff6ea;--gate-line:#efc68f;
  --term-bg:#1c1f2a;--term-ink:#dfe3ee;--term-muted:#8990a3;--term-accent:#aab5f5;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  color-scheme:dark;--bg:#121419;--surface:#1a1d24;--surface-2:#20242d;--ink:#e6e8ee;--muted:#9aa1ae;--line:#2c313b;--spine:#353b47;
  --accent:#9eabf2;--accent-soft:#252a45;--code-bg:#232733;--focus:#9eabf2;
  --st-done:#63c98f;--st-running:#7fa8ff;--st-gate:#f0a650;--st-failed:#f07b72;--st-skipped:#949aa5;--st-pending:#959cab;
  --gate-bg:#2a2012;--gate-line:#634419;--term-bg:#0d0f14;
}}
:root[data-theme="dark"]{
  color-scheme:dark;--bg:#121419;--surface:#1a1d24;--surface-2:#20242d;--ink:#e6e8ee;--muted:#9aa1ae;--line:#2c313b;--spine:#353b47;
  --accent:#9eabf2;--accent-soft:#252a45;--code-bg:#232733;--focus:#9eabf2;
  --st-done:#63c98f;--st-running:#7fa8ff;--st-gate:#f0a650;--st-failed:#f07b72;--st-skipped:#949aa5;--st-pending:#959cab;
  --gate-bg:#2a2012;--gate-line:#634419;--term-bg:#0d0f14;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans)}
button,select{font:inherit;color:inherit}
code{font-family:var(--mono)}
a{color:var(--accent)}
/* shared content styles */
.st{display:inline-flex;align-items:center;gap:.4em;font-weight:600;font-size:.8125rem;line-height:1;white-space:nowrap}
.st--done{color:var(--st-done)}.st--running{color:var(--st-running)}.st--awaiting-gate{color:var(--st-gate)}
.st--failed{color:var(--st-failed)}.st--skipped{color:var(--st-skipped)}.st--pending{color:var(--st-pending)}
.st-ico{flex:none;--ico-on:var(--surface)}
.st-ico .spin{transform-origin:8px 8px;animation:dr-spin 1.1s linear infinite}
@keyframes dr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.st-ico .spin,.pulse{animation:none!important}}
.md{font-size:.875rem;line-height:1.6;color:var(--ink);max-width:72ch}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{font-size:1rem;line-height:1.3;margin:1.2em 0 .4em;text-wrap:balance}
.md h1,.md h2{font-size:1.0625rem}.md>:first-child{margin-top:0}
.md p{margin:.5em 0}.md ul,.md ol{margin:.4em 0;padding-left:1.3em}.md li{margin:.2em 0}
.md code,.inline-code{font-family:var(--mono);font-size:.8em;background:var(--code-bg);padding:.1em .35em;border-radius:4px;overflow-wrap:anywhere}
.md pre,.json,.text{font-family:var(--mono);font-size:.78rem;line-height:1.55;background:var(--code-bg);color:var(--ink);padding:.8em 1em;border-radius:6px;overflow-x:auto;white-space:pre;margin:.6em 0}
.md pre code{background:none;padding:0;font-size:inherit}
.md blockquote{margin:.6em 0;padding-left:.9em;border-left:3px solid var(--line);color:var(--muted)}
.md-table{overflow-x:auto}.md table{border-collapse:collapse;font-size:.8125rem}.md th,.md td{border:1px solid var(--line);padding:.35em .6em;text-align:left;vertical-align:top}
.md a{color:var(--accent)}
.json code{background:none;padding:0}
.j-key{color:var(--accent)}.j-str{color:var(--st-done)}.j-num{color:var(--st-gate)}
.placeholder{font-size:.8125rem;color:var(--muted);border:1px dashed var(--line);border-radius:6px;padding:.75em 1em;line-height:1.5}
.tail{list-style:none;margin:0;padding:.6em 0;font-family:var(--mono);font-size:.75rem;line-height:1.5;background:var(--term-bg);color:var(--term-ink);border-radius:6px;max-height:22rem;overflow:auto}
.tail li{display:grid;grid-template-columns:5.5em 4.6em 1fr;gap:.6em;padding:.1em .9em}
.tail time{color:var(--term-muted)}.tail b{font-weight:600;color:var(--term-accent);overflow:hidden;text-overflow:ellipsis}
.tail .tail-text span{color:var(--term-ink);font-style:italic}.tail span{overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--muted)}
.err{color:var(--st-failed)}
.decisions{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.dec{border:1px solid var(--line);border-radius:6px;padding:.6rem .75rem;background:var(--surface)}
.dec-head{display:flex;flex-wrap:wrap;gap:.3rem .7rem;align-items:baseline;font-size:.8125rem}
.dec-head time{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.dec-action{font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:.6875rem;padding:.15em .5em;border-radius:3px;border:1px solid currentColor}
.dec--approve .dec-action{color:var(--st-done)}.dec--amend .dec-action,.dec--reject .dec-action{color:var(--st-gate)}.dec--hold .dec-action{color:var(--muted)}
.dec-meta{display:grid;gap:.15rem;margin:.45rem 0 0;font-size:.75rem}
.dec-meta div{display:grid;grid-template-columns:5.5em 1fr;gap:.5em}.dec-meta dt{color:var(--muted)}.dec-meta dd{margin:0;overflow-wrap:anywhere}
.dec-meta code{font-family:var(--mono)}
.dec-comment{margin-top:.4rem;font-size:.8125rem}.dec-comment summary{cursor:pointer;color:var(--accent)}.dec-comment p{margin:.4rem 0 0;line-height:1.55;max-width:70ch;white-space:pre-wrap}
[hidden]{display:none!important}
.diff{font-family:var(--mono);font-size:.74rem;line-height:1.5;background:var(--code-bg);border-radius:6px;padding:.6em 0;overflow-x:auto;margin:.4em 0;max-height:28rem}
.diff code{background:none}
.diff .dl{display:block;padding:0 .9em 0 0;white-space:pre}
.diff .dg{display:inline-block;width:1.8em;text-align:center;color:var(--muted);user-select:none}
.diff .dl-add{background:color-mix(in srgb,var(--st-done) 14%,transparent)}.diff .dl-add .dg{color:var(--st-done);font-weight:700}
.diff .dl-del{background:color-mix(in srgb,var(--st-failed) 14%,transparent)}.diff .dl-del .dg{color:var(--st-failed);font-weight:700}
.diff .dl-hunk{color:var(--accent)}.diff .dl-meta{color:var(--muted);font-weight:600}
/* page */
.wrap{max-width:84rem;margin:0 auto;padding-inline:clamp(16px,3vw,40px);padding-block:0 6rem}
.bar{display:flex;align-items:center;gap:.75rem 1.25rem;flex-wrap:wrap;padding-block:1rem}
.logo{font-weight:700;letter-spacing:-.01em}.logo span{color:var(--muted);font-weight:500}
.bar .spacer{flex:1}
.btn{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:.35rem .85rem;cursor:pointer;font-size:.8125rem}
.btn:hover{border-color:var(--muted)}
.watch{font-size:.8125rem;color:var(--muted);display:inline-flex;align-items:center;gap:.4rem}
.watch i{width:.45rem;height:.45rem;border-radius:50%;background:var(--st-skipped)}
.watch.live i{background:var(--st-done)}.watch.wait i{background:var(--st-gate)}.watch.bad i{background:var(--st-failed)}
.watch.live i{animation:pulse 2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.noscript{margin:1rem 0;padding:.8rem 1rem;border:1px solid var(--gate-line);background:var(--gate-bg);border-radius:8px}
/* runs row */
.runs{display:flex;gap:.5rem;overflow-x:auto;padding-bottom:.4rem;margin-bottom:1.5rem;scrollbar-width:thin}
.runcard{flex:none;display:grid;gap:.25rem;min-width:9.5rem;text-align:left;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:.5rem .65rem;cursor:pointer;text-decoration:none;color:inherit}
.runcard[aria-current="true"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.runcard .rid{font-family:var(--mono);font-size:.78rem;font-weight:600}
.runcard .rm{font-size:.72rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}
.runs-h{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:0 0 .45rem}
/* hero */
.hero{display:grid;gap:.6rem;margin-bottom:1.5rem;min-height:5rem}
.eyebrow{font-size:.8125rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.3rem .8rem}
.eyebrow code{font-size:.78rem}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(1.5rem,2.4vw,2.1rem);line-height:1.2;margin:0;text-wrap:balance;max-width:52ch;letter-spacing:-.005em;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:.5rem 1.6rem;font-size:.875rem;align-items:center}
.meta b{font-variant-numeric:tabular-nums}
.meta .lab{color:var(--muted);margin-right:.35rem}
.run-st{font-size:.9rem}
/* gate letter */
.gate{background:var(--gate-bg);border:1px solid var(--gate-line);border-radius:14px;padding:1.25rem 1.4rem;margin-bottom:2rem;display:grid;gap:1rem;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}
.gate h2{font-family:var(--serif);font-size:1.4rem;font-weight:600;margin:0 0 .4rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.gate h2 .st-ico{color:var(--st-gate)}
.gate p{margin:.35rem 0;max-width:62ch}
.gate .who{font-size:.875rem}
.cmdrow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.8rem}
.cmd{font-family:var(--mono);font-size:.8125rem;background:var(--surface);border:1px solid var(--gate-line);border-radius:6px;padding:.3rem .6rem}
.gfacts{display:grid;gap:.55rem;margin:0;font-size:.875rem;align-content:start}
.gfacts div{display:grid;grid-template-columns:8.5rem 1fr;gap:.6rem}
.gfacts dt{color:var(--muted)}.gfacts dd{margin:0;overflow-wrap:anywhere}
.flow{display:flex;flex-wrap:wrap;gap:.25rem .35rem;align-items:center}
.flow span{font-family:var(--mono);font-size:.78rem}
.flow i{color:var(--muted);font-style:normal;font-size:.75rem}
.gate details{grid-column:1/-1;border-top:1px solid var(--gate-line);padding-top:.7rem}
.gate summary{cursor:pointer;font-weight:600;font-size:.875rem}
.gate .decisions{margin-top:.6rem}
/* columns */
.cols{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(18rem,1fr);gap:2.5rem;align-items:start}
.cols>section:last-child{position:sticky;top:1rem}
.col-h{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:0 0 .8rem;display:flex;align-items:center;gap:.6rem}
.col-h .fill{flex:1;height:1px;background:var(--line)}
/* pipeline */
.pipe{list-style:none;margin:0;padding:0;position:relative}
.step{position:relative;padding-left:3rem;padding-bottom:.9rem}
.step::before{content:"";position:absolute;left:1rem;top:1.9rem;bottom:-.1rem;width:2px;background:var(--spine)}
.step:last-child::before{display:none}
.step.done::before{background:var(--st-done)}
.step.skipped::before{background:repeating-linear-gradient(var(--spine) 0 4px,transparent 4px 8px)}
.marker{position:absolute;left:.25rem;top:.55rem;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--bg);display:grid;place-items:center}
.marker .st-ico{width:1.3rem;height:1.3rem}
.row{border:1px solid var(--line);background:var(--surface);border-radius:10px}
.step.running .row{border-color:var(--st-running);box-shadow:0 0 0 1px var(--st-running)}
.step.awaiting-gate .row{border-color:var(--st-gate);box-shadow:0 0 0 1px var(--st-gate)}
.step.skipped .row,.step.pending .row{background:transparent;border-style:dashed}
.rowbtn{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.2rem 1rem;width:100%;padding:.7rem 1rem;cursor:pointer;border-radius:10px}
.rowbtn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.nname{font-family:var(--serif);font-size:1.2rem;font-weight:600;display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
.step.pending .nname,.step.skipped .nname{color:var(--muted)}
.nmeta{grid-column:1;font-size:.8125rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.2rem .9rem;font-variant-numeric:tabular-nums}
.nside{grid-row:1/3;grid-column:2;display:flex;flex-direction:column;align-items:flex-end;gap:.3rem;justify-content:center}
.chev{color:var(--muted);transition:transform .15s}
.rowbtn[aria-expanded="true"] .chev{transform:rotate(90deg)}
.badge{font-size:.6875rem;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:.05rem .4rem;font-family:var(--sans)}
.badge--gate{color:var(--st-gate);border-color:currentColor}
.detail{border-top:1px solid var(--line);padding:.9rem 1rem 1rem}
.detail [role=tabpanel]{max-height:34rem;overflow:auto}
.tabs{display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:.9rem}
.tab{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:.25rem .75rem;font-size:.8125rem;cursor:pointer;color:var(--muted)}
.tab[aria-selected="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--ink);font-weight:600}
.files{display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.8rem}
.file{font-family:var(--mono);font-size:.75rem;border:0;background:var(--surface-2);border-radius:4px;padding:.25rem .55rem;cursor:pointer;color:var(--ink)}
.file[aria-pressed="true"]{background:var(--accent);color:var(--surface)}
.file.expected{background:transparent;outline:1px dashed var(--line);color:var(--muted)}
.file.bk{color:var(--muted)}
.kv{display:grid;grid-template-columns:8rem 1fr;gap:.35rem .8rem;font-size:.8125rem;margin:0}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.note{font-size:.8rem;color:var(--muted);margin:.4rem 0 .7rem}
.parallel{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.parallel .row{height:100%}
.par-label{font-size:.72rem;color:var(--muted);margin:0 0 .35rem;letter-spacing:.04em}
/* feed */
.feed-tools{display:flex;gap:.6rem;align-items:center;font-size:.8125rem;margin-bottom:.6rem;color:var(--muted);flex-wrap:wrap}
.feedbox{max-height:calc(100vh - 9rem);overflow:auto;padding-right:.3rem}
.feed{list-style:none;margin:0;padding:0;font-size:.875rem}
.day{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);padding:.8rem 0 .3rem;position:sticky;top:0;background:var(--bg)}
.ev{display:grid;grid-template-columns:3.4rem 1.1rem minmax(0,1fr);gap:.5rem;padding:.45rem 0;border-top:1px solid var(--line);align-items:start}
.ev time{font-family:var(--mono);font-size:.75rem;color:var(--muted);padding-top:.1rem;font-variant-numeric:tabular-nums}
.ev .k{font-size:.75rem;line-height:1.4;color:var(--muted);text-align:center}
.ev-decision .k,.ev-gate .k{color:var(--st-gate)}.ev-start .k{color:var(--st-running)}.ev-session .k{color:var(--st-done)}.ev-fail .k{color:var(--st-failed)}
.ev .t{overflow-wrap:anywhere}
.ev-agent .t{color:var(--muted);font-style:italic}
.ev-tool .t{font-size:.8125rem}
.ev .tn{font-family:var(--mono);font-size:.75rem;font-weight:600;color:var(--ink)}
.ev .nt{font-family:var(--mono);font-size:.72rem;color:var(--accent);margin-right:.35rem}
.ev.new{animation:flash 1.4s ease-out}
@keyframes flash{from{background:var(--accent-soft)}to{background:transparent}}
@media (prefers-reduced-motion:reduce){.ev.new,.watch.live i{animation:none}.chev{transition:none}}
@media (max-width:980px){.cols{grid-template-columns:minmax(0,1fr)}.cols>section:last-child{position:static}.feedbox{max-height:32rem}.gate{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.parallel{grid-template-columns:1fr}.gfacts div{grid-template-columns:1fr;gap:0}}
`;

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dagrun ui</title>
<meta name="description" content="dagrun ui: live, read-only view of a dagrunner run — pipeline, gate, activity.">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <span class="logo">dagrun <span>ui</span></span>
    <span class="watch wait" id="conn" role="status"><i></i><span id="connText">Connecting…</span></span>
    <span class="spacer"></span>
    <button class="btn" id="theme" type="button">Theme</button>
  </div>
  <noscript><p class="noscript">This viewer needs JavaScript. Without it, read the same data with <code>dagrun status &lt;run&gt; --json</code>.</p></noscript>
  <section aria-labelledby="runsH"><h2 class="runs-h" id="runsH">Runs</h2><div class="runs" id="runs"></div></section>
  <header class="hero" id="hero"></header>
  <section class="gate" id="gate" aria-labelledby="gateH" hidden></section>
  <div class="cols">
    <section aria-labelledby="pipeH"><h2 class="col-h" id="pipeH">Pipeline <span class="fill"></span></h2><ol class="pipe" id="pipe"></ol></section>
    <section aria-labelledby="feedH">
      <h2 class="col-h" id="feedH">Activity <span class="fill"></span></h2>
      <div class="feed-tools"><label><input type="checkbox" id="agentMsgs" checked> Agent messages</label><span id="feedCount"></span></div>
      <div class="feedbox" id="feedbox"><ol class="feed" id="feed" aria-live="polite"></ol></div>
      <p class="note">Engine events come from events.jsonl; agent messages and tool calls from each node's transcript.log, live while it runs.</p>
    </section>
  </div>
</div>
<script>${CORE_JS}</script>
<script>${APP_JS}</script>
</body>
</html>`;
}
