/**
 * intra-node.ts — Burn Monitor Deliverable 4a: intra-node attribution
 * (capture only, no report/UI rendering — that is D4b, a later deliverable).
 *
 * Populates burn.json's intraNode field by parsing the raw Claude Code
 * session JSONL (parent + subagent transcripts) that D1/D2's rollup
 * capture never reads. Grounded in the D3 feasibility spike (read-only,
 * no code shipped — see DECISIONS.md § burn-monitor-d3-spike) plus this
 * deliverable's own empirical re-verification against the same real run
 * (`53861-1`/`review`, sessionId d782ed81-1c91-405f-a6f9-b529ffd71973) —
 * see DECISIONS.md § burn-monitor-d4a-intra-node-capture for the corrected
 * dedup finding below.
 *
 * THE DEDUP LANDMINE (read this before touching sumUsageByModel):
 * Claude Code re-emits the SAME logical assistant turn as 3-4 separate
 * JSONL lines sharing one `message.id`, as the response streams and its
 * `content` array grows. The D3 spike's prose said these duplicates carry
 * "identical usage values" — true for input/cache tokens (fixed at
 * request time) but this deliverable found empirically that
 * `output_tokens` (and the `content` array's tool_use blocks) GROW across
 * duplicates as the stream progresses. Deduping by "first occurrence
 * wins" (a literal reading of the spike's prose) undercounted output
 * tokens by 30-60% against the trusted burn.json rollup in real data.
 * The correct rule, verified to reconcile exactly against the rollup
 * (input/cacheRead/cacheCreation delta = 0, output delta ~-5%/-13%,
 * matching the D3 spike's own cited numbers): **LAST occurrence per
 * message.id wins** — take the final, most-complete cumulative snapshot,
 * never sum every record and never take the first. This applies to BOTH
 * usage AND tool_use content-block counting (a duplicate's later line can
 * carry additional tool_use blocks appended to the same growing message).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { modelIdToTier, type Tier, type BurnModelEntry } from "./burn.js";

// ---------------------------------------------------------------------------
// Types — intraNode schema
// ---------------------------------------------------------------------------

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type IntraNodeSubagent = {
  agentId: string;
  agentType: string;
  tier: Tier;
  tokens: UsageTotals;
  apportionedCostUsd: number;
};

export type VerboseToolOutput = {
  toolUseId: string;
  toolName: string;
  sizeKb: number;
};

export type ReconciliationField = { delta: number; deltaPct: number };

export type ModelReconciliation = {
  inputTokens: ReconciliationField;
  outputTokens: ReconciliationField;
  cacheReadInputTokens: ReconciliationField;
  cacheCreationInputTokens: ReconciliationField;
};

export type IntraNodeData = {
  subagents: IntraNodeSubagent[];
  toolCallCounts: Record<string, number>;
  retryCount: number;
  verboseToolOutputs: VerboseToolOutput[];
  reconciliation: Record<string, ModelReconciliation>;
};

// ---------------------------------------------------------------------------
// Raw JSONL record parsing (pure — operates on already-JSON.parse'd values,
// never touches fs). The impure fs layer is further down this file.
// ---------------------------------------------------------------------------

type RawJson = Record<string, unknown>;

function isRecord(v: unknown): v is RawJson {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOr0(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export type ToolUseBlock = { id: string; name: string };

/** One assistant turn as parsed off a single JSONL line — NOT yet deduped.
 * A single logical turn produces multiple of these sharing `messageId`. */
export type AssistantRecord = {
  messageId: string;
  model: string;
  usage: UsageTotals;
  toolUses: ToolUseBlock[];
};

/** Parse raw (already JSON.parse'd) JSONL records into AssistantRecord[].
 * Skips anything that isn't a well-formed `type: "assistant"` record —
 * never throws on malformed/partial lines. Order-preserving, NOT deduped
 * (see dedupAssistantRecordsByMessageId — callers must dedup before
 * summing anything derived from these). */
export function extractAssistantRecords(records: unknown[]): AssistantRecord[] {
  const out: AssistantRecord[] = [];
  for (const r of records) {
    if (!isRecord(r) || r["type"] !== "assistant") continue;
    const message = r["message"];
    if (!isRecord(message)) continue;
    const messageId = message["id"];
    const model = message["model"];
    const usage = message["usage"];
    if (typeof messageId !== "string" || typeof model !== "string") continue;
    if (!isRecord(usage)) continue;

    const content = message["content"];
    const toolUses: ToolUseBlock[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (
          block["type"] === "tool_use" &&
          typeof block["id"] === "string" &&
          typeof block["name"] === "string"
        ) {
          toolUses.push({ id: block["id"], name: block["name"] });
        }
      }
    }

    out.push({
      messageId,
      model,
      usage: {
        inputTokens: numOr0(usage["input_tokens"]),
        outputTokens: numOr0(usage["output_tokens"]),
        cacheReadInputTokens: numOr0(usage["cache_read_input_tokens"]),
        cacheCreationInputTokens: numOr0(usage["cache_creation_input_tokens"]),
      },
      toolUses,
    });
  }
  return out;
}

