/**
 * burn.test.ts — unit tests for the pure burn.json derivation functions.
 *
 * Scope: cacheColdRatio (incl. 0/0 guard), computeTierMix (incl. unknown
 * model id bucketing), modelIdToTier substring classification (incl. the
 * D1->D2 claude-sonnet-4-6 regression), buildBurn's missing/malformed-
 * modelUsage error-marker path, declaredTierFromModel, and the D2 hotspot
 * detectors (cold-reload-tax, tier-leak, output-heavy, fat-fixed-prefix
 * cross-node coverage, and their composition in computeNodeHotspots).
 *
 * Run with:
 *   node --test --import tsx src/runtime/burn.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cacheColdRatio,
  computeTierMix,
  modelIdToTier,
  buildBurn,
  declaredTierFromModel,
  detectColdReloadTax,
  detectTierLeak,
  detectOutputHeavy,
  detectVerboseToolOutput,
  detectFanOutMultiplier,
  computeFatPrefixFlaggedNodes,
  computeNodeHotspots,
  COLD_RELOAD_TAX_THRESHOLD,
  OUTPUT_HEAVY_SHARE_THRESHOLD,
  FAT_PREFIX_TOKEN_THRESHOLD,
  FAT_PREFIX_NODE_COVERAGE,
  FAN_OUT_MULTIPLIER_MIN_SUBAGENTS,
  FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD,
  type ModelUsage,
  type BurnDerived,
  type BurnDocOk,
  type TierMix,
} from "./burn.js";
import type { IntraNodeData, IntraNodeSubagent } from "./intra-node.js";

// ---------------------------------------------------------------------------
// cacheColdRatio
// ---------------------------------------------------------------------------

test("cacheColdRatio: 0/0 guard returns 0, not NaN", () => {
  assert.equal(cacheColdRatio(0, 0), 0);
});

test("cacheColdRatio: all-cold (no cache reads) returns 1", () => {
  assert.equal(cacheColdRatio(100, 0), 1);
});

test("cacheColdRatio: all-warm (no cache creation) returns 0", () => {
  assert.equal(cacheColdRatio(0, 100), 0);
});

test("cacheColdRatio: mixed returns the correct fraction", () => {
  assert.equal(cacheColdRatio(25, 75), 0.25);
});

// ---------------------------------------------------------------------------
// modelIdToTier — the inversion map
// ---------------------------------------------------------------------------

test("modelIdToTier: the three canonical dagrunner-pinned ids classify correctly", () => {
  assert.equal(modelIdToTier("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(modelIdToTier("claude-sonnet-5"), "sonnet");
  assert.equal(modelIdToTier("claude-opus-4-8"), "opus");
});

test("modelIdToTier: claude-sonnet-4-6 (reviewer subagent's pinned id, D1's empirical gap) now classifies as sonnet, not unknown", () => {
  assert.equal(modelIdToTier("claude-sonnet-4-6"), "sonnet");
});

test("modelIdToTier: substring match is case-insensitive and works on any dated/aliased id in the family", () => {
  assert.equal(modelIdToTier("CLAUDE-OPUS-9-1"), "opus");
  assert.equal(modelIdToTier("claude-haiku-9-9-20990101"), "haiku");
});

test("modelIdToTier: a genuinely unrecognized id (no tier family substring) still maps to unknown", () => {
  assert.equal(modelIdToTier("gpt-4o"), "unknown");
  assert.equal(modelIdToTier("claude-instant-1.2"), "unknown");
});

// ---------------------------------------------------------------------------
// computeTierMix
// ---------------------------------------------------------------------------

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 0,
  maxOutputTokens: 0,
  ...over,
});

test("computeTierMix: buckets known model ids into their tier", () => {
  const mix = computeTierMix({
    "claude-opus-4-8": usage({ inputTokens: 10, outputTokens: 5 }),
    "claude-sonnet-5": usage({ inputTokens: 3, outputTokens: 2 }),
  });
  assert.equal(mix.opus, 15);
  assert.equal(mix.sonnet, 5);
  assert.equal(mix.haiku, 0);
  assert.equal(mix.unknown, 0);
});

test("computeTierMix: unrecognized model id lands in unknown, not dropped", () => {
  const mix = computeTierMix({
    "claude-mystery-model": usage({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 1,
    }),
  });
  assert.equal(mix.unknown, 12);
  assert.equal(mix.opus + mix.sonnet + mix.haiku, 0);
});

test("computeTierMix: sums all four token fields per model", () => {
  const mix = computeTierMix({
    "claude-haiku-4-5-20251001": usage({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    }),
  });
  assert.equal(mix.haiku, 10);
});

// ---------------------------------------------------------------------------
// buildBurn — the total function, incl. error-marker path
// ---------------------------------------------------------------------------

test("buildBurn: missing modelUsage (undefined) writes an explicit error marker, never a zeroed derived block", () => {
  const doc = buildBurn({
    node: "review",
    sessionId: "sess-1",
    costUsd: 1.23,
    modelUsage: undefined,
  });
  assert.ok("error" in doc, "expected error-marker doc");
  if ("error" in doc) {
    assert.equal(doc.error, "modelUsage missing from SDK result");
    assert.equal(doc.node, "review");
    assert.equal(doc.sessionId, "sess-1");
    assert.equal(doc.schemaVersion, 1);
  }
  // Must NOT contain a silently-zeroed "derived" block.
  assert.ok(!("derived" in doc));
});

test("buildBurn: empty modelUsage object also errors, not a zeroed-ok doc", () => {
  const doc = buildBurn({
    node: "review",
    sessionId: "sess-2",
    costUsd: 0,
    modelUsage: {},
  });
  assert.ok("error" in doc);
});

test("buildBurn: malformed modelUsage (wrong shape) errors instead of throwing", () => {
  const doc = buildBurn({
    node: "review",
    sessionId: "sess-3",
    costUsd: 0,
    modelUsage: { "claude-sonnet-5": { notARealField: true } },
  });
  assert.ok("error" in doc);
});

test("buildBurn: well-formed modelUsage produces a populated rollup doc", () => {
  const doc = buildBurn({
    node: "review",
    sessionId: "sess-4",
    costUsd: 3.41,
    modelUsage: {
      "claude-opus-4-8": usage({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        costUSD: 3.41,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      }),
    },
  });
  assert.ok(!("error" in doc), "expected an ok doc");
  if (!("error" in doc)) {
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.phase, "rollup");
    assert.equal(doc.intraNode, null);
    assert.equal(doc.models.length, 1);
    assert.equal(doc.models[0]?.model, "claude-opus-4-8");
    assert.equal(doc.models[0]?.costUSD, 3.41);
    assert.equal(doc.derived.cacheReadTokens, 20);
    assert.equal(doc.derived.cacheCreationTokens, 10);
    assert.equal(doc.derived.cacheColdRatio, 10 / 30);
    assert.equal(doc.derived.outputTokens, 50);
    assert.equal(doc.derived.tierMix.opus, 180);
  }
});

// ---------------------------------------------------------------------------
// declaredTierFromModel
// ---------------------------------------------------------------------------

test("declaredTierFromModel: undefined (unpinned node) stays undefined", () => {
  assert.equal(declaredTierFromModel(undefined), undefined);
});

test("declaredTierFromModel: short tier alias classifies directly", () => {
  assert.equal(declaredTierFromModel("sonnet"), "sonnet");
  assert.equal(declaredTierFromModel("opus"), "opus");
  assert.equal(declaredTierFromModel("haiku"), "haiku");
});

test("declaredTierFromModel: full pinned model id (run-engine.ts's actual runtime shape) classifies via substring match", () => {
  assert.equal(declaredTierFromModel("claude-sonnet-5"), "sonnet");
  assert.equal(declaredTierFromModel("claude-opus-4-8"), "opus");
});

test("declaredTierFromModel: an unrecognized declared string is treated as no-declared-tier (undefined), not asserted against", () => {
  assert.equal(declaredTierFromModel("gpt-4o"), undefined);
});

// ---------------------------------------------------------------------------
// Hotspot detection — helpers
// ---------------------------------------------------------------------------

const zeroTierMix = (): TierMix => ({
  opus: 0,
  sonnet: 0,
  haiku: 0,
  unknown: 0,
});

const derived = (over: Partial<BurnDerived> = {}): BurnDerived => ({
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheColdRatio: 0,
  outputTokens: 0,
  tierMix: zeroTierMix(),
  ...over,
});

const okDoc = (node: string, over: Partial<BurnDerived> = {}): BurnDocOk => ({
  node,
  sessionId: `sess-${node}`,
  costUsd: 0,
  schemaVersion: 1,
  phase: "rollup",
  models: [],
  derived: derived(over),
  intraNode: null,
});

// ---------------------------------------------------------------------------
// detectColdReloadTax
// ---------------------------------------------------------------------------

test("detectColdReloadTax: at or below threshold does not flag", () => {
  assert.equal(
    detectColdReloadTax(derived({ cacheColdRatio: COLD_RELOAD_TAX_THRESHOLD })),
    null,
  );
});

test("detectColdReloadTax: above threshold flags with the ratio", () => {
  const flag = detectColdReloadTax(derived({ cacheColdRatio: 0.9 }));
  assert.deepEqual(flag, { kind: "cold-reload-tax", cacheColdRatio: 0.9 });
});

// ---------------------------------------------------------------------------
// detectTierLeak
// ---------------------------------------------------------------------------

test("detectTierLeak: declared tier with no higher-tier tokens does not flag", () => {
  const mix = { ...zeroTierMix(), sonnet: 100 };
  assert.equal(detectTierLeak(mix, "sonnet"), null);
});

test("detectTierLeak: a genuine leak fires and lists the leaked tier(s)", () => {
  const mix = { ...zeroTierMix(), sonnet: 100, opus: 50 };
  const flag = detectTierLeak(mix, "sonnet");
  assert.deepEqual(flag, {
    kind: "tier-leak",
    declaredTier: "sonnet",
    leakedTiers: ["opus"],
  });
});

test("detectTierLeak: haiku-declared node leaking into both sonnet and opus lists both", () => {
  const mix = { ...zeroTierMix(), haiku: 10, sonnet: 5, opus: 5 };
  const flag = detectTierLeak(mix, "haiku");
  assert.deepEqual(flag, {
    kind: "tier-leak",
    declaredTier: "haiku",
    leakedTiers: ["sonnet", "opus"],
  });
});

test("detectTierLeak: no declared tier (undefined) skips the check entirely, even with higher-tier tokens present", () => {
  const mix = { ...zeroTierMix(), opus: 999 };
  assert.equal(detectTierLeak(mix, undefined), null);
});

test("detectTierLeak: unknown-tier tokens alone never trigger the flag", () => {
  const mix = { ...zeroTierMix(), sonnet: 10, unknown: 999 };
  assert.equal(detectTierLeak(mix, "sonnet"), null);
});

// ---------------------------------------------------------------------------
// detectOutputHeavy
// ---------------------------------------------------------------------------

test("detectOutputHeavy: zero-total node is guarded — no flag, no divide-by-zero", () => {
  assert.equal(
    detectOutputHeavy(
      derived({ cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }),
    ),
    null,
  );
});

test("detectOutputHeavy: below threshold does not flag", () => {
  assert.equal(
    detectOutputHeavy(
      derived({
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        outputTokens: 10,
      }),
    ),
    null,
  );
});

test("detectOutputHeavy: above threshold flags with the share", () => {
  const flag = detectOutputHeavy(
    derived({ cacheReadTokens: 40, cacheCreationTokens: 0, outputTokens: 60 }),
  );
  assert.deepEqual(flag, { kind: "output-heavy", outputShare: 0.6 });
  assert.ok(0.6 > OUTPUT_HEAVY_SHARE_THRESHOLD);
});

// ---------------------------------------------------------------------------
// computeFatPrefixFlaggedNodes — run-level cross-node coverage math
// ---------------------------------------------------------------------------

test("computeFatPrefixFlaggedNodes: zero valid nodes — no flags, no divide-by-zero", () => {
  const flagged = computeFatPrefixFlaggedNodes({});
  assert.equal(flagged.size, 0);
});

test("computeFatPrefixFlaggedNodes: coverage below threshold — no node flagged even though one exceeds the token threshold", () => {
  // 1 of 5 nodes over threshold = 20% coverage, below FAT_PREFIX_NODE_COVERAGE.
  assert.ok(0.2 < FAT_PREFIX_NODE_COVERAGE);
  const docs: Record<string, BurnDocOk> = {
    a: okDoc("a", { cacheCreationTokens: FAT_PREFIX_TOKEN_THRESHOLD + 1 }),
    b: okDoc("b", { cacheCreationTokens: 10 }),
    c: okDoc("c", { cacheCreationTokens: 10 }),
    d: okDoc("d", { cacheCreationTokens: 10 }),
    e: okDoc("e", { cacheCreationTokens: 10 }),
  };
  const flagged = computeFatPrefixFlaggedNodes(docs);
  assert.equal(flagged.size, 0);
});

test("computeFatPrefixFlaggedNodes: coverage at/above threshold — every node meeting the per-node threshold is flagged", () => {
  // 4 of 5 nodes over threshold = 80% coverage, at FAT_PREFIX_NODE_COVERAGE.
  assert.ok(0.8 >= FAT_PREFIX_NODE_COVERAGE);
  const docs: Record<string, BurnDocOk> = {
    a: okDoc("a", { cacheCreationTokens: FAT_PREFIX_TOKEN_THRESHOLD + 1 }),
    b: okDoc("b", { cacheCreationTokens: FAT_PREFIX_TOKEN_THRESHOLD + 1 }),
    c: okDoc("c", { cacheCreationTokens: FAT_PREFIX_TOKEN_THRESHOLD + 1 }),
    d: okDoc("d", { cacheCreationTokens: FAT_PREFIX_TOKEN_THRESHOLD + 1 }),
    e: okDoc("e", { cacheCreationTokens: 10 }),
  };
  const flagged = computeFatPrefixFlaggedNodes(docs);
  assert.deepEqual(
    [...flagged].sort(),
    ["a", "b", "c", "d"],
    "only nodes meeting the per-node threshold are flagged, not all nodes",
  );
});

// ---------------------------------------------------------------------------
// computeNodeHotspots — composition of all four checks
// ---------------------------------------------------------------------------

test("computeNodeHotspots: clean node (no thresholds crossed) yields no flags", () => {
  const flags = computeNodeHotspots({
    derived: derived({
      cacheReadTokens: 100,
      cacheCreationTokens: 10,
      outputTokens: 5,
      tierMix: { ...zeroTierMix(), sonnet: 115 },
    }),
    declaredTier: "sonnet",
    fatPrefixFlagged: false,
  });
  assert.deepEqual(flags, []);
});

test("computeNodeHotspots: multiple simultaneous flags all appear", () => {
  const flags = computeNodeHotspots({
    derived: derived({
      cacheReadTokens: 5,
      cacheCreationTokens: 95,
      cacheColdRatio: 0.95,
      outputTokens: 500,
      tierMix: { ...zeroTierMix(), sonnet: 100, opus: 500 },
    }),
    declaredTier: "sonnet",
    fatPrefixFlagged: true,
  });
  const kinds = flags.map((f) => f.kind).sort();
  assert.deepEqual(kinds, [
    "cold-reload-tax",
    "fat-fixed-prefix",
    "output-heavy",
    "tier-leak",
  ]);
});

// ---------------------------------------------------------------------------
// detectVerboseToolOutput / detectFanOutMultiplier (Burn Monitor D4b)
// ---------------------------------------------------------------------------

const subagent = (
  over: Partial<IntraNodeSubagent> = {},
): IntraNodeSubagent => ({
  agentId: "agent-1",
  agentType: "reviewer-correctness",
  tier: "sonnet",
  tokens: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  apportionedCostUsd: 0,
  ...over,
});

const intraNode = (over: Partial<IntraNodeData> = {}): IntraNodeData => ({
  subagents: [],
  toolCallCounts: {},
  retryCount: 0,
  verboseToolOutputs: [],
  reconciliation: {},
  ...over,
});

test("detectVerboseToolOutput: null intraNode (rollup-phase node) never flags", () => {
  assert.equal(detectVerboseToolOutput(null), null);
});

test("detectVerboseToolOutput: empty verboseToolOutputs does not flag", () => {
  assert.equal(
    detectVerboseToolOutput(intraNode({ verboseToolOutputs: [] })),
    null,
  );
});

test("detectVerboseToolOutput: any entries present flags, with count and total KB", () => {
  const flag = detectVerboseToolOutput(
    intraNode({
      verboseToolOutputs: [
        { toolUseId: "tu1", toolName: "Read", sizeKb: 12.5 },
        { toolUseId: "tu2", toolName: "Bash", sizeKb: 7.5 },
      ],
    }),
  );
  assert.deepEqual(flag, {
    kind: "verbose-tool-output",
    count: 2,
    totalKb: 20,
  });
});

test("detectFanOutMultiplier: null intraNode never flags", () => {
  assert.equal(detectFanOutMultiplier(null), null);
});

test("detectFanOutMultiplier: fewer than MIN_SUBAGENTS qualifying subagents — no flag even though one exceeds the per-subagent threshold", () => {
  const flag = detectFanOutMultiplier(
    intraNode({
      subagents: [
        subagent({
          agentId: "a",
          tokens: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD + 1,
            cacheCreationInputTokens: 0,
          },
        }),
        subagent({
          agentId: "b",
          tokens: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 0,
          },
        }),
      ],
    }),
  );
  assert.equal(flag, null);
});

test("detectFanOutMultiplier: at/above MIN_SUBAGENTS each below the per-subagent threshold — no flag", () => {
  const flag = detectFanOutMultiplier(
    intraNode({
      subagents: Array.from(
        { length: FAN_OUT_MULTIPLIER_MIN_SUBAGENTS },
        (_, i) =>
          subagent({
            agentId: `sub-${i}`,
            tokens: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD - 1,
              cacheCreationInputTokens: 0,
            },
          }),
      ),
    }),
  );
  assert.equal(flag, null);
});

test("detectFanOutMultiplier: at least MIN_SUBAGENTS each at/above the threshold flags, reporting only the qualifying count/sum", () => {
  const qualifying = Array.from(
    { length: FAN_OUT_MULTIPLIER_MIN_SUBAGENTS },
    (_, i) =>
      subagent({
        agentId: `qualifying-${i}`,
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD,
          cacheCreationInputTokens: 0,
        },
      }),
  );
  const nonQualifying = subagent({
    agentId: "below-threshold",
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 0,
    },
  });
  const flag = detectFanOutMultiplier(
    intraNode({ subagents: [...qualifying, nonQualifying] }),
  );
  assert.deepEqual(flag, {
    kind: "fan-out-multiplier",
    qualifyingCount: FAN_OUT_MULTIPLIER_MIN_SUBAGENTS,
    totalCacheReadTokens:
      FAN_OUT_MULTIPLIER_MIN_SUBAGENTS *
      FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD,
  });
});

test("computeNodeHotspots: intraNode defaulting to null (omitted param) does not throw and adds no D4b flags", () => {
  const flags = computeNodeHotspots({
    derived: derived({
      cacheReadTokens: 100,
      cacheCreationTokens: 10,
      outputTokens: 5,
      tierMix: { ...zeroTierMix(), sonnet: 115 },
    }),
    declaredTier: "sonnet",
    fatPrefixFlagged: false,
  });
  assert.deepEqual(flags, []);
});

test("computeNodeHotspots: transcript-phase node's intraNode flags surface alongside rollup-level flags", () => {
  const flags = computeNodeHotspots({
    derived: derived({
      cacheReadTokens: 100,
      cacheCreationTokens: 10,
      outputTokens: 5,
      tierMix: { ...zeroTierMix(), sonnet: 115 },
    }),
    declaredTier: "sonnet",
    fatPrefixFlagged: false,
    intraNode: intraNode({
      verboseToolOutputs: [{ toolUseId: "tu1", toolName: "Read", sizeKb: 5 }],
    }),
  });
  assert.deepEqual(
    flags.map((f) => f.kind),
    ["verbose-tool-output"],
  );
});
