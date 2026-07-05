/**
 * burn.ts — pure derivation functions for the per-node burn.json artifact.
 *
 * Captures the per-model token/cost breakdown the SDK's terminal `result`
 * message already carries (msg.modelUsage: Record<string, ModelUsage>) but
 * that dagrunner previously discarded, keeping only the aggregate costUsd.
 *
 * Deliberately kept separate from sdk-runner.ts so the derivation logic
 * (tier bucketing, cache-cold ratio, malformed-input handling) is unit-
 * testable in isolation from the SDK message loop. sdk-runner.ts calls
 * buildBurn() once per node, at the same write-site as friction.jsonl.
 *
 * v1 scope (D1/D2): phase is always "rollup", intraNode is always null.
 *
 * D4a (intra-node attribution capture, see src/runtime/intra-node.ts)
 * extends this: when sdk-runner.ts successfully parses the raw session
 * JSONL, it overwrites the written burn.json with phase: "transcript" and
 * a populated intraNode. When parsing isn't attempted or fails, phase
 * stays "rollup" and intraNode stays null — this module's own buildBurn()
 * always produces the rollup shape; enrichment is a later, independent
 * step, never inline here (see BurnDocOk's widened phase/intraNode types
 * below, and isBurnDocOk()).
 */

import type { IntraNodeData } from "./intra-node.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the SDK's exported ModelUsage type (sdk.d.ts). Duplicated here
 * (not imported) because the SDK does not export it from a stable subpath
 * dagrunner depends on elsewhere; the shape is small and stable — see
 * DECISIONS.md § burn-modelusage-shape-duplicated. */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
};

export type Tier = "opus" | "sonnet" | "haiku" | "unknown";

export type TierMix = Record<Tier, number>;

export type BurnModelEntry = ModelUsage & { model: string };

export type BurnDerived = {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheColdRatio: number;
  outputTokens: number;
  tierMix: TierMix;
};

export type BurnDocOk = {
  node: string;
  sessionId: string;
  costUsd: number;
  schemaVersion: 1;
  // "rollup": D1/D2 shape, intraNode always null (the only shape this
  // module's own buildBurn() ever produces). "transcript": D4a enriched
  // this doc in-place after buildBurn() ran — see src/runtime/intra-node.ts
  // and sdk-runner.ts's independent enrichment try/catch.
  phase: "rollup" | "transcript";
  models: BurnModelEntry[];
  derived: BurnDerived;
  intraNode: IntraNodeData | null;
};

export type BurnDocError = {
  node: string;
  sessionId: string;
  schemaVersion: 1;
  error: string;
};

export type BurnDoc = BurnDocOk | BurnDocError;

/** Type guard narrowing BurnDoc -> BurnDocOk. Reused by sdk-runner.ts's
 * D4a enrichment step to decide whether a just-built doc is eligible for
 * intra-node enrichment (an error-marker doc never is). Matches the same
 * `!("error" in d)` narrowing report.ts already uses inline. */
export function isBurnDocOk(doc: BurnDoc): doc is BurnDocOk {
  return !("error" in doc);
}

// ---------------------------------------------------------------------------
// Model id -> tier inversion
// ---------------------------------------------------------------------------

/** Classify a model id string to its dagrunner tier via case-insensitive
 * substring match ("opus"/"sonnet"/"haiku"), NOT an exact-string map.
 *
 * D1 shipped an exact-match inversion of sdk-runner.ts's tier->id map
 * (claude-haiku-4-5-20251001 / claude-sonnet-5 / claude-opus-4-8 only).
 * That missed a real, observed case: the `review` node (declared tier
 * opus) fans out to reviewer subagents pinned to `claude-sonnet-4-6` via
 * payload/agents/*.md frontmatter — a model id dagrunner itself never
 * pins to, so it fell into "unknown" instead of "sonnet". Substring
 * matching classifies any current or future dated/aliased model id
 * correctly without dagrunner needing to enumerate every id Anthropic
 * ships. See DECISIONS.md § burn-monitor-d2-hotspots.
 *
 * Also doubles as the declared-tier classifier for NodeState.model,
 * which in practice holds either a short tier alias ("sonnet", used by
 * fixtures/tests) or the full pinned model id ("claude-sonnet-5", set by
 * run-engine.ts's makeInitialNodeStates) — substring matching handles
 * both forms with the same function, no separate parser needed. */
