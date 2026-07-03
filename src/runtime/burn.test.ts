/**
 * burn.test.ts — unit tests for the pure burn.json derivation functions.
 *
 * Scope: cacheColdRatio (incl. 0/0 guard), computeTierMix (incl. unknown
 * model id bucketing), modelIdToTier inversion map, and buildBurn's
 * missing/malformed-modelUsage error-marker path.
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
  type ModelUsage,
} from "./burn.js";

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

test("modelIdToTier: known ids invert to their tier", () => {
  assert.equal(modelIdToTier("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(modelIdToTier("claude-sonnet-5"), "sonnet");
  assert.equal(modelIdToTier("claude-opus-4-8"), "opus");
});

test("modelIdToTier: unrecognized id maps to unknown", () => {
  assert.equal(modelIdToTier("claude-some-future-model"), "unknown");
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
