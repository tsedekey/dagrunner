/**
 * render.ts — server-side rendering of an artifact's content into safe HTML
 * (the single escaping path for ALL artifact content — the client only ever
 * inserts this server-escaped HTML or text it escapes itself):
 * a hand-rolled markdown SUBSET (headings, lists, tables, blockquotes, code
 * fences, bold/italic, links), syntax-coloured JSON, and a unified diff with
 * +/- line glyphs and colouring.
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

    // Pipe table: a header row followed by a |---|---| separator row.
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      closeList();
      const cells = (r: string): string[] =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      let t = `<div class="md-table"><table><thead><tr>${cells(line)
        .map((c) => `<th>${inline(escapeHtml(c))}</th>`)
        .join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i] ?? "")) {
        t += `<tr>${cells(lines[i] ?? "")
          .map((c) => `<td>${inline(escapeHtml(c))}</td>`)
          .join("")}</tr>`;
        i++;
      }
      out.push(t + "</tbody></table></div>");
      continue;
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
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
    if (/^>\s?/.test(line)) {
      out.push(`<blockquote>${inline(escapeHtml(line.replace(/^>\s?/, "")))}</blockquote>`);
      i++;
      continue;
    }
    // A paragraph: consecutive plain lines are one block.
    const para = [line.trim()];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\||>)/.test(lines[i] ?? "")
    ) {
      para.push((lines[i] ?? "").trim());
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }
  closeList();
  return out.join("\n");
}

const JSON_TOKEN =
  /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/g;

/**
 * Pretty-printed, syntax-coloured JSON. Escape-first PER TOKEN: the pretty text
 * is split into tokens and gaps and each is escaped on its own, so no content
 * can reach the DOM unescaped. Invalid JSON renders as an escaped plain block.
 */
export function renderJson(text: string): string {
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return `<pre class="json json-invalid">${escapeHtml(text)}</pre>`;
  }
  let out = "";
  let last = 0;
  for (const m of pretty.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    out += escapeHtml(pretty.slice(last, at));
    const tok = m[0];
    if (m[1] !== undefined) {
      const key = tok.slice(0, tok.length - m[1].length);
      out += `<span class="j-key">${escapeHtml(key)}</span>${escapeHtml(m[1])}`;
    } else if (tok.startsWith('"')) {
      out += `<span class="j-str">${escapeHtml(tok)}</span>`;
    } else {
      out += `<span class="j-num">${escapeHtml(tok)}</span>`;
    }
    last = at + tok.length;
  }
  out += escapeHtml(pretty.slice(last));
  return `<pre class="json"><code>${out}</code></pre>`;
}

/**
 * A unified diff, line-coloured. No real diff algorithm needed — `changes.diff`
 * is already a diff (core/changes-diff.ts); this only classifies existing lines.
 */
export function renderDiff(diffText: string): string {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const rendered = lines.map((line) => {
    const kind =
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
        ? "meta"
        : line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "ctx";
    const glyph = { add: "+", del: "−", hunk: "@", meta: " ", ctx: " " }[kind];
    const body = escapeHtml(kind === "add" || kind === "del" ? line.slice(1) : line);
    const sr =
      kind === "add"
        ? '<span class="sr-only"> (added)</span>'
        : kind === "del"
          ? '<span class="sr-only"> (removed)</span>'
          : "";
    return `<span class="dl dl-${kind}"><span class="dg" aria-hidden="true">${glyph}</span>${body}${sr}</span>`;
  });
  return `<pre class="diff"><code>${rendered.join("\n")}</code></pre>`;
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
  if (kind === "markdown") return `<div class="md">${renderMarkdown(content)}</div>`;
  if (kind === "json") return renderJson(content);
  if (kind === "diff") return renderDiff(content);
  return `<pre class="text">${escapeHtml(content)}</pre>`;
}
