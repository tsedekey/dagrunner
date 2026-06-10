/**
 * sdk-runner.ts — real SDK node executor (NodeExecutor interface).
 *
 * Key contracts:
 *   1. applyNodeEnv MUST be called BEFORE query() so hooks inherit env.
 *   2. Gated nodes ALWAYS return awaiting-gate (not done) after the query
 *      completes — the human approve step marks them done in run-engine.ts.
 *   3. On resume (ctx.sessionId set) + feedback present, feed feedback as the
 *      next user turn so Claude revises with memory of why it wrote the artifact.
 *   4. classify.json is written from SDK structured_output deterministically by
 *      the runner, not by the node itself.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type {
  NodeExecutor,
  NodeExecResult,
  ExecutionCtx,
} from "./mock-executor.js";
import type { Node } from "./types.js";
import type { DagrunnerConfig } from "./xdg.js";
import { applyNodeEnv, buildNodeEnv } from "./launcher.js";

// ---------------------------------------------------------------------------
// makeSDKRunner
// ---------------------------------------------------------------------------

export function makeSDKRunner(
  config: DagrunnerConfig,
  runId: string,
  runDir: string,
  worktreePath: string,
): NodeExecutor {
  return async function sdkRunner(
    nodeId: string,
    node: Node,
    ctx: ExecutionCtx,
  ): Promise<NodeExecResult> {
    // MUST set env BEFORE spawning query() so hooks and child processes inherit
    // the correct per-node values (env-propagation contract in CLAUDE.md).
    applyNodeEnv(buildNodeEnv(config, runId, nodeId, runDir, worktreePath));
    mkdirSync(ctx.artifactsDir, { recursive: true });

    // Determine prompt: on gate resume feed the latest feedback as the next
    // user turn so Claude revises with full session memory (Theme 5).
    let prompt = node.command;
    if (ctx.sessionId !== undefined && ctx.sessionId !== "") {
      const feedbacks = readdirSync(ctx.artifactsDir)
        .filter((f) => /^feedback-\d+\.md$/.test(f))
        .sort();
      const latest = feedbacks[feedbacks.length - 1];
      if (latest !== undefined) {
        const feedbackPath = join(ctx.artifactsDir, latest);
        prompt = readFileSync(feedbackPath, "utf8");
      }
    }

    // Build SDK options object — only set keys whose values are defined
    // (exactOptionalPropertyTypes: never assign key: undefined).
    const options: Parameters<typeof query>[0]["options"] = {
      cwd: worktreePath,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
    };

    if (node.model === "haiku") {
      options.model = "claude-haiku-4-5";
    } else if (node.model === "sonnet") {
      options.model = "claude-sonnet-4-6";
    }
    // else: omit model → SDK default (unpinned)

    if (node.allowedTools !== undefined) {
      options.allowedTools = node.allowedTools;
    }
    if (node.maxBudget !== undefined) {
      options.maxBudgetUsd = node.maxBudget;
    }
    if (node.outputSchema !== undefined) {
      options.outputFormat = {
        type: "json_schema",
        schema: node.outputSchema,
      };
    }
    if (ctx.sessionId !== undefined && ctx.sessionId !== "") {
      options.resume = ctx.sessionId;
    }

    const q = query({ prompt, options });

    let finalSessionId = "";
    let totalCost = 0;
    let structuredOutput: unknown = undefined;
    let sdkError: string | null = null;

    for await (const msg of q) {
      if (msg.type === "result") {
        finalSessionId = msg.session_id;
        totalCost = msg.total_cost_usd;
        if (msg.subtype === "success" && "structured_output" in msg) {
          structuredOutput = msg.structured_output;
        }
        if (msg.subtype !== "success") {
          sdkError = msg.subtype;
        }
      }
    }

    if (sdkError !== null) {
      return {
        status: "failed",
        error: `SDK error: ${sdkError}`,
        retryable: sdkError !== "error_max_budget_usd",
      };
    }

    // classify node: write structured output to classify.json deterministically.
    // The runner owns this write — not the node (Theme 4).
    if (node.outputSchema !== undefined && structuredOutput !== undefined) {
      writeFileSync(
        join(ctx.artifactsDir, "classify.json"),
        JSON.stringify(structuredOutput, null, 2),
        "utf8",
      );
    }

    // Gated nodes always pause after completing — human approve marks them done.
    // The current iteration count = number of feedback files that exist now.
    if (node.gate !== undefined) {
      const feedbackCount = existsSync(ctx.artifactsDir)
        ? readdirSync(ctx.artifactsDir).filter((f) =>
            /^feedback-\d+\.md$/.test(f),
          ).length
        : 0;
      // Primary artifact path (first produces entry) for the gate preview.
      const primaryProduces = node.produces?.[0] ?? "artifact";
      return {
        status: "awaiting-gate",
        iteration: feedbackCount,
        sessionId: finalSessionId,
        artifactPath: join(ctx.artifactsDir, primaryProduces),
      };
    }

    return {
      status: "done",
      artifacts: [],
      cost: totalCost,
      sessionId: finalSessionId,
    };
  };
}