export function modelIdToTier(modelId: string): Tier {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/** cacheColdRatio = cacheCreation / (cacheCreation + cacheRead).
 * Guards the 0/0 case (no cache activity at all) by defining it as 0
 * rather than NaN. */
export function cacheColdRatio(
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const denom = cacheCreationTokens + cacheReadTokens;
  return denom === 0 ? 0 : cacheCreationTokens / denom;
}

/** Bucket a modelUsage map into per-tier token totals. Sums
 * inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens
 * per model, then adds into the model's tier bucket. Model ids that don't
 * match a known tier land in "unknown" (never dropped). */
export function computeTierMix(
  modelUsage: Record<string, ModelUsage>,
): TierMix {
  const mix: TierMix = { opus: 0, sonnet: 0, haiku: 0, unknown: 0 };
  for (const [modelId, usage] of Object.entries(modelUsage)) {
    const tier = modelIdToTier(modelId);
    const total =
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens;
    mix[tier] += total;
  }
  return mix;
}

// ---------------------------------------------------------------------------
// Validation — is the SDK's modelUsage value usable?
// ---------------------------------------------------------------------------

const REQUIRED_NUMERIC_FIELDS: Array<keyof ModelUsage> = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
  "costUSD",
  "contextWindow",
  "maxOutputTokens",
];

function isModelUsageShaped(v: unknown): v is ModelUsage {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  return REQUIRED_NUMERIC_FIELDS.every((f) => typeof rec[f] === "number");
}

/** Type guard: is `v` a non-empty, well-formed Record<string, ModelUsage>?
 * Rejects undefined, null, non-objects, arrays, empty objects, and objects
 * whose values don't match the ModelUsage shape — every one of these is
 * treated as "modelUsage missing" (fail loud, no silent zeroing). */
export function isValidModelUsageMap(
  v: unknown,
): v is Record<string, ModelUsage> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([, usage]) => isModelUsageShaped(usage));
}

// ---------------------------------------------------------------------------
// buildBurn — total function, always returns a BurnDoc (never throws)
// ---------------------------------------------------------------------------

export type BuildBurnParams = {
  node: string;
  sessionId: string;
  costUsd: number;
  modelUsage: unknown;
};

/** Build the burn.json document for one node execution. Total: always
 * returns a BurnDoc, never throws. When modelUsage is missing, empty, or
 * malformed, returns an explicit error-marker doc instead of a silently
 * zeroed derived block — callers must write this marker to disk unchanged,
 * not substitute a zeroed-out "ok" shape. */
export function buildBurn(params: BuildBurnParams): BurnDoc {
  const { node, sessionId, costUsd, modelUsage } = params;

  if (!isValidModelUsageMap(modelUsage)) {
    return {
      node,
      sessionId,
      schemaVersion: 1,
      error: "modelUsage missing from SDK result",
    };
  }

  const models: BurnModelEntry[] = Object.entries(modelUsage).map(
    ([model, usage]) => ({ model, ...usage }),
  );

  const cacheReadTokens = models.reduce(
    (sum, m) => sum + m.cacheReadInputTokens,
    0,
  );
  const cacheCreationTokens = models.reduce(
    (sum, m) => sum + m.cacheCreationInputTokens,
    0,
  );
  const outputTokens = models.reduce((sum, m) => sum + m.outputTokens, 0);

  return {
    node,
    sessionId,
    costUsd,
    schemaVersion: 1,
    phase: "rollup",
    models,
    derived: {
      cacheReadTokens,
      cacheCreationTokens,
      cacheColdRatio: cacheColdRatio(cacheCreationTokens, cacheReadTokens),
      outputTokens,
      tierMix: computeTierMix(modelUsage),
    },
    intraNode: null,
  };
}

