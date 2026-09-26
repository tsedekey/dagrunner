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
import { readNextNodeDecision } from "../core/gate.js";

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
      gate: { maxIterations: 8, onReject: "revise-self", decidesNode: "verify" },
      revisionInstruction:
        "Review the feedback below and revise the code changes in the worktree accordingly. " +
        "Then update {artifactsDir}/summary.md to reflect all changes made (which findings were addressed, what files changed, what was deferred).",
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
    },
    // Optional provision-and-hand-off of a runtime for the human — same node/prompt as the
    // bugfix workflow (payload/commands/verify.md). Whether it runs is decided at
    // the fix gate (gate.decidesNode) and read from fix/next-node-decision.json.
    // Only PROVISIONED passes; see core/verify-evidence.ts. NOTE: this workflow has no
    // pre-PR gate, so nothing tears the environment down on a verdict — cleanup is
    // `dagrun verify cleanup <run-id>` (see DECISIONS.md § verify-provision-handoff).
    {
      id: "verify",
      dependsOn: ["fix"],
      command: "/verify",
      model: "sonnet",
      when: (ctx) =>
        readNextNodeDecision(ctx.read("fix", "next-node-decision.json"), "verify"),
      produces: ["verify-report.json", "demo.md"],
      outcomeGate: {
        file: "verify-report.json",
        field: "outcome",
        passValues: ["PROVISIONED"],
      },
      evidenceCheck: "verify-runtime",
    },
    {
      id: "pr",
      dependsOn: ["fix", "verify"], // verify may be skipped by the fix-gate decision; a FAILED verify still blocks pr
      joinRule: "none-failed-min-one-success",
      command: "/pr",
      model: "haiku",
      produces: ["body.md"],
    },
    // Terminal-adjacent, informational, read-only — same deps as pr so it runs
    // in parallel with pr and adds no wall-clock time (see DECISIONS.md §
    // digest-node). Synthesizes a bottom-up knowledge map of what was
    // implemented (and why) from the already-written run artifacts, grounded
    // in the diff/summaries/findings rather than the plan — so Eddie has full
    // context before reviewing the PR or reading pr-triage's drafted replies.
    // No gate (same read-only pattern as review); sonnet, not opus — this is
    // synthesis of already-written artifacts, not adversarial judgment.
    // optional: true — informational-only; a produces-contract violation here
    // (e.g. an untested new prompt file hitting the $DAGRUN_* probe wall) must
    // degrade to 'skipped', never fail a run whose PR already shipped via pr.
    // See DECISIONS.md § digest-node.
    {
      id: "digest",
      dependsOn: ["fix", "verify"],
      joinRule: "none-failed-min-one-success",
      command: "/digest",
      model: "sonnet",
      produces: ["knowledge-map.md"],
      optional: true,
    },
  ],
};
