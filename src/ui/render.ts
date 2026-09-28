/**
 * render.ts — server-side rendering of an artifact's content into safe HTML:
 * a hand-rolled markdown SUBSET (headings, lists, code fences, bold/italic,
 * links), pretty-printed JSON, and a unified diff with +/- line colouring.
 *
 * Zero deps by design (CLAUDE.md's "no new dependencies" law) — this is a
 * viewer, not a full renderer. Every renderer escapes raw text FIRST, then
 * applies markup, so content never injects HTML/script into the page. Links
 * are restricted to http(s) and relative hrefs — never `javascript:` etc.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(href: string): string {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed) || /^[.#/]/.test(trimmed))
    return escapeHtml(trimmed);
  return "#"; // refuses javascript:, data:, vbscript:, etc.
}

/** Inline markup within an already-escaped line: **bold**, *italic*, `code`, [text](href). */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, text: string, href: string) =>
        `<a href="${safeHref(href)}">${text}</a>`,
    );
}

/**
 * A modest markdown subset: ATX headings (#..######), fenced code blocks
 * (```lang), unordered (-/*) and ordered (1.) lists, bold/italic/inline-code,
 * links, and paragraphs. Anything else renders as a plain escaped paragraph
 * line — never throws, never drops content.
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let listTag: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listTag !== null) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block.
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence !== null) {
      closeList();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence (or EOF — unterminated fence still renders what we have)
      const cls = lang !== "" ? ` class="lang-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      closeList();
      const level = (heading[1] ?? "#").length;
      out.push(
        `<h${level}>${inline(escapeHtml(heading[2] ?? ""))}</h${level}>`,
      );
      i++;
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul !== null || ol !== null) {
      const wantTag = ul !== null ? "ul" : "ol";
      if (listTag !== wantTag) {
        closeList();
        out.push(`<${wantTag}>`);
        listTag = wantTag;
      }
      const item = ul !== null ? ul[1] : ol?.[1];
      out.push(`<li>${inline(escapeHtml(item ?? ""))}</li>`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    closeList();
    out.push(`<p>${inline(escapeHtml(line))}</p>`);
    i++;
  }
  closeList();
  return out.join("\n");
}

/** Pretty-printed, escaped JSON. Invalid JSON renders as an escaped plain block rather than throwing. */
export function renderJson(text: string): string {
  try {
    const pretty = JSON.stringify(JSON.parse(text), null, 2);
    return `<pre class="json">${escapeHtml(pretty)}</pre>`;
  } catch {
    return `<pre class="json json-invalid">${escapeHtml(text)}</pre>`;
  }
}

/**
 * A unified diff, line-coloured. No real diff algorithm needed — `changes.diff`
 * is already a diff (core/changes-diff.ts); this only classifies existing lines.
 */
export function renderDiff(diffText: string): string {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const rendered = lines.map((line) => {
    const esc = escapeHtml(line);
    if (line.startsWith("+++") || line.startsWith("---"))
      return `<span class="diff-file">${esc}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${esc}</span>`;
    if (line.startsWith("+")) return `<span class="diff-add">${esc}</span>`;
    if (line.startsWith("-")) return `<span class="diff-del">${esc}</span>`;
    if (line.startsWith("diff --git") || line.startsWith("index "))
      return `<span class="diff-meta">${esc}</span>`;
    return `<span class="diff-ctx">${esc}</span>`;
  });
  return `<pre class="diff">${rendered.join("\n")}</pre>`;
}

export type ArtifactKind = "markdown" | "json" | "diff" | "text";

export function artifactKindFor(path: string): ArtifactKind {
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".diff") || path.endsWith(".patch")) return "diff";
  return "text";
}

/** Render an artifact's raw text content by its kind (see `artifactKindFor`). */
export function renderArtifact(path: string, content: string): string {
  const kind = artifactKindFor(path);
  if (kind === "markdown") return renderMarkdown(content);
  if (kind === "json") return renderJson(content);
  if (kind === "diff") return renderDiff(content);
  return `<pre class="text">${escapeHtml(content)}</pre>`;
}
