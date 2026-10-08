/**
 * page.test.ts — the static shell: every mount point the client script needs
 * exists, the inline scripts are syntactically valid JavaScript (a stray
 * backtick/`${` slip in a String.raw literal would break the whole page), and
 * nothing is loaded from the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { renderPage } from "./page.js";

const html = renderPage();

test("shell has every mount point the client script binds to", () => {
  for (const id of ["conn", "connText", "theme", "runs", "hero", "gate", "pipe", "feedbox", "feed", "feedCount", "agentMsgs"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<meta name="viewport"/);
});

test("both inline scripts parse as JavaScript (no template-literal escaping slip)", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});

test("self-contained: no network loads of any kind (no external src/href/@import/url(), no fonts)", () => {
  assert.doesNotMatch(html, /\s(?:src|href)="\s*(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:|<link\b|<script[^>]+src=/i);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)/i);
});

test("read-only by construction: the page has no decide/approve control and no write verbs", () => {
  assert.doesNotMatch(html, /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i);
  assert.doesNotMatch(html, /<form\b/i);
  assert.match(html, /Decisions are made in the companion conversation, not here/);
});

test("no-JS fallback points at `dagrun status <run> --json`; live state is honest, not a replay", () => {
  assert.match(html, /<noscript>[\s\S]*dagrun status &lt;run&gt; --json/);
  assert.doesNotMatch(html, /replay|SIMULATED|Simulated|mockup/);
  assert.match(html, /Live · connected/);
  assert.match(html, /Reconnecting…/);
  assert.match(html, /Run finished/);
});