// ---------------------------------------------------------------------------
// Hotspot detection (Deliverable 2 — report rendering; extended by D4b with
// two transcript-derived checks)
//
// The first four checks (cold-reload-tax, tier-leak, fat-fixed-prefix,
// output-heavy) are rollup-level only: they read a node's already-computed
// BurnDerived + the run-wide set of BurnDocOk docs, no transcript parsing.
// D4b (verbose-tool-output, fan-out-multiplier) additionally reads a
// node's `intraNode` (populated only for "transcript"-phase nodes, D4a) —
// both degrade to "no flag" on a null intraNode, so a rollup-only node's
// flag list is unaffected by their addition.
//
// Thresholds below are explicitly provisional constants, not a config
// system (out of scope per the D2 brief, and unchanged for D4b) — they
// will be tuned from real burn.json evidence once a body of real runs
// exists to calibrate against. See DECISIONS.md § burn-monitor-d2-hotspots
// and § burn-monitor-d4b-report-rendering.
// ---------------------------------------------------------------------------

export type HotspotFlag =
  | { kind: "cold-reload-tax"; cacheColdRatio: number }
  | { kind: "tier-leak"; declaredTier: Tier; leakedTiers: Tier[] }
  | { kind: "fat-fixed-prefix"; cacheCreationTokens: number }
  | { kind: "output-heavy"; outputShare: number }
  | { kind: "verbose-tool-output"; count: number; totalKb: number }
  | {
      kind: "fan-out-multiplier";
      qualifyingCount: number;
      totalCacheReadTokens: number;
    };

/** Above this cacheColdRatio, a node is re-paying its fixed prompt prefix
 * on (almost) every turn instead of hitting cache. Provisional — see
 * module header. */
export const COLD_RELOAD_TAX_THRESHOLD = 0.5;

/** Above this outputTokens/nodeTotal share, a node is generating far more
 * than it's reading — a candidate for a cheaper/shorter-output model or
 * prompt trim. Provisional — see module header. */
export const OUTPUT_HEAVY_SHARE_THRESHOLD = 0.4;

/** Above this many cache-creation tokens, a node's fixed prompt prefix is
 * "fat" in isolation. Only becomes a run-level flag when it also recurs
 * across FAT_PREFIX_NODE_COVERAGE of nodes (see below) — a single node's
 * necessarily-large context isn't itself a hotspot; a prefix that's fat
 * on nearly every node usually is. Provisional — see module header. */
export const FAT_PREFIX_TOKEN_THRESHOLD = 50_000;

/** Fraction of nodes-with-valid-burn-data that must exceed
 * FAT_PREFIX_TOKEN_THRESHOLD for the fat-fixed-prefix flag to fire on any
 * of them. Provisional — see module header. */
export const FAT_PREFIX_NODE_COVERAGE = 0.8;

/** Minimum number of a node's subagents that must each independently clear
 * FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD for the fan-out-multiplier flag
 * to fire (see detectFanOutMultiplier below). Provisional — see module
 * header. */
export const FAN_OUT_MULTIPLIER_MIN_SUBAGENTS = 2;

/** Per-subagent cacheReadInputTokens threshold (raw token count, not a
 * share) above which a subagent counts as "independently re-reading a
 * large cached context" for the fan-out-multiplier check. Provisional —
 * see module header. */
export const FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD = 500_000;

/** Total order over the three real tiers ("unknown" has no rank — a
 * declared tier of "unknown" is treated as "no declared tier", see
 * declaredTierFromModel). */
const TIER_RANK: Record<"haiku" | "sonnet" | "opus", number> = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
};

const REAL_TIERS: ReadonlyArray<"haiku" | "sonnet" | "opus"> = [
  "haiku",
  "sonnet",
  "opus",
];