/** THE dedup rule (see module header). Keeps the LAST record seen for each
 * distinct `messageId` — the final, most-complete cumulative snapshot of a
 * streamed turn — discarding earlier partial duplicates. Preserves
 * first-seen order for the (now-unique) output list, so downstream
 * ordering (e.g. tool-call sequencing) stays stable. */
export function dedupAssistantRecordsByMessageId(
  records: AssistantRecord[],
): AssistantRecord[] {
  const order: string[] = [];
  const latest = new Map<string, AssistantRecord>();
  for (const rec of records) {
    if (!latest.has(rec.messageId)) order.push(rec.messageId);
    latest.set(rec.messageId, rec); // overwrite — last wins
  }
  return order.map((id) => latest.get(id)!);
}

/** Sum usage per model id across an ALREADY-DEDUPED record list. Summing a
 * non-deduped list here would reproduce the 3-4x overcounting landmine. */
export function sumUsageByModel(
  dedupedRecords: AssistantRecord[],
): Record<string, UsageTotals> {
  const totals: Record<string, UsageTotals> = {};
  for (const rec of dedupedRecords) {
    const bucket = (totals[rec.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    bucket.inputTokens += rec.usage.inputTokens;
    bucket.outputTokens += rec.usage.outputTokens;
    bucket.cacheReadInputTokens += rec.usage.cacheReadInputTokens;
    bucket.cacheCreationInputTokens += rec.usage.cacheCreationInputTokens;
  }
  return totals;
}

/** Count tool_use blocks by tool name across an ALREADY-DEDUPED record
 * list. Must run on deduped records — a duplicate line can carry MORE
 * tool_use blocks than an earlier duplicate of the same message (the
 * content array grows mid-stream), so counting off the raw (non-deduped)
 * list double-counts tool calls, not just tokens. */
export function sumToolUseCounts(
  dedupedRecords: AssistantRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rec of dedupedRecords) {
    for (const tu of rec.toolUses) {
      counts[tu.name] = (counts[tu.name] ?? 0) + 1;
    }
  }
  return counts;
}

/** tool_use_id -> tool name, from an already-deduped record list. Used to
 * resolve the tool name for a `tool_result` marker (which carries the id
 * but not the name) further down this file. */
export function buildToolUseIdToNameMap(
  dedupedRecords: AssistantRecord[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rec of dedupedRecords) {
    for (const tu of rec.toolUses) {
      map[tu.id] = tu.name;
    }
  }
  return map;
}

/** Count retry records: `type: "system"`, carrying a numeric
 * `retryAttempt` (confirmed shape against real data — see
 * DECISIONS.md § burn-monitor-d4a-intra-node-capture). Not deduped —
 * retry records are not observed to repeat via the streaming-duplicate
 * mechanism above; each is a genuine distinct retry event. */
export function extractRetryCount(records: unknown[]): number {
  let count = 0;
  for (const r of records) {
    if (isRecord(r) && typeof r["retryAttempt"] === "number") count++;
  }
  return count;
}

const VERBOSE_MARKER_RE =
  /Output too large \(([\d.]+)\s*KB\)\.\s*Full output saved to:\s*(\S+)/i;

/** Flag any tool_result whose content was externalized by Claude Code
 * itself (own size threshold already applied — this function does not
 * invent a second one). Dedups by toolUseId (last wins) — same
 * defensive posture as message.id dedup, in case a result marker line
 * repeats. `toolNameById` resolves the tool name; unresolvable ids
 * (parent map didn't see the originating tool_use, e.g. cross-file
 * linkage) render with toolName "unknown" rather than being dropped. */
export function extractVerboseToolOutputs(
  records: unknown[],
  toolNameById: Record<string, string>,
): VerboseToolOutput[] {
  const byId = new Map<string, VerboseToolOutput>();
  for (const r of records) {
    if (!isRecord(r) || r["type"] !== "user") continue;
    const message = r["message"];
    if (!isRecord(message)) continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_result") continue;
      const toolUseId = block["tool_use_id"];
      if (typeof toolUseId !== "string") continue;
      const c = block["content"];
      const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
      const m = VERBOSE_MARKER_RE.exec(text);
      if (m === null) continue;
      byId.set(toolUseId, {
        toolUseId,
        toolName: toolNameById[toolUseId] ?? "unknown",
        sizeKb: Number(m[1]),
      });
    }
  }
  return Array.from(byId.values());
}

