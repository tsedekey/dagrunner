/**
 * feature-workflow.ts — feature pipeline workflow definition.
 *
 * Pipeline shape:
 *   define (Gate 1) -> implement -> review -> fix (Gate 2) -> verify -> pr (Gate 3, pre-PR)
 *
 * Parity with bugfix-workflow.ts (DECISIONS.md § feature-companion-gates-parity):
 * every gate (define, fix, pr) returns to the originating planning companion via
 * `dagrun gate show|decide` (`companionGates: true`). verify is OPTIONAL and is a
 * PROVISION-AND-HAND-OFF node (payload/commands/verify.md, shared with bugfix): build
 * the candidate from the worktree, run it on a local disposable target, write manual
 * verification steps, and STOP with the environment left running for Eddie to test by
 * hand. Whether it runs is decided by Eddie + the companion AT THE FIX GATE
 * (gate.decidesNode) and persisted as fix/next-node-decision.json, which verify's
 * `when` reads. See DECISIONS.md § companion-gates / § verify-runtime-demo.
 *
 * This is one of two workflows in v1 (the other is bugfix-workflow.ts). Additional
 * workflows are config additions on the proven engine.
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
        decidesNode: "verify",
      },
      revisionInstruction:
        "Review the feedback below and revise the code changes in the worktree accordingly. " +
        "Then update {artifactsDir}/summary.md to reflect all changes made (which findings were addressed, what files changed, what was deferred).",
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
    },
    // Optional provision-and-hand-off of a runtime for the human — same node/prompt as the
    // bugfix workflow (payload/commands/verify.md). Whether it runs is decided at
    // the fix gate (gate.decidesNode) and read from fix/next-node-decision.json.
    // Only PROVISIONED passes; see core/verify-evidence.ts. The pre-PR gate on `pr`
    // (added in DECISIONS.md § feature-companion-gates-parity) tears the environment
    // down when the human's verdict lands there, same as bugfix; `dagrun verify
    // cleanup <run-id>` remains the manual/retry path (see DECISIONS.md §
    // verify-provision-handoff).
    {
      id: "verify",
      dependsOn: ["fix"],
      command: "/verify",
      model: "sonnet",
      when: (ctx) =>
        readNextNodeDecision(
          ctx.read("fix", "next-node-decision.json"),
          "verify",
        ),
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
      // Pre-PR gate: pr only COMPOSES the body/meta in-session; push + draft-PR
      // creation happen in runPrPostProcess after this gate is approved, so the
      // human decision genuinely precedes publication (and sees verify's evidence).
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
