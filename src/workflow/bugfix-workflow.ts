/**
 * bugfix-workflow.ts — bug fix pipeline workflow definition.
 *
 * Pipeline shape:
 *   reproduce (Gate 1) -> implement -> review -> fix (Gate 2) -> pr (Gate 3, pre-PR)
 *
 * There is no verify node (removed — DECISIONS.md § verify-node-removed): the
 * runtime hand-off it provisioned was skipped at the fix gate in practice.
 *
 * base_branch is read from plan frontmatter and stored in state.json;
 * run-engine wires it into the worktree start-point and the gh pr create call.
 */

import type { Workflow } from "../core/types.js";

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
      gate: {
        maxIterations: 5,
        onReject: "revise-self",
        amendTargets: ["fix"],
      },
    },
  ],
};
