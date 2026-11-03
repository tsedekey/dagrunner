/**
 * feature-workflow.ts — feature pipeline workflow definition.
 *
 * Pipeline shape:
 *   define (Gate 1) -> implement -> review -> fix (Gate 2) -> pr (Gate 3, pre-PR)
 *
 * Parity with bugfix-workflow.ts (DECISIONS.md § feature-companion-gates-parity):
 * every gate (define, fix, pr) returns to the originating planning companion via
 * `dagrun gate show|decide` (`companionGates: true`). There is no verify node
 * (removed — DECISIONS.md § verify-node-removed).
 *
 * This is one of two workflows in v1 (the other is bugfix-workflow.ts). Additional
 * workflows are config additions on the proven engine.
 */

import type { Workflow } from "../core/types.js";

// ---------------------------------------------------------------------------
// findings.json JSON schema (dagrunner-owned; single source of truth)
// ---------------------------------------------------------------------------

export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    run_id: { type: "string" },
    timestamp: { type: "string" },
    triage: {
      type: "object",
      properties: {
        touches_public_api: { type: "boolean" },
        touches_runtime: { type: "boolean" },
        touches_schema_or_proto: { type: "boolean" },
        performance_sensitive: { type: "boolean" },
        touches_ui: { type: "boolean" },
      },
      required: [
        "touches_public_api",
        "touches_runtime",
        "touches_schema_or_proto",
        "performance_sensitive",
        "touches_ui",
      ],
      additionalProperties: false,
    },
    reviewers_run: { type: "array", items: { type: "string" } },
    reviewers_skipped: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "reason"],
        additionalProperties: false,
      },
    },
    adversarial_verifier_run: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          reviewer_dimension: { type: "string" },
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor", "nit"],
          },
          confidence: { type: "string", enum: ["high", "med", "low"] },
          file: { type: "string" },
          line: { type: "number" },
          claim: { type: "string" },
          grounded: { type: "boolean" },
        },
        required: [
          "reviewer_dimension",
          "severity",
          "confidence",
          "file",
          "line",
          "claim",
          "grounded",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "run_id",
    "timestamp",
    "triage",
    "reviewers_run",
    "reviewers_skipped",
    "adversarial_verifier_run",
    "findings",
  ],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// featureWorkflow
// ---------------------------------------------------------------------------

export const featureWorkflow: Workflow = {
  name: "feature",
  // Every gate (define, fix, pr) returns to the originating planning companion
  // via `dagrun gate show|decide` — see DECISIONS.md § companion-gates and
  // § feature-companion-gates-parity.
  companionGates: true,
  nodes: [
    {
      id: "define",
      command: "/define",
      model: "opus",
      produces: ["guide.md"],
      noPlaceholders: ["guide.md"],
      gate: { maxIterations: 10, onReject: "revise-self" },
    },
    {
      id: "implement",
      dependsOn: ["define"],
      command: "/implement",
      model: "sonnet",
      effort: "medium",
      produces: ["summary.md", "red-evidence.md"],
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
    },
    {
      id: "review",
      dependsOn: ["implement"],
      command: "/review",
      model: "opus",
      produces: ["findings.json"],
    },
    {
      id: "fix",
      dependsOn: ["review"],
      command: "/fix",
      model: "sonnet",
      effort: "medium",
      produces: ["summary.md"],
      gate: {
        maxIterations: 8,
        onReject: "revise-self",
      },
      revisionInstruction:
        "Review the feedback below and revise the code changes in the worktree accordingly. " +
        "Then update {artifactsDir}/summary.md to reflect all changes made (which findings were addressed, what files changed, what was deferred).",
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
    },
    {
      id: "pr",
      dependsOn: ["fix"],
      command: "/pr",
      model: "haiku",
      produces: ["body.md"],
      // Pre-PR gate: pr only COMPOSES the body/meta in-session; push + draft-PR
      // creation happen in runPrPostProcess after this gate is approved, so the
      // human decision genuinely precedes publication.
      // Parity with bugfix-workflow.ts's pr gate — see DECISIONS.md §
      // feature-companion-gates-parity: approving the fix gate no longer
      // auto-publishes; this gate's approval does.
      gate: {
        maxIterations: 5,
        onReject: "revise-self",
        amendTargets: ["fix"],
      },
    },
  ],
};
