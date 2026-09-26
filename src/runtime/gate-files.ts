/**
 * gate-files.ts — filesystem side of the companion-gate contract: the brief the
 * originating companion reads (`<gate>/gate.json` + `gate-context.md`), the
 * next-node decision artifact, and the config dirs searched for the companion's
 * session. Pure orchestration over core/gate.ts; imports nothing from
 * run-engine (run-engine imports this).
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { appendEvent, readEvents } from "../core/events.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DagrunnerConfig } from "../config/xdg.js";
import type { Workflow } from "../core/types.js";
import type { RunState } from "../core/state.js";
import {
  buildGateBrief,
  NEXT_NODE_DECISION_FILE,
  type GateBrief,
} from "../core/gate.js";

/** Config dirs that may hold the originating companion's transcript. */
export function sessionConfigDirs(
  config: DagrunnerConfig,
  state?: RunState,
): string[] {
  const dirs = [
    // The dir recorded at handoff wins: a bare terminal has no CLAUDE_CONFIG_DIR.
    state?.companion?.configDir,
    process.env["CLAUDE_CONFIG_DIR"],
    config.claudeConfigDir,
    join(homedir(), ".claude"),
  ].filter((d): d is string => typeof d === "string" && d !== "");
  return [...new Set(dirs)];
}

export function awaitingGateId(state: RunState): string | undefined {
  return Object.entries(state.nodes).find(
    ([, ns]) => ns.status === "awaiting-gate",
  )?.[0];
}

/** Build the brief for the paused gate and persist it (gate.json + gate-context.md). */
export function emitGateBrief(args: {
  runDir: string;
  state: RunState;
  workflow: Workflow;
  gateNodeId: string;
  config: DagrunnerConfig;
  configDirs?: string[];
}): GateBrief {
  const { runDir, state, workflow, gateNodeId, config } = args;
  const brief = buildGateBrief({
    runDir,
    state,
    workflow,
    gateNodeId,
    configDirs: args.configDirs ?? sessionConfigDirs(config, state),
  });
  // Gate-opened event (needs the revision, so it is emitted here, not derived
  // from the state diff). `gate show` re-emits the brief: log each revision once.
  const prior = readEvents(runDir).find(
    (e) => e.type === "gate.opened" && e.node === gateNodeId && e.detail?.["revision"] === brief.revision,
  );
  if (prior !== undefined) {
    brief.openedAt = prior.ts;
  } else {
    brief.openedAt = new Date().toISOString();
    appendEvent(runDir, {
      ts: brief.openedAt,
      type: "gate.opened",
      node: gateNodeId,
      iteration: brief.iteration,
      detail: { revision: brief.revision },
    });
  }
  const dir = join(runDir, gateNodeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gate.json"), JSON.stringify(brief, null, 2), "utf8");

  const primary = workflow.nodes.find((n) => n.id === gateNodeId)?.produces?.[0];
  const primaryPath = primary === undefined ? "" : join(dir, primary);
  const md = [
    `# Gate context — ${gateNodeId}`,
    ``,
    `**Run ID:** ${brief.runId}`,
    `**Gate:** ${gateNodeId} (iteration ${brief.iteration + 1})`,
    `**Revision:** ${brief.revision}`,
    `**Companion:** ${brief.companion.status}${brief.companion.blockedReason ? ` — ${brief.companion.blockedReason}` : ""}`,
    `**Approve continues to:** ${brief.pendingDecision.approveContinuesTo.join(", ") || "(end of run)"}`,
    `**Amend targets:** ${brief.pendingDecision.amendTargets.join(", ")}`,
    ...(brief.pendingDecision.decidesNode !== undefined
      ? [`**Approval also decides:** whether "${brief.pendingDecision.decidesNode}" runs (--run-next yes|no)`]
      : []),
    ...(brief.verifyEnvironment !== undefined
      ? [``, `## Verify environment`, `- ${brief.verifyEnvironment.status}: ${brief.verifyEnvironment.note}`]
      : []),
    ``,
    `## Evidence`,
    ...brief.gateArtifacts.map((f) => `- ${f.path} (${f.sha256.slice(0, 12)})`),
    ...brief.validation.map(
      (v) => `- validation ${v.nodeId}/${v.check}: ${v.ok ? "ok" : `FAILED — ${v.detail ?? ""}`}`,
    ),
    ``,
    `## Primary artifact`,
    ``,
    primaryPath !== "" && existsSync(primaryPath)
      ? readFileSync(primaryPath, "utf8")
      : "(artifact not found)",
  ].join("\n");
  writeFileSync(join(dir, "gate-context.md"), md, "utf8");
  return brief;
}

/** Terminal lines printed when a companion-mode run pauses at a gate. */
export function describeGatePause(brief: GateBrief): string {
  const lines = [
    `dagrun: PAUSED at gate "${brief.gateNodeId}" — revision ${brief.revision}`,
    brief.companion.status === "ok"
      ? `dagrun: return to the originating companion: ${brief.companion.resumeHint ?? `session ${brief.companion.sessionId}`}`
      : `dagrun: BLOCKED — ${brief.companion.blockedReason ?? "originating companion unavailable"}`,
    `dagrun: read: dagrun gate show ${brief.runId}   (nothing advances until \`dagrun gate decide … --confirm\`)`,
  ];
  return lines.join("\n") + "\n";
}

/** Persist a gate's decision about whether its `decidesNode` runs. */
export function writeNextNodeDecision(args: {
  runDir: string;
  gateNodeId: string;
  node: string;
  run: boolean;
  basis: string;
  revision?: string;
  decisionId?: string;
  focus?: string;
}): void {
  const dir = join(args.runDir, args.gateNodeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, NEXT_NODE_DECISION_FILE),
    JSON.stringify(
      {
        node: args.node,
        run: args.run,
        basis: args.basis,
        decidedAt: new Date().toISOString(),
        ...(args.revision !== undefined ? { revision: args.revision } : {}),
        ...(args.decisionId !== undefined ? { decisionId: args.decisionId } : {}),
        ...(args.focus !== undefined && args.focus.trim() !== "" ? { focus: args.focus.trim() } : {}),
      },
      null,
      2,
    ),
    "utf8",
  );
}
