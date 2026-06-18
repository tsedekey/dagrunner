/**
 * sdk-runner.ts — real SDK node executor (NodeExecutor interface).
 *
 * Key contracts:
 *   1. applyNodeEnv MUST be called BEFORE query() so hooks inherit env.
 *   2. Gated nodes ALWAYS return awaiting-gate (not done) after the query
 *      completes — the human approve step marks them done in run-engine.ts.
 *   3. On resume (ctx.sessionId set) + feedback present, feed feedback as the
 *      next user turn so Claude revises with full session memory (Theme 5).
 *   4. Structured output (outputSchema nodes) is written from SDK structured_output
 *      deterministically by the runner, not by the node itself.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type {
  NodeExecutor,
  NodeExecResult,
  ExecutionCtx,
} from "./mock-executor.js";
import type { Node } from "../core/types.js";
import type { DagrunnerConfig } from "../config/xdg.js";
import { applyNodeEnv, buildNodeEnv } from "./launcher.js";
import { readWorkProfileMcpServers } from "../config/settings-seed.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Collect full paths for node.produces files that exist on disk. */
function collectArtifacts(artifactsDir: string, produces: string[]): string[] {
  return produces
    .map((f) => join(artifactsDir, f))
    .filter((p) => existsSync(p));
}

/** Print a one-line progress update for a running node. */
function logProgress(nodeId: string, line: string): void {
  process.stdout.write(`[${nodeId}] ${line}\n`);
}

/** Truncate a string to maxLen chars, appending … if cut. */
function trunc(s: string, maxLen = 80): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

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
        const feedbackText = readFileSync(feedbackPath, "utf8").trim();
        const revisionBody =
          node.revisionInstruction !== undefined
            ? node.revisionInstruction.replace(
                /\{artifactsDir\}/g,
                ctx.artifactsDir,
              )
            : (() => {
                // Default: rewrite the primary artifact completely.
                const primaryArtifact = node.produces?.[0] ?? "artifact";
                const artifactFullPath = join(
                  ctx.artifactsDir,
                  primaryArtifact,
                );
                return `Incorporate this feedback and rewrite ${artifactFullPath} completely with the changes applied.`;
              })();
        prompt =
          `<reviewer-feedback>\n${feedbackText}\n</reviewer-feedback>\n\n` +
          revisionBody;
      }
    }

    // Build SDK options object — only set keys whose values are defined
    // (exactOptionalPropertyTypes: never assign key: undefined).
    // Runtime nodes run under the seeded settings.json permission model
    // (acceptEdits + sandbox). Do NOT bypass — the permission boundary must
    // exist before any node mutates the real repo (Phase 2a D1 requirement).
    const options: Parameters<typeof query>[0]["options"] = {
      cwd: worktreePath,
      permissionMode: "acceptEdits",
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
    };

    if (node.model === "haiku") {
      options.model = "claude-haiku-4-5-20251001";
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

    // Inject work-profile MCP servers (e.g. camunda-knowledge) via SDK options.
    // CREV_REPO_DIR is set to the worktree so semgrep/bpmn_lint see the agent's
    // actual working tree. Settings.json carry the allow/deny permissions.
    const workProfileMcp = readWorkProfileMcpServers(homedir(), worktreePath);
    if (Object.keys(workProfileMcp).length > 0) {
      options.mcpServers = workProfileMcp as NonNullable<
        (typeof options)["mcpServers"]
      >;
    }

    // Set CLAUDE_CONFIG_DIR so the agent session uses the configured Claude
    // profile (personal ~/.claude vs work ~/.claude-work). Must be set on
    // process.env BEFORE query() spawns — SDK inherits the current env.
    if (config.claudeConfigDir !== undefined) {
      process.env["CLAUDE_CONFIG_DIR"] = config.claudeConfigDir;
    }

    const q = query({ prompt, options });

    // Per-node transcript: captures the full message stream so the SIGINT
    // diagnostic (and dagrun logs <node>) shows why a node failed.
    const transcriptPath = join(ctx.artifactsDir, "transcript.log");

    let finalSessionId = "";
    let totalCost = 0;
    let structuredOutput: unknown = undefined;
    let sdkError: string | null = null;

    for await (const msg of q) {
      // Append every SDK message to the transcript (compact JSON, one per line).
      // Truncated to 8 KB per entry to keep the file manageable.
      const raw = JSON.stringify(msg);
      appendFileSync(
        transcriptPath,
        raw.length > 8192 ? raw.slice(0, 8192) + "…}\n" : raw + "\n",
        "utf8",
      );

      // Stream tool calls and assistant text to stdout so the user can follow progress.
      if (msg.type === "assistant") {
        const content = (
          msg as { type: "assistant"; message: { content: unknown[] } }
        ).message.content;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b["type"] === "tool_use") {
            const toolName = String(b["name"] ?? "");
            const input = (b["input"] ?? {}) as Record<string, unknown>;
            // Show the most informative single-line summary per tool type.
            const detail =
              typeof input["command"] === "string"
                ? trunc(input["command"])
                : typeof input["file_path"] === "string"
                  ? basename(input["file_path"])
                  : typeof input["description"] === "string"
                    ? trunc(input["description"])
                    : "";
            logProgress(
              nodeId,
              detail ? `→ ${toolName}(${detail})` : `→ ${toolName}`,
            );
          } else if (b["type"] === "text") {
            const text = String(b["text"] ?? "").trim();
            if (text.length > 0) {
              logProgress(nodeId, trunc(text, 120));
            }
          }
        }
      }

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

    // Structured output node: write SDK output deterministically (runner owns write, not node).
    if (node.outputSchema !== undefined && structuredOutput !== undefined) {
      const outFile = node.produces?.[0] ?? "output.json";
      writeFileSync(
        join(ctx.artifactsDir, outFile),
        JSON.stringify(structuredOutput, null, 2),
        "utf8",
      );
    }

    const produces = node.produces ?? [];

    // Gated nodes always pause after completing — human approve marks them done.
    // The current iteration count = number of feedback files that exist now.
    if (node.gate !== undefined) {
      const feedbackCount = existsSync(ctx.artifactsDir)
        ? readdirSync(ctx.artifactsDir).filter((f) =>
            /^feedback-\d+\.md$/.test(f),
          ).length
        : 0;
      // Primary artifact path (first produces entry) for the gate preview.
      const primaryProduces = produces[0] ?? "artifact";
      return {
        status: "awaiting-gate",
        iteration: feedbackCount,
        sessionId: finalSessionId,
        artifactPath: join(ctx.artifactsDir, primaryProduces),
        cost: totalCost,
      };
    }

    return {
      status: "done",
      artifacts: collectArtifacts(ctx.artifactsDir, produces),
      cost: totalCost,
      sessionId: finalSessionId,
    };
  };
}
