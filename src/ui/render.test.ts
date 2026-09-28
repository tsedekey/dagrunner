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
  assert.match(html, /&quot;a&quot;: 1/);
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
  assert.match(html, /<span class="diff-meta">diff --git/);
  assert.match(html, /<span class="diff-file">--- a\/x\.ts<\/span>/);
  assert.match(html, /<span class="diff-file">\+\+\+ b\/x\.ts<\/span>/);
  assert.match(html, /<span class="diff-hunk">@@ -1,2 \+1,2 @@<\/span>/);
  assert.match(html, /<span class="diff-del">-old line<\/span>/);
  assert.match(html, /<span class="diff-add">\+new line<\/span>/);
  assert.match(html, /<span class="diff-ctx"> unchanged<\/span>/);
});

test("renderDiff escapes HTML-significant characters inside lines", () => {
  const html = renderDiff("+<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("artifactKindFor dispatches by extension", () => {
  assert.equal(artifactKindFor("summary.md"), "markdown");
  assert.equal(artifactKindFor("verify-report.json"), "json");
  assert.equal(artifactKindFor("changes.diff"), "diff");
  assert.equal(artifactKindFor("transcript.log"), "text");
});

test("renderArtifact dispatches to the right renderer by path", () => {
  assert.match(renderArtifact("a.md", "# hi"), /<h1>hi<\/h1>/);
  assert.match(renderArtifact("a.json", "{}"), /<pre class="json">/);
  assert.match(renderArtifact("a.diff", "+x"), /diff-add/);
  assert.match(
    renderArtifact("a.log", "plain"),
    /<pre class="text">plain<\/pre>/,
  );
});
