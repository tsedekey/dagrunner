/**
 * feature-workflow.ts — v1 thin-slice workflow definition.
 *
 * Phase 2a pipeline:
 *   expand-guide (Gate 1) -> implement -> review -> fix (Gate 2)
 *
 * Phase 2b will add: verify-election -> verify-seed (Gate 3) -> pr -> reflect
 *
 * This is the ONLY workflow in v1. Additional workflows are config additions
 * on the proven engine.
 */

import type { Workflow } from "./types.js";

// ---------------------------------------------------------------------------
// classify.json JSON schema
// DORMANT — classify node removed from production pipeline in Phase 2a.
// Retained as a schema reference for Phase 5/6 revival as a task-type router.
// ---------------------------------------------------------------------------

export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    touches_public_api: { type: "boolean" },
    touches_runtime: { type: "boolean" },
    perf_sensitive: { type: "boolean" },
    touches_schema_or_proto: { type: "boolean" },
  },
  required: [
    "touches_public_api",
    "touches_runtime",
    "perf_sensitive",
    "touches_schema_or_proto",
  ],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

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
      },
      required: [
        "touches_public_api",
        "touches_runtime",
        "touches_schema_or_proto",
        "performance_sensitive",
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
  nodes: [
    {
      id: "expand-guide",
      command: "/expand-guide",
      produces: ["guide.md"],
      gate: { maxIterations: 10, onReject: "revise-self" },
    },
    {
      id: "implement",
      dependsOn: ["expand-guide"],
      command: "/implement",
      produces: ["summary.md"],
    },
    {
      id: "review",
      dependsOn: ["implement"],
      command: "/review",
      produces: ["findings.json"],
    },
    {
      id: "fix",
      dependsOn: ["review"],
      command: "/fix",
      produces: ["summary.md"],
      gate: { maxIterations: 5, onReject: "revise-self" },
      revisionInstruction:
        "Review the feedback below and revise the code changes in the worktree accordingly. " +
        "Then update {artifactsDir}/summary.md to reflect all changes made (which findings were addressed, what files changed, what was deferred).",
    },
  ],
};
