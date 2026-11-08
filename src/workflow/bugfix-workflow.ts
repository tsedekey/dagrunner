/**
 * bugfix-workflow.ts — bug fix pipeline workflow definition.
 *
 * Pipeline shape:
 *   implement -> review -> fix (gate) -> pr (gate, pre-PR)
 *
 * The plan is the guide (DECISIONS.md § plan-is-the-guide): the plan stage happens
 * upstream in a planning session whose approved plan file is the run's input
 * (<runDir>/plan/plan.md), so there is no reproduce node and no gate before
 * implement. `implement` takes over the one useful thing reproduce did — it proves
 * RED first and fails the run loudly (outcomeGate on red.json) when it cannot.
 * There is no verify node either (removed — DECISIONS.md § verify-node-removed).
 *
 * base_branch is read from plan frontmatter and stored in state.json;
 * run-engine wires it into the worktree start-point and the gh pr create call.
 */

import type { Workflow } from "../core/types.js";

export const bugfixWorkflow: Workflow = {
  name: "bugfix",
  // Every gate (fix, pr) returns to the originating planning companion
  // via `dagrun gate show|decide` — see DECISIONS.md § companion-gates.
  companionGates: true,
  nodes: [
    {
      id: "implement",
      command: "/implement",
      model: "sonnet",
      effort: "medium",
      // red.json is produced AND outcome-gated: produces runs first (a node that
      // wrote nothing is a contract violation), then the gate fails the node with
      // the precise `red = "not-reproduced"` error. implement therefore writes all
      // three files even when RED cannot be proven (see payload/commands/implement.md).
      produces: ["summary.md", "red-evidence.md", "red.json"],
      outcomeGate: { file: "red.json", field: "red", passValues: ["confirmed"] },
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
