/**
 * render.test.ts — markdown/JSON/diff rendering: escaping first, modest
 * markup subset, never throwing on malformed input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  artifactKindFor,
  escapeHtml,
  renderArtifact,
  renderDiff,
  renderJson,
  renderMarkdown,
} from "./render.js";

test("escapeHtml neutralizes all five special characters", () => {
  assert.equal(
    escapeHtml(`<script>&"'</script>`),
    "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;",
  );
});

test("renderMarkdown: headings", () => {
  assert.equal(
    renderMarkdown("# Title\n## Sub"),
    "<h1>Title</h1>\n<h2>Sub</h2>",
  );
});

test("renderMarkdown: unordered and ordered lists", () => {
  const html = renderMarkdown("- one\n- two\n\n1. first\n2. second");
  assert.equal(
    html,
    "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>",
  );
});

test("renderMarkdown: code fence content is escaped and NOT interpreted as markup", () => {
  const html = renderMarkdown(
    '```js\nconst x = a < b && "<em>*not*</em>";\n```',
  );
  assert.match(html, /<pre><code class="lang-js">/);
  assert.match(html, /const x = a &lt; b/);
  assert.doesNotMatch(html, /<em>/);
});

test("renderMarkdown: bold, italic, inline code, links", () => {
  const html = renderMarkdown(
    "**bold** and *italic* and `code` and [text](https://example.com)",
  );
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com">text<\/a>/);
});

test("renderMarkdown: a javascript: link is neutered to a bare #", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assert.match(html, /<a href="#">click<\/a>/);
});

test("renderMarkdown: raw HTML in text is escaped, never passed through", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("renderMarkdown: paragraphs for plain text", () => {
  assert.equal(renderMarkdown("hello world"), "<p>hello world</p>");
});

test("renderJson: pretty-prints valid JSON", () => {
  const html = renderJson('{"a":1}');
  assert.match(html, /<pre class="json">/);
  assert.match(html, /<span class="j-key">&quot;a&quot;<\/span>: <span class="j-num">1<\/span>/);
});

test("renderJson: malformed JSON renders escaped raw text instead of throwing", () => {
  const html = renderJson("{ not json");
  assert.match(html, /json-invalid/);
  assert.match(html, /\{ not json/);
});

test("renderDiff: classifies file headers, hunks, additions, deletions, context", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    " unchanged",
  ].join("\n");
  const html = renderDiff(diff);
  assert.match(html, /<span class="dl dl-meta"><span class="dg" aria-hidden="true"> <\/span>diff --git/);
  assert.match(html, /<span class="dl dl-meta"><span class="dg" aria-hidden="true"> <\/span>--- a\/x\.ts<\/span>/);
  assert.match(html, /<span class="dl dl-meta"><span class="dg" aria-hidden="true"> <\/span>\+\+\+ b\/x\.ts<\/span>/);
  assert.match(html, /<span class="dl dl-hunk"><span class="dg" aria-hidden="true">@<\/span>@@ -1,2 \+1,2 @@<\/span>/);
  // added/removed lines carry a glyph AND screen-reader text, never colour alone
  assert.match(html, /<span class="dl dl-del"><span class="dg" aria-hidden="true">−<\/span>old line<span class="sr-only"> \(removed\)<\/span><\/span>/);
  assert.match(html, /<span class="dl dl-add"><span class="dg" aria-hidden="true">\+<\/span>new line<span class="sr-only"> \(added\)<\/span><\/span>/);
  assert.match(html, /<span class="dl dl-ctx"><span class="dg" aria-hidden="true"> <\/span> unchanged<\/span>/);
});

test("renderDiff escapes HTML-significant characters inside lines", () => {
  const html = renderDiff("+<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("artifactKindFor dispatches by extension", () => {
  assert.equal(artifactKindFor("summary.md"), "markdown");
  assert.equal(artifactKindFor("findings.json"), "json");
  assert.equal(artifactKindFor("changes.diff"), "diff");
  assert.equal(artifactKindFor("transcript.log"), "text");
});

test("renderArtifact dispatches to the right renderer by path", () => {
  assert.match(renderArtifact("a.md", "# hi"), /<div class="md"><h1>hi<\/h1><\/div>/);
  assert.match(renderArtifact("a.json", "{}"), /<pre class="json">/);
  assert.match(renderArtifact("a.diff", "+x"), /dl-add/);
  assert.match(
    renderArtifact("a.log", "plain"),
    /<pre class="text">plain<\/pre>/,
  );
});

test("renderMarkdown: pipe tables become <table>, cells are escaped and keep inline markup", () => {
  const html = renderMarkdown("| File | Claim |\n|---|---|\n| `a.java` | <img src=x onerror=alert(1)> **bold** |\n\nafter");
  assert.match(html, /<div class="md-table"><table><thead><tr><th>File<\/th><th>Claim<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /<td><code>a\.java<\/code><\/td>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<p>after<\/p>/);
});

test("renderMarkdown: blockquotes are escaped", () => {
  const html = renderMarkdown("> quoted <b>x</b>");
  assert.equal(html, "<blockquote>quoted &lt;b&gt;x&lt;/b&gt;</blockquote>");
});

test("renderMarkdown: consecutive text lines form ONE paragraph; indented list items stay list items", () => {
  assert.equal(renderMarkdown("one\ntwo"), "<p>one two</p>");
  assert.match(renderMarkdown("- a\n  - nested"), /<li>a<\/li>\n<li>nested<\/li>/);
});

test("renderJson: colours keys / strings / numbers / literals, escape-first per token (payload stays inert)", () => {
  const html = renderJson(JSON.stringify({ "k</b>": '<img src=x onerror=alert(1)>', n: 2.5, ok: true, z: null }));
  assert.match(html, /<span class="j-key">&quot;k&lt;\/b&gt;&quot;<\/span>:/);
  assert.match(html, /<span class="j-str">&quot;&lt;img src=x onerror=alert\(1\)&gt;&quot;<\/span>/);
  assert.match(html, /<span class="j-num">2\.5<\/span>/);
  assert.match(html, /<span class="j-num">true<\/span>/);
  assert.match(html, /<span class="j-num">null<\/span>/);
  assert.doesNotMatch(html, /<img|<\/b>/);
});

test("renderJson: a string containing an escaped quote is not cut early", () => {
  const html = renderJson(JSON.stringify({ a: 'say "hi" <x>' }));
  assert.match(html, /<span class="j-str">&quot;say \\&quot;hi\\&quot; &lt;x&gt;&quot;<\/span>/);
});