/** Classify a node's declared model (NodeState.model) into a Tier the
 * tier-leak check can compare against, or undefined if the node has no
 * meaningful declared expectation to violate.
 *
 * NodeState.model is undefined for an unpinned node. When pinned, its
 * runtime shape is inconsistent across call sites — run-engine.ts's
 * makeInitialNodeStates sets the FULL model id (e.g. "claude-sonnet-5"),
 * while test fixtures and some workflow tests use the short tier alias
 * ("sonnet") directly. modelIdToTier's substring match handles both
 * forms identically, so this function is a thin wrapper: undefined stays
 * undefined, and a classification of "unknown" (a declared string that
 * doesn't match any real tier family — e.g. a future non-Claude model id)
 * is also treated as "no declared tier" rather than asserted against,
 * since there is no dagrunner tier expectation to violate in that case. */
export function declaredTierFromModel(
  model: string | undefined,
): Tier | undefined {
  if (model === undefined) return undefined;
  const tier = modelIdToTier(model);
  return tier === "unknown" ? undefined : tier;
}

/** Cold-reload-tax flag for one node's derived burn data. */
export function detectColdReloadTax(derived: BurnDerived): HotspotFlag | null {
  if (derived.cacheColdRatio > COLD_RELOAD_TAX_THRESHOLD) {
    return { kind: "cold-reload-tax", cacheColdRatio: derived.cacheColdRatio };
  }
  return null;
}

/** Tier-leak flag: fires when the node's tierMix has nonzero tokens in any
 * tier strictly above its declared tier. No declared tier (undefined) ⇒
 * no flag — there is no expectation to violate. tierMix.unknown tokens
 * never trigger this flag (we don't know their tier), but callers must
 * still render them visibly elsewhere — never silently dropped. */
export function detectTierLeak(
  tierMix: TierMix,
  declaredTier: Tier | undefined,
): HotspotFlag | null {
  if (declaredTier === undefined || declaredTier === "unknown") return null;
  const declaredRank = TIER_RANK[declaredTier];
  const leakedTiers = REAL_TIERS.filter(
    (t) => TIER_RANK[t] > declaredRank && tierMix[t] > 0,
  );
  if (leakedTiers.length === 0) return null;
  return { kind: "tier-leak", declaredTier, leakedTiers };
}

/** Output-heavy flag for one node's derived burn data. nodeTotal is
 * cacheReadTokens + cacheCreationTokens + outputTokens (the three buckets
 * `derived` actually tracks — raw non-cache input tokens aren't captured
 * separately). Guards the zero-total case: no flag, not a divide-by-zero. */
export function detectOutputHeavy(derived: BurnDerived): HotspotFlag | null {
  const nodeTotal =
    derived.cacheReadTokens +
    derived.cacheCreationTokens +
    derived.outputTokens;
  if (nodeTotal === 0) return null;
  const outputShare = derived.outputTokens / nodeTotal;
  if (outputShare > OUTPUT_HEAVY_SHARE_THRESHOLD) {
    return { kind: "output-heavy", outputShare };
  }
  return null;
}

/** Verbose-tool-output flag (Burn Monitor D4b): fires on presence alone —
 * `intraNode.verboseToolOutputs` is only ever populated for a tool result
 * Claude Code's OWN externalization already decided was oversized (see
 * src/runtime/intra-node.ts's module header); inventing a second size
 * threshold on top of an already-thresholded signal would be redundant.
 * null intraNode (a "rollup"-phase node) never flags — there is nothing to
 * inspect. */
export function detectVerboseToolOutput(
  intraNode: IntraNodeData | null,
): HotspotFlag | null {
  if (intraNode === null) return null;
  if (intraNode.verboseToolOutputs.length === 0) return null;
  const totalKb = intraNode.verboseToolOutputs.reduce(
    (sum, v) => sum + v.sizeKb,
    0,
  );
  return {
    kind: "verbose-tool-output",
    count: intraNode.verboseToolOutputs.length,
    totalKb,
  };
}

