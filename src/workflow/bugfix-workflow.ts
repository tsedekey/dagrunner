/**
 * bugfix-workflow.ts — bug fix pipeline workflow definition.
 *
 * Pipeline shape:
 *   reproduce (Gate 1) -> implement -> review -> fix (Gate 2) -> verify -> pr (Gate 3, pre-PR)
 *
 * verify is OPTIONAL and no longer the MultiDbTest acceptance-test duplicate of CI.
 * It is (shared with the feature workflow) a PROVISION-AND-HAND-OFF node (payload/commands/verify.md): build
 * the candidate from the worktree, run it on a local disposable target, write manual
 * verification steps, and STOP with the environment left running for Eddie to test by hand. Whether it runs is decided
 * by Eddie + the companion AT THE FIX GATE (gate.decidesNode) and persisted as
 * fix/next-node-decision.json, which verify's `when` reads. See DECISIONS.md
 * § companion-gates / § verify-runtime-demo.
 *
 * base_branch is read from plan frontmatter and stored in state.json;
 * run-engine wires it into the worktree start-point and the gh pr create call.
 */

import type { Workflow } from "../core/types.js";
import { readNextNodeDecision } from "../core/gate.js";

export const bugfixWorkflow: Workflow = {
  name: "bugfix",
  // Every gate (reproduce, fix, pr) returns to the originating planning companion
  // via `dagrun gate show|decide` — see DECISIONS.md § companion-gates.
  companionGates: true,
  nodes: [
    {
      id: "reproduce",
      command: "/reproduce",
      model: "opus",
      produces: ["guide.md"],
      noPlaceholders: ["guide.md"],
      gate: { maxIterations: 10, onReject: "revise-self" },
    },
    {
      id: "implement",
      dependsOn: ["reproduce"],
      command: "/implement",
      model: "sonnet",
      effort: "medium",
      produces: ["summary.md"],
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
        maxIterations: 5,
        onReject: "revise-self",
        decidesNode: "verify",
      },
      revisionInstruction:
        "Review the feedback below and revise the code changes in the worktree accordingly. " +
        "Then update {artifactsDir}/summary.md to reflect all changes made (which findings were addressed, what files changed, what was deferred).",
      formatCommand: "./mvnw spotless:apply --no-transfer-progress",
    },
    {
      id: "verify",
      dependsOn: ["fix"],
      command: "/verify",
      model: "sonnet",
      // Runs only when the fix gate decided so. Missing decision artifact is a
      // loud error (never a silent skip/run): every approve path writes it.
      when: (ctx) =>
        readNextNodeDecision(
          ctx.read("fix", "next-node-decision.json"),
          "verify",
        ),
      produces: ["verify-report.json", "demo.md"],
      // Only a PROVISIONED report passes (environment up, handed to Eddie for manual
      // testing); BLOCKED_RUNTIME fails the node loudly. evidenceCheck rejects a
      // PROVISIONED claim that lacks candidate provenance / owned-resource inventory /
      // readiness (core/verify-evidence.ts). The environment is torn down when Eddie's
      // verdict lands at the pr gate (core/verify-cleanup.ts), not by this node.
      outcomeGate: {
        file: "verify-report.json",
        field: "outcome",
        passValues: ["PROVISIONED"],
      },
      evidenceCheck: "verify-runtime",
    },
    {
      id: "pr",
      dependsOn: ["fix", "verify"],
      // verify may be legitimately skipped (fix-gate decision) — a skipped verify
      // must not block pr; a FAILED verify still does (requiredFailed).
      joinRule: "none-failed-min-one-success",
      command: "/pr",
      model: "haiku",
      produces: ["body.md"],
      // Pre-PR gate: pr only COMPOSES the body/meta in-session; push + draft-PR
      // creation happen in runPrPostProcess after this gate is approved, so the
      // human decision genuinely precedes publication (and sees verify's evidence).
      gate: {
        maxIterations: 5,
        onReject: "revise-self",
        amendTargets: ["fix"],
      },
    },
  ],
};
