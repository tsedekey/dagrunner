/**
 * feature-workflow.ts — v1 thin-slice workflow definition.
 *
 * Phase 2a pipeline:
 *   define (Gate 1) -> implement -> review -> fix (Gate 2)
 *
 * Phase 2b (autonomous verify — see the verify-autonomy change, DECISIONS.md
 * § verify-autonomy-remove-election) adds: verify -> pr (terminal). verify is
 * a required, blocking, fully autonomous node — it authors and runs its own
 * @MultiDbTest acceptance test, independently reruns build+tests, and gates
 * pr via outcomeGate on verify-report.json's `outcome` field. No human
 * election, no manual-test gate — see payload/commands/verify.md.
 *
 * This is the ONLY workflow in v1. Additional workflows are config additions
 * on the proven engine.
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
      gate: { maxIterations: 8, onReject: "revise-self" },
      revisionInstruction:
        "Review the feedback below and revise the code changes in the worktree accordingly. " +
        "Then update {artifactsDir}/summary.md to reflect all changes made (which findings were addressed, what files changed, what was deferred).",
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
    },
    // Autonomous acceptance-test author/runner/judge/gate — no human election,
    // no Gate 3. Required and blocking: a non-PASS outcome fails this node via
    // outcomeGate, which halts the run and blocks pr (same as a produces
    // violation). See payload/commands/verify.md for the full flow (D2-D6 of
    // the verify-autonomy change).
    {
      id: "verify",
      dependsOn: ["fix"],
      command: "/verify",
      model: "sonnet",
      // verify-plan.md is conditional, not unconditional — payload/commands/verify.md's
      // legitimate short-circuit paths (Docker unreachable at Step 0; unrecoverable
      // stall with no usable report, ERROR_INFRA) explicitly instruct "Do NOT write a
      // verify-plan.md — no authoring work happened." Only verify-report.json is
      // load-bearing here; it remains gated via outcomeGate below. See DECISIONS.md
      // § verify-run-56962-1-forensics.
      produces: ["verify-report.json"],
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
      outcomeGate: {
        file: "verify-report.json",
        field: "outcome",
        passValues: ["PASS"],
      },
    },
    {
      id: "pr",
      dependsOn: ["fix", "verify"], // fix ensures worktree is ready; verify is required (non-optional) and gates pr
      command: "/pr",
      model: "haiku",
      produces: ["body.md"],
    },
  ],
};