/** Fan-out-multiplier flag (Burn Monitor D4b): fires when at least
 * FAN_OUT_MULTIPLIER_MIN_SUBAGENTS of a node's subagents each
 * independently re-read a large, similarly-sized cached context
 * (cacheReadInputTokens >= FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD) — the
 * "same input re-read N times" cost multiplier a reviewer-style fan-out
 * pays for splitting one large context across many subagent invocations.
 * Reports the qualifying count and the SUM of cacheReadInputTokens across
 * only the qualifying subagents (the total cache-read "tax" paid across
 * the fan-out) — non-qualifying subagents are excluded from both the count
 * and the sum. null intraNode never flags. */
export function detectFanOutMultiplier(
  intraNode: IntraNodeData | null,
): HotspotFlag | null {
  if (intraNode === null) return null;
  const qualifying = intraNode.subagents.filter(
    (s) =>
      s.tokens.cacheReadInputTokens >= FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD,
  );
  if (qualifying.length < FAN_OUT_MULTIPLIER_MIN_SUBAGENTS) return null;
  const totalCacheReadTokens = qualifying.reduce(
    (sum, s) => sum + s.tokens.cacheReadInputTokens,
    0,
  );
  return {
    kind: "fan-out-multiplier",
    qualifyingCount: qualifying.length,
    totalCacheReadTokens,
  };
}

/** Run-level: which node ids meet the fat-fixed-prefix per-node token
 * threshold AND the prefix recurs across at least FAT_PREFIX_NODE_COVERAGE
 * of nodes with valid (BurnDocOk) burn data. Denominator is nodes with
 * valid burn data only — BurnDocError markers and nodes with no burn.json
 * at all are excluded from both numerator and denominator. Zero valid
 * nodes ⇒ no flags (no divide-by-zero). */
export function computeFatPrefixFlaggedNodes(
  okDocsByNode: Record<string, BurnDocOk>,
): Set<string> {
  const nodeIds = Object.keys(okDocsByNode);
  const denom = nodeIds.length;
  if (denom === 0) return new Set();

  const overThreshold = nodeIds.filter(
    (id) =>
      okDocsByNode[id]!.derived.cacheCreationTokens >
      FAT_PREFIX_TOKEN_THRESHOLD,
  );
  const fraction = overThreshold.length / denom;
  if (fraction < FAT_PREFIX_NODE_COVERAGE) return new Set();
  return new Set(overThreshold);
}

/** Compose all six hotspot checks for one node into its flag list.
 * `fatPrefixFlagged` is pre-computed run-wide by computeFatPrefixFlaggedNodes
 * — the fat-fixed-prefix check is inherently a run-level computation
 * threaded back in as a per-node badge, not a check this function can do
 * in isolation (see module header). `intraNode` defaults to null (a
 * "rollup"-phase node, or any caller that hasn't wired D4b data through
 * yet) — both transcript-derived checks (verbose-tool-output, fan-out-
 * multiplier) degrade to "no flag" identically to a null intraNode, so
 * existing rollup-only call sites are unaffected. */
export function computeNodeHotspots(params: {
  derived: BurnDerived;
  declaredTier: Tier | undefined;
  fatPrefixFlagged: boolean;
  intraNode?: IntraNodeData | null;
}): HotspotFlag[] {
  const { derived, declaredTier, fatPrefixFlagged, intraNode = null } = params;
  const flags: HotspotFlag[] = [];

  const coldReload = detectColdReloadTax(derived);
  if (coldReload) flags.push(coldReload);

  const tierLeak = detectTierLeak(derived.tierMix, declaredTier);
  if (tierLeak) flags.push(tierLeak);

  if (fatPrefixFlagged) {
    flags.push({
      kind: "fat-fixed-prefix",
      cacheCreationTokens: derived.cacheCreationTokens,
    });
  }

  const outputHeavy = detectOutputHeavy(derived);
  if (outputHeavy) flags.push(outputHeavy);

  const verboseToolOutput = detectVerboseToolOutput(intraNode);
  if (verboseToolOutput) flags.push(verboseToolOutput);

  const fanOutMultiplier = detectFanOutMultiplier(intraNode);
  if (fanOutMultiplier) flags.push(fanOutMultiplier);

  return flags;
}