/** Merge two tool-name -> count maps by summing shared keys. */
export function mergeToolCallCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [name, count] of Object.entries(b)) {
    merged[name] = (merged[name] ?? 0) + count;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Cost apportioning — pure, proportional token-weighted split
// ---------------------------------------------------------------------------

/** Split rollupCostUsd across parties proportional to their token counts
 * (partyTokens). Guarantees the split sums EXACTLY back to rollupCostUsd
 * (the last party absorbs the rounding remainder rather than each party
 * carrying independent floating-point drift) — proportionality holds for
 * every party except (marginally) the last. Zero total tokens across all
 * parties degrades to "the last party gets everything, everyone else
 * gets 0" rather than a NaN from a 0/0 division. Empty partyTokens
 * returns {}. */
export function apportionCost(
  rollupCostUsd: number,
  partyTokens: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(partyTokens);
  if (keys.length === 0) return {};
  const totalTokens = keys.reduce((s, k) => s + partyTokens[k]!, 0);

  const result: Record<string, number> = {};
  let assigned = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const share =
      totalTokens === 0 ? 0 : (partyTokens[k]! / totalTokens) * rollupCostUsd;
    result[k] = share;
    assigned += share;
  }
  const lastKey = keys[keys.length - 1]!;
  result[lastKey] = rollupCostUsd - assigned;
  return result;
}

// ---------------------------------------------------------------------------
// Reconciliation — compare intra-node sums against the trusted rollup
// ---------------------------------------------------------------------------

const RECONCILE_FIELDS: Array<keyof UsageTotals> = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
];

function reconcileField(
  intraValue: number,
  rollupValue: number,
): ReconciliationField {
  const delta = intraValue - rollupValue;
  const deltaPct = rollupValue === 0 ? 0 : delta / rollupValue;
  return { delta, deltaPct };
}

/** Per-model reconciliation of the intra-node token sums (parent +
 * subagents, already deduped/summed) against burn.json's own trusted
 * rollup `models[]` entries for the SAME node execution. Always populates
 * an entry for every rollup model id, even when intraNodeTotals has no
 * data for it (treated as all-zero) — never omits a rollup model. This
 * is deliberately observational (never a pass/fail gate) — see module
 * header and DECISIONS.md § burn-monitor-d4a-intra-node-capture for the
 * known ~5-13% output-token baseline this reproduces. */
