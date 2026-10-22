/**
 * transcript.ts — turn ONE line of a node's `transcript.log` into feed drafts.
 *
 * `sdk-runner.ts` appends every SDK message as compact JSON, one per line,
 * each line cut at 8 KB with a trailing `…}` — so a cut line is NOT valid JSON.
 * Real data shows the cut lines are overwhelmingly `user` tool results (skipped)
 * and `assistant` messages whose huge `thinking` signature eats the budget
 * before the `text`/`tool_use` blocks. Policy for a cut assistant line: salvage
 * whatever `text`/`tool_use` blocks survive in the prefix via regex (marked
 * `truncated`), and if nothing survives emit ONE honest note instead of dropping
 * the activity silently. `thinking` blocks and every other message type are
 * ignored. Pure: no fs, no clock.
 *
 * Timestamps: parsed `assistant`/`user` lines carry `timestamp` (ISO) — but AFTER
 * `message` in key order, so a cut line loses it (`ts: null`; the caller falls
 * back to the previous line's ts and flags the item approximate).
 */

export type TranscriptDraft = {
  kind: "text" | "tool";
  text: string;
  tool?: string;
  /** Salvaged from a cut (8 KB) line — summary may be incomplete. */
  truncated?: boolean;
};

export const TRUNCATED_NOTE = "(large message truncated in transcript.log)";

const CLIP = 220;
const clip = (s: string, n: number = CLIP): string => (s.length > n ? s.slice(0, n) + "…" : s);

function firstMeaningfulLine(s: string): string {
  for (const l of s.split("\n")) {
    const t = l.trim();
    if (t !== "") return clip(t);
  }
  return "";
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** One-line summary of a tool call's input, mirroring sdk-runner's `logProgress` (command / file_path basename / description) plus a few common fallbacks. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const i = input as Record<string, unknown>;
  const s = (k: string): string | null => (typeof i[k] === "string" && i[k] !== "" ? (i[k] as string) : null);
  const cmd = s("command");
  if (cmd !== null) return firstMeaningfulLine(cmd);
  const fp = s("file_path");
  if (fp !== null) return basename(fp);
  for (const k of ["description", "pattern", "query", "url", "prompt", "path"]) {
    const v = s(k);
    if (v !== null) return firstMeaningfulLine(v);
  }
  return "";
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown };

function draftsFromBlocks(content: unknown[]): TranscriptDraft[] {
  const out: TranscriptDraft[] = [];
  for (const raw of content) {
    const b = (typeof raw === "object" && raw !== null ? raw : {}) as Block;
    if (b.type === "text" && typeof b.text === "string") {
      const t = firstMeaningfulLine(b.text);
      if (t !== "") out.push({ kind: "text", text: t });
    } else if (b.type === "tool_use") {
      out.push({
        kind: "tool",
        tool: typeof b.name === "string" ? b.name : "tool",
        text: summarizeToolInput(b.input),
      });
    }
    // `thinking` and anything else: ignored by design.
  }
  return out;
}

/** Decode the body of a (possibly unterminated) JSON string literal; falls back to the raw text. */
function unescapeJsonFragment(s: string): string {
  let body = s;
  // An unterminated fragment may end mid-escape; drop a dangling backslash so JSON.parse can try.
  if (/(^|[^\\])(\\\\)*\\$/.test(body)) body = body.slice(0, -1);
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}

const STR = '((?:[^"\\\\]|\\\\.)*)';

function salvage(line: string): TranscriptDraft[] {
  const found: { at: number; draft: TranscriptDraft }[] = [];
  for (const m of line.matchAll(new RegExp(`"type":"text","text":"${STR}`, "g"))) {
    const t = firstMeaningfulLine(unescapeJsonFragment(m[1] ?? ""));
    if (t !== "") found.push({ at: m.index ?? 0, draft: { kind: "text", text: t, truncated: true } });
  }
  for (const m of line.matchAll(/"type":"tool_use"/g)) {
    const at = m.index ?? 0;
    const rest = line.slice(at, at + 4000);
    const name = /"name":"([^"]+)"/.exec(rest)?.[1];
    if (name === undefined) continue;
    let text = "";
    for (const k of ["command", "file_path", "description", "pattern", "query", "url", "prompt", "path"]) {
      const v = new RegExp(`"${k}":"${STR}`).exec(rest)?.[1];
      if (v !== undefined && v !== "") {
        const decoded = unescapeJsonFragment(v);
        text = k === "file_path" ? basename(decoded) : firstMeaningfulLine(decoded);
        break;
      }
    }
    found.push({ at, draft: { kind: "tool", tool: name, text, truncated: true } });
  }
  found.sort((a, b) => a.at - b.at);
  return found.map((f) => f.draft);
}

/** Parse one complete transcript line. Never throws. `ts` is the line's own timestamp, or null when absent (e.g. cut by the 8 KB cap). */
export function parseTranscriptLine(line: string): { ts: string | null; drafts: TranscriptDraft[] } {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    if (!line.startsWith('{"type":"assistant"')) return { ts: null, drafts: [] };
    const drafts = salvage(line);
    return {
      ts: null,
      drafts: drafts.length > 0 ? drafts : [{ kind: "text", text: TRUNCATED_NOTE, truncated: true }],
    };
  }
  if (typeof msg !== "object" || msg === null) return { ts: null, drafts: [] };
  const m = msg as { type?: unknown; timestamp?: unknown; message?: { content?: unknown }; data?: unknown };
  const ts = typeof m.timestamp === "string" ? m.timestamp : null;
  // Copilot runtime (copilot-runner.ts) writes SDK session events, not Claude messages:
  // `assistant.message` carries `data.content` (text) and `data.toolRequests`. Everything
  // else it logs (hooks, usage, subagent lifecycle, dagrun.permission) is ignored.
  if (m.type === "assistant.message") {
    const d = (typeof m.data === "object" && m.data !== null ? m.data : {}) as {
      content?: unknown;
      toolRequests?: unknown;
    };
    const blocks: Block[] = [];
    if (typeof d.content === "string" && d.content !== "") blocks.push({ type: "text", text: d.content });
    if (Array.isArray(d.toolRequests)) {
      for (const r of d.toolRequests as Array<{ name?: unknown; arguments?: unknown }>) {
        blocks.push({ type: "tool_use", name: r?.name, input: r?.arguments });
      }
    }
    return { ts, drafts: draftsFromBlocks(blocks) };
  }
  if (m.type !== "assistant") return { ts, drafts: [] };
  const content = m.message?.content;
  return { ts, drafts: Array.isArray(content) ? draftsFromBlocks(content) : [] };
}
