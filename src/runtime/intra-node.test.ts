/**
 * intra-node.test.ts — unit tests for Burn Monitor Deliverable 4a
 * (intra-node attribution capture).
 *
 * Scope: the message-id dedup landmine (last-occurrence-wins, incl. the
 * regression fixture reproducing the real streaming-duplicate pattern
 * that defeats a naive "first occurrence" reading), usage/tool-call
 * summation on deduped records, retry counting, verbose-tool-output
 * marker parsing, cost apportioning (proportional + exact-sum-back),
 * reconciliation deltas, the full pure attribution composition (locked
 * against REAL numbers captured from the `53861-1`/`review` node's raw
 * session JSONL — see DECISIONS.md § burn-monitor-d4a-intra-node-capture),
 * and the fs integration layer (computeIntraNode) against a synthetic
 * on-disk fixture mirroring Claude Code's real directory shape.
 *
 * Run with:
 *   node --test --import tsx src/runtime/intra-node.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractAssistantRecords,
  dedupAssistantRecordsByMessageId,
  sumUsageByModel,
  sumToolUseCounts,
  buildToolUseIdToNameMap,
  extractRetryCount,
  extractVerboseToolOutputs,
  mergeToolCallCounts,
  apportionCost,
  computeReconciliation,
  computeIntraNodeAttribution,
  computeIntraNode,
  locateSessionJsonlPath,
  readJsonlRecords,
} from "./intra-node.js";
import type { BurnModelEntry } from "./burn.js";

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function assistantLine(params: {
  messageId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  toolUses?: Array<{ id: string; name: string }>;
}): Record<string, unknown> {
  const {
    messageId,
    model = "claude-opus-4-8",
    inputTokens = 0,
    outputTokens = 0,
    cacheReadInputTokens = 0,
    cacheCreationInputTokens = 0,
    toolUses = [],
  } = params;
  return {
    type: "assistant",
    message: {
      id: messageId,
      model,
      content: toolUses.map((tu) => ({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
      })),
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
      },
    },
  };
}

function modelEntry(
  model: string,
  over: Partial<BurnModelEntry> = {},
): BurnModelEntry {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// extractAssistantRecords
// ---------------------------------------------------------------------------

test("extractAssistantRecords: parses well-formed assistant lines, skips non-assistant/malformed", () => {
  const raw: unknown[] = [
    { type: "user", message: { content: [] } },
    assistantLine({ messageId: "m1", outputTokens: 10 }),
    { type: "assistant", message: { id: "no-usage" } }, // malformed: no usage
    null,
    "not an object",
  ];
  const parsed = extractAssistantRecords(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.messageId, "m1");
  assert.equal(parsed[0]!.usage.outputTokens, 10);
});

// ---------------------------------------------------------------------------
// dedupAssistantRecordsByMessageId — THE landmine
// ---------------------------------------------------------------------------

test("dedup: reproduces the real streaming-duplicate pattern — last occurrence wins, not first, not sum", () => {
  // Mirrors the empirical pattern found in the real 53861-1/review session:
  // the same message.id re-emitted as the stream progresses, output_tokens
  // and the tool_use content growing across duplicates.
  const raw: unknown[] = [
    assistantLine({ messageId: "m1", outputTokens: 1, toolUses: [] }),
    assistantLine({
      messageId: "m1",
      outputTokens: 222,
      toolUses: [{ id: "t1", name: "Bash" }],
    }),
    assistantLine({
      messageId: "m1",
      outputTokens: 498,
      toolUses: [
        { id: "t1", name: "Bash" },
        { id: "t2", name: "Read" },
      ],
    }),
  ];
  const parsed = extractAssistantRecords(raw);
  const deduped = dedupAssistantRecordsByMessageId(parsed);

  assert.equal(deduped.length, 1, "one distinct message.id -> one record");
  assert.equal(
    deduped[0]!.usage.outputTokens,
    498,
    "must take the LAST (final, most complete) duplicate's usage, not the first (1) and not the sum (721)",
  );
  assert.deepEqual(
    deduped[0]!.toolUses.map((t) => t.id).sort(),
    ["t1", "t2"],
    "must take the LAST duplicate's tool_use blocks (2), not the first (0)",
  );
});

test("dedup: distinct message ids are preserved, duplicates collapse per id", () => {
  const raw: unknown[] = [
    assistantLine({ messageId: "m1", outputTokens: 5 }),
    assistantLine({ messageId: "m2", outputTokens: 7 }),
    assistantLine({ messageId: "m1", outputTokens: 9 }), // dup of m1, later, wins
  ];
  const deduped = dedupAssistantRecordsByMessageId(
    extractAssistantRecords(raw),
  );
  assert.equal(deduped.length, 2);
  const byId = Object.fromEntries(deduped.map((d) => [d.messageId, d]));
  assert.equal(byId["m1"]!.usage.outputTokens, 9);
  assert.equal(byId["m2"]!.usage.outputTokens, 7);
});

test("dedup: naive full-record summation (the landmine) would overcount ~3-4x — proof by contrast", () => {
  const raw: unknown[] = [
    assistantLine({ messageId: "m1", outputTokens: 100 }),
    assistantLine({ messageId: "m1", outputTokens: 100 }),
    assistantLine({ messageId: "m1", outputTokens: 100 }),
    assistantLine({ messageId: "m1", outputTokens: 100 }),
  ];
  const parsed = extractAssistantRecords(raw);
  const naiveSum = sumUsageByModel(parsed); // WRONG: not deduped first
  const correctSum = sumUsageByModel(dedupAssistantRecordsByMessageId(parsed));
  assert.equal(
    naiveSum["claude-opus-4-8"]!.outputTokens,
    400,
    "the landmine: 4x overcount when summed without dedup",
  );
  assert.equal(
    correctSum["claude-opus-4-8"]!.outputTokens,
    100,
    "correct: dedup first, then sum",
  );
});

// ---------------------------------------------------------------------------
// sumUsageByModel / sumToolUseCounts / buildToolUseIdToNameMap
// ---------------------------------------------------------------------------

test("sumUsageByModel: groups and sums per model across multiple distinct messages", () => {
  const raw: unknown[] = [
    assistantLine({
      messageId: "m1",
      model: "claude-opus-4-8",
      outputTokens: 10,
      inputTokens: 1,
    }),
    assistantLine({
      messageId: "m2",
      model: "claude-sonnet-4-6",
      outputTokens: 20,
      inputTokens: 2,
    }),
    assistantLine({
      messageId: "m3",
      model: "claude-opus-4-8",
      outputTokens: 30,
      inputTokens: 3,
    }),
  ];
  const totals = sumUsageByModel(
    dedupAssistantRecordsByMessageId(extractAssistantRecords(raw)),
  );
  assert.equal(totals["claude-opus-4-8"]!.outputTokens, 40);
  assert.equal(totals["claude-opus-4-8"]!.inputTokens, 4);
  assert.equal(totals["claude-sonnet-4-6"]!.outputTokens, 20);
});

test("sumToolUseCounts: counts tool_use blocks by name off deduped records only", () => {
  const raw: unknown[] = [
    assistantLine({ messageId: "m1", toolUses: [{ id: "t1", name: "Bash" }] }),
    assistantLine({
      messageId: "m1",
      toolUses: [
        { id: "t1", name: "Bash" },
        { id: "t2", name: "Bash" },
      ],
    }),
    assistantLine({ messageId: "m2", toolUses: [{ id: "t3", name: "Read" }] }),
  ];
  const deduped = dedupAssistantRecordsByMessageId(
    extractAssistantRecords(raw),
  );
  const counts = sumToolUseCounts(deduped);
  assert.deepEqual(counts, { Bash: 2, Read: 1 });
});

test("buildToolUseIdToNameMap: maps tool_use ids to their tool name off deduped records", () => {
  const raw: unknown[] = [
    assistantLine({ messageId: "m1", toolUses: [{ id: "t1", name: "Bash" }] }),
  ];
  const deduped = dedupAssistantRecordsByMessageId(
    extractAssistantRecords(raw),
  );
  assert.deepEqual(buildToolUseIdToNameMap(deduped), { t1: "Bash" });
});

// ---------------------------------------------------------------------------
// extractRetryCount — confirmed shape: type:"system" + numeric retryAttempt
// ---------------------------------------------------------------------------

test("extractRetryCount: counts system/api_error records carrying numeric retryAttempt", () => {
  const raw: unknown[] = [
    { type: "assistant" },
    { type: "system", subtype: "api_error", retryAttempt: 1, retryInMs: 616.9 },
    { type: "system", subtype: "api_error", retryAttempt: 2, retryInMs: 1200 },
    { type: "system", subtype: "info" }, // no retryAttempt — not a retry
  ];
  assert.equal(extractRetryCount(raw), 2);
});

test("extractRetryCount: zero when no retry records present", () => {
  assert.equal(extractRetryCount([{ type: "assistant" }, { type: "user" }]), 0);
});

// ---------------------------------------------------------------------------
// extractVerboseToolOutputs
// ---------------------------------------------------------------------------

test("extractVerboseToolOutputs: parses the real externalization marker, resolves tool name, dedups by toolUseId", () => {
  const raw: unknown[] = [
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content:
              "<persisted-output>\nOutput too large (135.2KB). Full output saved to: /x/tool-results/bekk7j2oz.txt\n\nPreview...",
          },
        ],
      },
    },
    // duplicate marker line for the same tool_use_id — must collapse to one entry
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content:
              "<persisted-output>\nOutput too large (135.2KB). Full output saved to: /x/tool-results/bekk7j2oz.txt\n\nPreview...",
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "small, not externalized",
          },
        ],
      },
    },
  ];
  const flags = extractVerboseToolOutputs(raw, { toolu_1: "Bash" });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.toolUseId, "toolu_1");
  assert.equal(flags[0]!.toolName, "Bash");
  assert.equal(flags[0]!.sizeKb, 135.2);
});

test("extractVerboseToolOutputs: unresolvable tool name renders 'unknown', never dropped", () => {
  const raw: unknown[] = [
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_9",
            content: "Output too large (10KB). Full output saved to: /x.txt",
          },
        ],
      },
    },
  ];
  const flags = extractVerboseToolOutputs(raw, {});
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.toolName, "unknown");
});

// ---------------------------------------------------------------------------
// mergeToolCallCounts
// ---------------------------------------------------------------------------

test("mergeToolCallCounts: sums shared keys, keeps unique keys from both sides", () => {
  const merged = mergeToolCallCounts(
    { Bash: 3, Read: 1 },
    { Bash: 2, Write: 4 },
  );
  assert.deepEqual(merged, { Bash: 5, Read: 1, Write: 4 });
});

// ---------------------------------------------------------------------------
// apportionCost — proportional split with exact-sum-back guarantee
// ---------------------------------------------------------------------------

test("apportionCost: proportional split on a clean-dividing input", () => {
  const result = apportionCost(100, { a: 25, b: 75 });
  assert.equal(result["a"], 25);
  assert.equal(result["b"], 75);
});

test("apportionCost: sums back exactly to the rollup cost even with non-clean-dividing tokens", () => {
  const result = apportionCost(6.467057849999998, {
    parent: 2333333,
    sub1: 91,
    sub2: 7654321,
  });
  const sum = Object.values(result).reduce((s, v) => s + v, 0);
  assert.ok(
    Math.abs(sum - 6.467057849999998) < 1e-9,
    `split must sum back to the original cost, got ${sum}`,
  );
});

test("apportionCost: zero total tokens across all parties degrades to last-party-gets-everything, no NaN", () => {
  const result = apportionCost(10, { a: 0, b: 0 });
  assert.equal(result["a"], 0);
  assert.equal(result["b"], 10);
  assert.ok(!Number.isNaN(result["a"]) && !Number.isNaN(result["b"]));
});

test("apportionCost: empty party map returns empty result", () => {
  assert.deepEqual(apportionCost(10, {}), {});
});

// ---------------------------------------------------------------------------
// computeReconciliation
// ---------------------------------------------------------------------------

test("computeReconciliation: zero-delta case (intra matches rollup exactly)", () => {
  const rollup = [
    modelEntry("claude-opus-4-8", {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    }),
  ];
  const recon = computeReconciliation(
    {
      "claude-opus-4-8": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
      },
    },
    rollup,
  );
  assert.deepEqual(recon["claude-opus-4-8"]!.inputTokens, {
    delta: 0,
    deltaPct: 0,
  });
  assert.deepEqual(recon["claude-opus-4-8"]!.outputTokens, {
    delta: 0,
    deltaPct: 0,
  });
});

test("computeReconciliation: nonzero-delta case computes delta and deltaPct correctly", () => {
  const rollup = [modelEntry("claude-opus-4-8", { outputTokens: 1000 })];
  const recon = computeReconciliation(
    {
      "claude-opus-4-8": {
        inputTokens: 0,
        outputTokens: 950,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    rollup,
  );
  assert.equal(recon["claude-opus-4-8"]!.outputTokens.delta, -50);
  assert.equal(recon["claude-opus-4-8"]!.outputTokens.deltaPct, -0.05);
});

test("computeReconciliation: rollup model with no matching intra data defaults to all-zero intra (never omitted)", () => {
  const rollup = [modelEntry("claude-haiku-4-5-20251001", { inputTokens: 10 })];
  const recon = computeReconciliation({}, rollup);
  assert.ok(
    "claude-haiku-4-5-20251001" in recon,
    "must always populate an entry for every rollup model",
  );
  assert.equal(recon["claude-haiku-4-5-20251001"]!.inputTokens.delta, -10);
});

// ---------------------------------------------------------------------------
// computeIntraNodeAttribution — REAL DATA regression
//
// Fixture values captured directly off the real 53861-1/review node's raw
// session JSONL (parent + all 6 subagent transcripts), summed per-file via
// this module's own dedup rule. See DECISIONS.md §
// burn-monitor-d4a-intra-node-capture for the full reconciliation report.
// This locks the empirical finding in as a permanent regression: input/
// cacheRead/cacheCreation reconcile EXACTLY; output has the known ~5%/13%
// residual (streaming-finalization artifact, not a dedup/attribution bug —
// see D3 spike).
// ---------------------------------------------------------------------------

const REAL_ROLLUP: BurnModelEntry[] = [
  modelEntry("claude-opus-4-8", {
    inputTokens: 7657,
    outputTokens: 38858,
    cacheReadInputTokens: 3620542,
    cacheCreationInputTokens: 214434,
    costUSD: 4.479155999999999,
  }),
  modelEntry("claude-sonnet-4-6", {
    inputTokens: 94,
    outputTokens: 20450,
    cacheReadInputTokens: 3597662,
    cacheCreationInputTokens: 160419,
    costUSD: 1.987901850000001,
  }),
];

const REAL_PARENT_USAGE = {
  "claude-opus-4-8": {
    inputTokens: 6430,
    outputTokens: 21699,
    cacheReadInputTokens: 2240900,
    cacheCreationInputTokens: 85050,
  },
};

const REAL_SUBAGENTS = [
  {
    agentId: "a1b6d4fa6c45ed475",
    agentType: "reviewer-distributed-systems",
    usageByModel: {
      "claude-opus-4-8": {
        inputTokens: 20,
        outputTokens: 2886,
        cacheReadInputTokens: 361963,
        cacheCreationInputTokens: 48900,
      },
    },
  },
  {
    agentId: "a354b7231d70ff441",
    agentType: "reviewer-correctness",
    usageByModel: {
      "claude-opus-4-8": {
        inputTokens: 40,
        outputTokens: 6540,
        cacheReadInputTokens: 871479,
        cacheCreationInputTokens: 56315,
      },
    },
  },
  {
    agentId: "ae4646ef89e11e592",
    agentType: "reviewer-adversarial-verifier",
    usageByModel: {
      "claude-opus-4-8": {
        inputTokens: 1167,
        outputTokens: 5729,
        cacheReadInputTokens: 146200,
        cacheCreationInputTokens: 24169,
      },
    },
  },
  {
    agentId: "a2abdb447ef2de6b7",
    agentType: "reviewer-migration-safety",
    usageByModel: {
      "claude-sonnet-4-6": {
        inputTokens: 32,
        outputTokens: 4801,
        cacheReadInputTokens: 1421466,
        cacheCreationInputTokens: 61431,
      },
    },
  },
  {
    agentId: "a4e528970e3b2c38a",
    agentType: "reviewer-test-adequacy",
    usageByModel: {
      "claude-sonnet-4-6": {
        inputTokens: 38,
        outputTokens: 8002,
        cacheReadInputTokens: 1322269,
        cacheCreationInputTokens: 49478,
      },
    },
  },
  {
    agentId: "ae9f55697f97a75d3",
    agentType: "reviewer-api-stability",
    usageByModel: {
      "claude-sonnet-4-6": {
        inputTokens: 24,
        outputTokens: 4994,
        cacheReadInputTokens: 853927,
        cacheCreationInputTokens: 49510,
      },
    },
  },
];

test("computeIntraNodeAttribution: real-run regression — reconciliation matches the D3 spike's known baseline exactly", () => {
  const { reconciliation } = computeIntraNodeAttribution({
    parentUsageByModel: REAL_PARENT_USAGE,
    subagents: REAL_SUBAGENTS,
    rollupModels: REAL_ROLLUP,
  });

  const opus = reconciliation["claude-opus-4-8"]!;
  assert.equal(opus.inputTokens.delta, 0);
  assert.equal(opus.cacheReadInputTokens.delta, 0);
  assert.equal(opus.cacheCreationInputTokens.delta, 0);
  assert.equal(opus.outputTokens.delta, -2004);
  assert.ok(Math.abs(opus.outputTokens.deltaPct - -0.05157239178547532) < 1e-9);

  const sonnet = reconciliation["claude-sonnet-4-6"]!;
  assert.equal(sonnet.inputTokens.delta, 0);
  assert.equal(sonnet.cacheReadInputTokens.delta, 0);
  assert.equal(sonnet.cacheCreationInputTokens.delta, 0);
  assert.equal(sonnet.outputTokens.delta, -2653);
  assert.ok(
    Math.abs(sonnet.outputTokens.deltaPct - -0.12973105134474328) < 1e-9,
  );
});

test("computeIntraNodeAttribution: subagent cost apportionment is proportional to token share and sums to the rollup cost per model", () => {
  const { subagentEntries } = computeIntraNodeAttribution({
    parentUsageByModel: REAL_PARENT_USAGE,
    subagents: REAL_SUBAGENTS,
    rollupModels: REAL_ROLLUP,
  });

  // every subagent classified into the tier of the (only, in this fixture) model it used
  const byId = Object.fromEntries(subagentEntries.map((s) => [s.agentId, s]));
  assert.equal(byId["a1b6d4fa6c45ed475"]!.tier, "opus");
  assert.equal(byId["a2abdb447ef2de6b7"]!.tier, "sonnet");

  // apportioned costs are all positive and each is less than the full
  // rollup cost for its model (proportional share, never the whole thing,
  // since the parent also used tokens on both models)
  for (const s of subagentEntries) {
    assert.ok(s.apportionedCostUsd > 0);
    assert.ok(s.apportionedCostUsd < 4.5);
  }

  // sanity: total apportioned to subagents + implicit parent share per
  // model reconstructs each model's rollup costUSD.
  const opusSubagentIds = [
    "a1b6d4fa6c45ed475",
    "a354b7231d70ff441",
    "ae4646ef89e11e592",
  ];
  const opusSubagentTotal = opusSubagentIds.reduce(
    (s, id) => s + byId[id]!.apportionedCostUsd,
    0,
  );
  assert.ok(opusSubagentTotal > 0 && opusSubagentTotal < 4.479155999999999);
});

// ---------------------------------------------------------------------------
// computeIntraNode + locateSessionJsonlPath + readJsonlRecords — fs
// integration against a synthetic on-disk fixture mirroring Claude Code's
// real directory shape. Never touches the real ~/.claude home.
// ---------------------------------------------------------------------------

function withTempClaudeConfigDir(fn: (claudeConfigDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dagrunner-intranode-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("locateSessionJsonlPath: finds the session file by globbing project dirs for the sessionId filename", () => {
  withTempClaudeConfigDir((claudeConfigDir) => {
    const projectDir = join(claudeConfigDir, "projects", "-some-sanitized-cwd");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-abc.jsonl"), "");
    const found = locateSessionJsonlPath(claudeConfigDir, "session-abc");
    assert.equal(found, join(projectDir, "session-abc.jsonl"));
  });
});

test("locateSessionJsonlPath: returns null when not found (never throws)", () => {
  withTempClaudeConfigDir((claudeConfigDir) => {
    assert.equal(locateSessionJsonlPath(claudeConfigDir, "nope"), null);
  });
});

test("readJsonlRecords: skips malformed lines instead of throwing", () => {
  withTempClaudeConfigDir((claudeConfigDir) => {
    const file = join(claudeConfigDir, "f.jsonl");
    writeFileSync(file, '{"a":1}\nnot json\n\n{"b":2}\n');
    const records = readJsonlRecords(file);
    assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
  });
});

test("computeIntraNode: full pipeline on a synthetic fixture — populates subagents, reconciliation, tool counts, retries, verbose flags", () => {
  withTempClaudeConfigDir((claudeConfigDir) => {
    const sessionId = "sess-1";
    const projectDir = join(claudeConfigDir, "projects", "-fake-cwd");
    mkdirSync(projectDir, { recursive: true });

    const parentLines = [
      JSON.stringify(
        assistantLine({
          messageId: "p1",
          model: "claude-opus-4-8",
          inputTokens: 10,
          outputTokens: 20,
          toolUses: [{ id: "tu1", name: "Bash" }],
        }),
      ),
      JSON.stringify({
        type: "system",
        subtype: "api_error",
        retryAttempt: 1,
        retryInMs: 500,
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content:
                "Output too large (12.3KB). Full output saved to: /x/tool-results/abc.txt",
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), parentLines);

    const subagentsDir = join(projectDir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "agent-x1.meta.json"),
      JSON.stringify({
        agentType: "reviewer-correctness",
        description: "d",
        toolUseId: "toolu_x",
        spawnDepth: 1,
      }),
    );
    writeFileSync(
      join(subagentsDir, "agent-x1.jsonl"),
      JSON.stringify(
        assistantLine({
          messageId: "s1",
          model: "claude-sonnet-4-6",
          inputTokens: 5,
          outputTokens: 15,
        }),
      ) + "\n",
    );

    const rollupModels: BurnModelEntry[] = [
      modelEntry("claude-opus-4-8", {
        inputTokens: 10,
        outputTokens: 20,
        costUSD: 1.0,
      }),
      modelEntry("claude-sonnet-4-6", {
        inputTokens: 5,
        outputTokens: 15,
        costUSD: 0.5,
      }),
    ];

    const result = computeIntraNode({
      claudeConfigDir,
      sessionId,
      rollupModels,
    });
    assert.ok(result !== null);
    assert.equal(result!.subagents.length, 1);
    assert.equal(result!.subagents[0]!.agentType, "reviewer-correctness");
    assert.equal(result!.subagents[0]!.tier, "sonnet");
    assert.equal(result!.retryCount, 1);
    assert.deepEqual(result!.toolCallCounts, { Bash: 1 });
    assert.equal(result!.verboseToolOutputs.length, 1);
    assert.equal(result!.verboseToolOutputs[0]!.toolName, "Bash");
    assert.equal(result!.verboseToolOutputs[0]!.sizeKb, 12.3);
    // reconciliation: intra matches rollup exactly in this clean fixture
    assert.equal(
      result!.reconciliation["claude-opus-4-8"]!.outputTokens.delta,
      0,
    );
    assert.equal(
      result!.reconciliation["claude-sonnet-4-6"]!.outputTokens.delta,
      0,
    );
  });
});

test("computeIntraNode: session JSONL not found degrades to null (never throws)", () => {
  withTempClaudeConfigDir((claudeConfigDir) => {
    const result = computeIntraNode({
      claudeConfigDir,
      sessionId: "does-not-exist",
      rollupModels: [modelEntry("claude-opus-4-8")],
    });
    assert.equal(result, null);
  });
});

test("computeIntraNode: node with no subagents dir degrades to zero subagents, not an error", () => {
  withTempClaudeConfigDir((claudeConfigDir) => {
    const sessionId = "sess-solo";
    const projectDir = join(claudeConfigDir, "projects", "-fake-cwd");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify(assistantLine({ messageId: "p1", outputTokens: 5 })) +
        "\n",
    );
    const result = computeIntraNode({
      claudeConfigDir,
      sessionId,
      rollupModels: [modelEntry("claude-opus-4-8", { outputTokens: 5 })],
    });
    assert.ok(result !== null);
    assert.deepEqual(result!.subagents, []);
  });
});
