/**
 * bugfix-workflow.ts — bug fix pipeline workflow definition.
 *
 * Pipeline shape:
 *   reproduce (Gate 1) -> implement -> review -> fix (Gate 2) -> verify -> pr
 *
 * verify (added by the verify-autonomy change — see DECISIONS.md
 * § verify-autonomy-bugfix-conditional): the unit/integration regression test
 * written in reproduce/guide.md and exercised during implement/fix does NOT
 * prove the fix holds at the @MultiDbTest acceptance-test layer. verify's
 * first step (unique to bugfix) searches the worktree's qa/acceptance-tests
 * for an EXISTING @MultiDbTest that already covers the user-facing flow the
 * bug touches (grounded from reproduce/guide.md); if found, it is reused
 * as-is (no new AT authored) and recorded in verify-plan.md. If none covers
 * it, verify authors one exactly as the feature workflow does. From there
 * (independent build+test rerun, run+classify, verify-report.json +
 * outcomeGate) the logic is identical to the feature workflow — see
 * payload/commands/verify.md, which is shared by both workflows.
 *
 * base_branch is read from plan frontmatter and stored in state.json;
 * run-engine wires it into the worktree start-point and the gh pr create call.
 */

import type { Workflow } from "../core/types.js";

export const bugfixWorkflow: Workflow = {
  name: "bugfix",
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
      gate: { maxIterations: 5, onReject: "revise-self" },
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
      dependsOn: ["fix", "verify"],
      command: "/pr",
      model: "haiku",
      produces: ["body.md"],
    },
  ],
};