export function computeReconciliation(
  intraNodeTotalsByModel: Record<string, UsageTotals>,
  rollupModels: BurnModelEntry[],
): Record<string, ModelReconciliation> {
  const result: Record<string, ModelReconciliation> = {};
  for (const rollupEntry of rollupModels) {
    const intra = intraNodeTotalsByModel[rollupEntry.model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    result[rollupEntry.model] = {
      inputTokens: reconcileField(intra.inputTokens, rollupEntry.inputTokens),
      outputTokens: reconcileField(
        intra.outputTokens,
        rollupEntry.outputTokens,
      ),
      cacheReadInputTokens: reconcileField(
        intra.cacheReadInputTokens,
        rollupEntry.cacheReadInputTokens,
      ),
      cacheCreationInputTokens: reconcileField(
        intra.cacheCreationInputTokens,
        rollupEntry.cacheCreationInputTokens,
      ),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Attribution composition — parent + subagents -> subagent entries +
// reconciliation. Pure: takes already-summed per-party, per-model usage
// maps (fs parsing happens in computeIntraNode below).
// ---------------------------------------------------------------------------

function tokenTotal(u: UsageTotals): number {
  return (
    u.inputTokens +
    u.outputTokens +
    u.cacheReadInputTokens +
    u.cacheCreationInputTokens
  );
}

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export type SubagentUsageInput = {
  agentId: string;
  agentType: string;
  usageByModel: Record<string, UsageTotals>;
};

export type ComputeIntraNodeAttributionParams = {
  parentUsageByModel: Record<string, UsageTotals>;
  subagents: SubagentUsageInput[];
  rollupModels: BurnModelEntry[];
};

export type ComputeIntraNodeAttributionResult = {
  subagentEntries: IntraNodeSubagent[];
  reconciliation: Record<string, ModelReconciliation>;
};

/** Given parent + each subagent's per-model token sums, apportion each
 * rollup model's costUSD proportionally across whichever parties (parent
 * and/or subagents) actually used that model, weighted by total token
 * count on that model (input+output+cacheRead+cacheCreation) — see
 * apportionCost. A subagent that used more than one model (not observed
 * in practice, but not assumed impossible) gets its tokens merged across
 * models and its apportioned cost summed across models; its reported
 * `tier` is the dominant model's tier (max tokens on that model). Also
 * computes the combined (parent + all subagents) per-model reconciliation
 * against the rollup. */
export function computeIntraNodeAttribution(
  params: ComputeIntraNodeAttributionParams,
): ComputeIntraNodeAttributionResult {
  const { parentUsageByModel, subagents, rollupModels } = params;

  // combined intra-node totals per model, for reconciliation.
  const combinedByModel: Record<string, UsageTotals> = {};
  for (const [model, usage] of Object.entries(parentUsageByModel)) {
    combinedByModel[model] = addUsage(
      combinedByModel[model] ?? ZERO_USAGE,
      usage,
    );
  }
  for (const sub of subagents) {
    for (const [model, usage] of Object.entries(sub.usageByModel)) {
      combinedByModel[model] = addUsage(
        combinedByModel[model] ?? ZERO_USAGE,
        usage,
      );
    }
  }

  // apportioned cost per model per party ("parent" | subagent's agentId).
  const apportionedByModel: Record<string, Record<string, number>> = {};
  for (const rollupEntry of rollupModels) {
    const model = rollupEntry.model;
    const partyTokens: Record<string, number> = {
      parent: tokenTotal(parentUsageByModel[model] ?? ZERO_USAGE),
    };
    for (const sub of subagents) {
      const usage = sub.usageByModel[model];
      if (usage !== undefined && tokenTotal(usage) > 0) {
        partyTokens[sub.agentId] = tokenTotal(usage);
      }
    }
    apportionedByModel[model] = apportionCost(rollupEntry.costUSD, partyTokens);
  }

  const subagentEntries: IntraNodeSubagent[] = subagents.map((sub) => {
    let tokens: UsageTotals = ZERO_USAGE;
    let apportionedCostUsd = 0;
    let dominantModel: string | undefined;
    let dominantTokens = -1;
    for (const [model, usage] of Object.entries(sub.usageByModel)) {
      tokens = addUsage(tokens, usage);
      apportionedCostUsd += apportionedByModel[model]?.[sub.agentId] ?? 0;
      const total = tokenTotal(usage);
      if (total > dominantTokens) {
        dominantTokens = total;
        dominantModel = model;
      }
    }
    return {
      agentId: sub.agentId,
      agentType: sub.agentType,
      tier:
        dominantModel !== undefined ? modelIdToTier(dominantModel) : "unknown",
      tokens,
      apportionedCostUsd,
    };
  });

  const reconciliation = computeReconciliation(combinedByModel, rollupModels);

  return { subagentEntries, reconciliation };
}

// ---------------------------------------------------------------------------
// fs integration layer — locates + reads the raw session JSONL and
// subagent files. Impure. Never called from unit tests against the real
// ~/.claude home; sdk-runner.ts calls this wrapped in its own independent
// try/catch (a failure here must never block a node's result — see
// module header and sdk-runner.ts's call site).
// ---------------------------------------------------------------------------

/** Locate `<claudeConfigDir>/projects/*\/<sessionId>.jsonl` by scanning
 * project directories for a file named after the sessionId — deliberately
 * NOT reconstructing Claude Code's own cwd-to-directory-name sanitization
 * scheme (see D3 spike, DECISIONS.md § burn-monitor-d3-spike). Returns
 * null (not found) rather than throwing — "not found" is an expected,
 * common degrade path (predates this feature, config dir mismatch, etc). */
export function locateSessionJsonlPath(
  claudeConfigDir: string,
  sessionId: string,
): string | null {
  const projectsDir = join(claudeConfigDir, "projects");
  if (!existsSync(projectsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const dir of entries) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Read a JSONL file into an array of JSON.parse'd values, skipping
 * blank and unparseable lines rather than throwing — one corrupt line
 * must never prevent parsing the rest of the file. */
export function readJsonlRecords(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line — never let one bad line abort the whole parse.
    }
  }
  return out;
}

type SubagentMeta = {
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
};

function parseSubagentMeta(raw: unknown): SubagentMeta | null {
  if (!isRecord(raw) || typeof raw["agentType"] !== "string") return null;
  return {
    agentType: raw["agentType"],
    description:
      typeof raw["description"] === "string" ? raw["description"] : "",
    toolUseId: typeof raw["toolUseId"] === "string" ? raw["toolUseId"] : "",
    spawnDepth: typeof raw["spawnDepth"] === "number" ? raw["spawnDepth"] : 0,
  };
}

/** Summarize one already-read set of raw JSONL records (parent or a
 * single subagent file) into usage-by-model, tool-call counts, retry
 * count and verbose-tool-output flags — the full per-file pipeline
 * (parse -> dedup -> sum), reused identically for the parent transcript
 * and every subagent transcript. */
function summarizeTranscript(rawRecords: unknown[]): {
  usageByModel: Record<string, UsageTotals>;
  toolCallCounts: Record<string, number>;
  retryCount: number;
  verboseToolOutputs: VerboseToolOutput[];
} {
  const deduped = dedupAssistantRecordsByMessageId(
    extractAssistantRecords(rawRecords),
  );
  const toolNameById = buildToolUseIdToNameMap(deduped);
  return {
    usageByModel: sumUsageByModel(deduped),
    toolCallCounts: sumToolUseCounts(deduped),
    retryCount: extractRetryCount(rawRecords),
    verboseToolOutputs: extractVerboseToolOutputs(rawRecords, toolNameById),
  };
}

export type ComputeIntraNodeParams = {
  claudeConfigDir: string;
  sessionId: string;
  rollupModels: BurnModelEntry[];
};

/** Top-level orchestrator: locate the session JSONL, parse parent +
 * subagent transcripts, and produce the full IntraNodeData. Returns null
 * (never throws for the "not found" case) when the session JSONL can't
 * be located — the caller (sdk-runner.ts) treats null identically to any
 * other enrichment failure: intraNode stays null, phase stays "rollup".
 * Genuinely unexpected errors (fs permission errors, etc past the
 * not-found case) DO propagate — sdk-runner.ts's own independent
 * try/catch around this call is the fail-soft boundary, matching the
 * existing friction.jsonl/burn.json write pattern. */
export function computeIntraNode(
  params: ComputeIntraNodeParams,
): IntraNodeData | null {
  const { claudeConfigDir, sessionId, rollupModels } = params;
  if (sessionId === "") return null;

  const sessionJsonlPath = locateSessionJsonlPath(claudeConfigDir, sessionId);
  if (sessionJsonlPath === null) return null;

  const parentRaw = readJsonlRecords(sessionJsonlPath);
  const parentSummary = summarizeTranscript(parentRaw);

  let combinedToolCounts = parentSummary.toolCallCounts;
  let combinedRetryCount = parentSummary.retryCount;
  const verboseById = new Map<string, VerboseToolOutput>();
  for (const v of parentSummary.verboseToolOutputs) {
    verboseById.set(v.toolUseId, v);
  }

  const sessionDir = dirname(sessionJsonlPath);
  const subagentsDir = join(sessionDir, sessionId, "subagents");

  const subagents: SubagentUsageInput[] = [];

  if (existsSync(subagentsDir)) {
    const metaFiles = readdirSync(subagentsDir).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const metaFile of metaFiles) {
      const agentId = metaFile.slice(
        "agent-".length,
        metaFile.length - ".meta.json".length,
      );
      let meta: SubagentMeta | null = null;
      try {
        meta = parseSubagentMeta(
          JSON.parse(readFileSync(join(subagentsDir, metaFile), "utf8")),
        );
      } catch {
        meta = null;
      }
      if (meta === null) continue;

      const jsonlFile = join(subagentsDir, `agent-${agentId}.jsonl`);
      if (!existsSync(jsonlFile)) continue;

      const subRaw = readJsonlRecords(jsonlFile);
      const subSummary = summarizeTranscript(subRaw);

      combinedToolCounts = mergeToolCallCounts(
        combinedToolCounts,
        subSummary.toolCallCounts,
      );
      combinedRetryCount += subSummary.retryCount;
      for (const v of subSummary.verboseToolOutputs) {
        verboseById.set(v.toolUseId, v);
      }

      subagents.push({
        agentId,
        agentType: meta.agentType,
        usageByModel: subSummary.usageByModel,
      });
    }
  }

  const { subagentEntries, reconciliation } = computeIntraNodeAttribution({
    parentUsageByModel: parentSummary.usageByModel,
    subagents,
    rollupModels,
  });

  return {
    subagents: subagentEntries,
    toolCallCounts: combinedToolCounts,
    retryCount: combinedRetryCount,
    verboseToolOutputs: Array.from(verboseById.values()),
    reconciliation,
  };
}

// Exported for tests that assert against RECONCILE_FIELDS coverage.
export { RECONCILE_FIELDS };
