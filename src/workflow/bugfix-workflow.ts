/**
 * bugfix-workflow.ts — bug fix pipeline workflow definition.
 *
 * Pipeline shape (shorter than feature — no verify node):
 *   reproduce (Gate 1) -> implement -> review -> fix (Gate 2) -> pr
 *
 * Regression testing is automated (runs during implement/fix), so no manual
 * verify step is needed. The PR node reuses the feature command unchanged.
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
      gate: { maxIterations: 10, onReject: "revise-self" },
    },
    {
      id: "implement",
      dependsOn: ["reproduce"],
      command: "/implement",
      model: "sonnet",
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
      produces: ["summary.md"],
      gate: { maxIterations: 5, onReject: "revise-self" },
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
    },
  ],
};
