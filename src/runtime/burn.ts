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
 * v1 scope (this deliverable): phase is always "rollup", intraNode is
 * always null. Transcript-level parsing and intra-node tier-leak detection
 * are later, separately-gated deliverables — not implemented here.
 */

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
  phase: "rollup";
  models: BurnModelEntry[];
  derived: BurnDerived;
  intraNode: null;
};

export type BurnDocError = {
  node: string;
  sessionId: string;
  schemaVersion: 1;
  error: string;
};

export type BurnDoc = BurnDocOk | BurnDocError;

// ---------------------------------------------------------------------------
// Model id -> tier inversion
// ---------------------------------------------------------------------------

/** The exact model ids sdk-runner.ts maps node.model tiers to. Kept as the
 * single source of truth here; sdk-runner.ts's forward map (tier -> id)
 * must stay in sync with this inverse map — see DECISIONS.md. */
export const MODEL_ID_TO_TIER: Record<string, Tier> = {
  "claude-haiku-4-5-20251001": "haiku",
  "claude-sonnet-5": "sonnet",
  "claude-opus-4-8": "opus",
};

/** Invert a known SDK model id to its dagrunner tier. Unknown ids (e.g. an
 * unpinned node's SDK-default model, or a future model id not yet in the
 * map) return "unknown" rather than throwing or silently dropping — the
 * tokens must still be accounted for somewhere. */
export function modelIdToTier(modelId: string): Tier {
  return MODEL_ID_TO_TIER[modelId] ?? "unknown";
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
