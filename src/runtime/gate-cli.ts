/**
 * gate-cli.ts — `dagrun gate show|decide|attach`: the interface the ORIGINATING
 * planning companion uses at a human gate.
 *
 *   show    read the brief (run, gate, revision, evidence, validation, pending decision)
 *   decide  two-step: without --confirm it only PROPOSES (prints the exact action
 *           statement + a decision id bound to run/gate/revision/action/scope);
 *           with --confirm <id> it executes. Understanding-only conversation can
 *           therefore never advance a run — only a deliberate confirm can.
 *   attach  record/replace the companion association (recovery path)
 *
 * All validation/binding lives in core/gate.ts; execution reuses resumeRun.
 */

import { cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { DagrunnerConfig } from "../config/xdg.js";
import { readState, writeState } from "../core/state.js";
import {
  buildGateBrief,
  decisionId,
  findAppliedDecision,
  findSessionConfigDir,
  validateGateRequest,
  type GateRequest,
} from "../core/gate.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";
import type { Workflow } from "../core/types.js";
import { awaitingGateId, emitGateBrief, sessionConfigDirs } from "./gate-files.js";
import { resumeRun } from "./run-engine.js";

function load(homeDir: string, runId: string) {
  const runDir = join(homeDir, "runs", runId);
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) return null;
  const state = readState(stateFile);
  const workflow: Workflow | undefined =
    state.workflow === "bugfix" ? bugfixWorkflow : state.workflow === "feature" ? featureWorkflow : undefined;
  if (workflow === undefined) return null;
  return { runDir, stateFile, state, workflow };
}

const err = (m: string): number => {
  process.stderr.write(`dagrun gate: ${m}\n`);
  return 1;
};

export function gateShow(args: {
  homeDir: string;
  config: DagrunnerConfig;
  runId: string;
  configDirs?: string[];
}): number {
  const r = load(args.homeDir, args.runId);
  if (r === null) return err(`run "${args.runId}" not found`);
  const gate = awaitingGateId(r.state);
  if (gate === undefined) {
    process.stdout.write(`dagrun gate: run "${args.runId}" is not paused at a gate (status: ${r.state.status})\n`);
    return 0;
  }
  const brief = emitGateBrief({
    runDir: r.runDir,
    state: r.state,
    workflow: r.workflow,
    gateNodeId: gate,
    config: args.config,
    ...(args.configDirs !== undefined ? { configDirs: args.configDirs } : {}),
  });
  process.stdout.write(JSON.stringify(brief, null, 2) + "\n");
  return 0;
}

/**
 * `dagrun gate open` — re-enter the ORIGINATING companion conversation with an
 * opening prompt that tells it a gate is waiting. User-initiated; it resumes the
 * recorded session, it never starts a new agent. Unverified: that resume keeps
 * the same session id (if not, `decide` will report session-mismatch).
 */
export function gateOpen(args: {
  homeDir: string;
  config: DagrunnerConfig;
  runId: string;
  configDirs?: string[];
  /** Operator override of the directory to resume from. */
  cwd?: string;
  /** Test seam. */
  spawn?: typeof spawnSync;
}): number {
  const r = load(args.homeDir, args.runId);
  if (r === null) return err(`run "${args.runId}" not found`);
  const gate = awaitingGateId(r.state);
  if (gate === undefined) return err(`run "${args.runId}" is not paused at a gate`);
  const brief = buildGateBrief({
    runDir: r.runDir,
    state: r.state,
    workflow: r.workflow,
    gateNodeId: gate,
    configDirs: args.configDirs ?? sessionConfigDirs(args.config, r.state),
  });
  const res = brief.companion.resume;
  if (brief.companion.status !== "ok" || res === undefined) {
    return err(brief.companion.blockedReason ?? "originating companion unavailable");
  }
  const cwd = args.cwd ?? res.cwd;
  if (cwd === null || !existsSync(cwd)) {
    return err(
      `no existing directory recorded for the session (last seen: ${res.cwd ?? "none"}). ` +
        `Re-run with --cwd <dir> (the directory the conversation now lives in), or cd there and run: claude --resume ${res.sessionId}`,
    );
  }
  emitGateBrief({ runDir: r.runDir, state: r.state, workflow: r.workflow, gateNodeId: gate, config: args.config, ...(args.configDirs !== undefined ? { configDirs: args.configDirs } : {}) });
  const out = (args.spawn ?? spawnSync)("claude", ["--resume", res.sessionId, res.prompt], {
    stdio: "inherit",
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: res.configDir },
  });
  if (out.error !== undefined) return err(`failed to launch claude: ${out.error.message}`);
  return out.status ?? 0;
}

/**
 * Plain `dagrun resume <run>` (no flags) on a companion-gate run: open the
 * originating conversation, as the old flow opened a gate session. Returns the
 * exit code when it handled the resume, or null to fall through to resumeRun
 * (legacy run, no awaiting gate, or not an interactive terminal — where
 * resumeRun just reports the pause).
 */
export function resumeOpensCompanion(args: {
  homeDir: string;
  config: DagrunnerConfig;
  runId: string;
  interactive: boolean;
  configDirs?: string[];
  spawn?: typeof spawnSync;
}): number | null {
  const r = load(args.homeDir, args.runId);
  if (r === null || r.state.companion === undefined || r.workflow.companionGates !== true) return null;
  if (awaitingGateId(r.state) === undefined || !args.interactive) return null;
  return gateOpen(args);
}

export type DecideArgs = {
  homeDir: string;
  config: DagrunnerConfig;
  runId: string;
  gate: string;
  revision: string;
  action: string;
  target?: string;
  comment?: string;
  runNext?: boolean;
  session?: string;
  confirm?: string;
  configDirs?: string[];
  executorFactory?: Parameters<typeof resumeRun>[0]["executorFactory"];
};

function statement(
  workflow: Workflow,
  brief: ReturnType<typeof buildGateBrief>,
  action: string,
  target: string,
  runNext: boolean | undefined,
): string {
  const g = brief.gateNodeId;
  if (action === "approve") {
    const decides = brief.pendingDecision.decidesNode;
    return (
      `APPROVE gate "${g}" (run ${brief.runId}, revision ${brief.revision}).` +
      (decides !== undefined ? ` Also decides: "${decides}" ${runNext ? "RUNS" : "is SKIPPED"}.` : "") +
      ` Then runs: ${brief.pendingDecision.approveContinuesTo.join(", ") || "(end of run)"}.` +
      (g === "pr" && workflow.nodes.some((n) => n.id === "pr")
        ? ` This PUSHES the branch and opens a DRAFT PR.`
        : "") +
      ` Not authorized by this: merge, reviewer requests, marking ready, backport labels.`
    );
  }
  if (action === "amend") {
    return `AMEND: revise "${target}" with your feedback and re-run everything downstream of it from fresh evidence; the run pauses again at the next gate.`;
  }
  return `HOLD at gate "${g}": record the reason, change nothing, stay paused.`;
}

export async function gateDecide(a: DecideArgs): Promise<number> {
  const r = load(a.homeDir, a.runId);
  if (r === null) return err(`run "${a.runId}" not found`);
  const req: GateRequest = {
    runId: a.runId,
    gate: a.gate,
    revision: a.revision,
    action: a.action,
    ...(a.target !== undefined ? { target: a.target } : {}),
    ...(a.comment !== undefined ? { comment: a.comment } : {}),
    ...(a.runNext !== undefined ? { runNext: a.runNext } : {}),
    ...(a.session !== undefined ? { session: a.session } : {}),
  };
  const id = decisionId(req);

  // Idempotence: the same decision, already applied, is a no-op — never a second advance.
  const applied = findAppliedDecision(r.state, id);
  if (applied !== null) {
    process.stdout.write(`dagrun gate: decision ${id} was already applied (recorded on "${applied.nodeId}") — no-op\n`);
    return 0;
  }

  const gate = awaitingGateId(r.state);
  if (gate === undefined) {
    return err(`refused [not-awaiting] run "${a.runId}" is not paused at a gate (status: ${r.state.status})`);
  }
  const brief = buildGateBrief({
    runDir: r.runDir,
    state: r.state,
    workflow: r.workflow,
    gateNodeId: gate,
    configDirs: a.configDirs ?? sessionConfigDirs(a.config, r.state),
  });
  const v = validateGateRequest({ state: r.state, workflow: r.workflow, brief, req });
  if (!v.ok) return err(`refused [${v.code}] ${v.message}`);

  if (a.confirm === undefined) {
    process.stdout.write(
      `PROPOSAL (nothing has changed):\n${statement(r.workflow, brief, v.action, v.target, a.runNext)}\n\n` +
        `Present exactly this to Eddie. Understanding, "continue explaining" or "looks good" does NOT release it.\n` +
        `Only an explicit go-ahead naming this action authorizes it — then re-run the same command with:\n` +
        `  --confirm ${id}\n`,
    );
    return 0;
  }
  if (a.confirm !== id) {
    return err(`refused [confirm-mismatch] --confirm ${a.confirm} does not match this exact decision (${id}); re-propose`);
  }

  await resumeRun({
    runId: a.runId,
    homeDir: a.homeDir,
    config: a.config,
    gateRequest: { ...req, decisionId: id },
    ...(a.configDirs !== undefined ? { sessionConfigDirs: a.configDirs } : {}),
    ...(a.executorFactory !== undefined ? { executorFactory: a.executorFactory } : {}),
  });
  return 0;
}

export function gateAttach(args: {
  homeDir: string;
  config: DagrunnerConfig;
  runId: string;
  session: string;
  reconstructed: boolean;
  replace: boolean;
  /** Re-copy dagrunner's bundled commands/agents into the run's worktree (.claude/, untracked seed). */
  reseed?: boolean;
  configDirs?: string[];
}): number {
  const r = load(args.homeDir, args.runId);
  if (r === null) return err(`run "${args.runId}" not found`);
  if (r.workflow.companionGates !== true) {
    return err(`workflow "${r.state.workflow}" has no companion gates`);
  }
  // A crashed process can leave status "running" with a node still awaiting its gate
  // (stale lock); what matters is that the run is genuinely waiting at a gate.
  if (awaitingGateId(r.state) === undefined) {
    return err(`run is "${r.state.status}" and no node is awaiting a gate — attach only while paused at a gate`);
  }
  const dirs = args.configDirs ?? sessionConfigDirs(args.config, r.state);
  const foundDir = findSessionConfigDir(args.session, dirs);
  if (foundDir === null) {
    return err(`session "${args.session}" has no transcript in ${dirs.join(", ")} — cannot attach an unreachable session`);
  }
  const cur = r.state.companion;
  if (cur !== undefined && cur.sessionId !== args.session && !args.replace) {
    const curOk = findSessionConfigDir(cur.sessionId, dirs) !== null;
    if (curOk) {
      return err(`run already has companion "${cur.sessionId}" (available). Pass --replace only with Eddie's agreement`);
    }
  }
  writeState(r.stateFile, {
    ...r.state,
    companion: {
      sessionId: args.session,
      configDir: foundDir,
      associatedAt: new Date().toISOString(),
      source: "attach",
      reconstructed: args.reconstructed,
    },
    updatedAt: new Date().toISOString(),
  });
  if (args.reseed === true) {
    // Same seed startRun/rerunNode perform. Needed to adopt a run created before the
    // prompts changed: its worktree still holds the old command copies.
    const root = new URL("../../", import.meta.url).pathname;
    for (const d of ["commands", "agents"]) {
      const src = join(root, "payload", d);
      if (existsSync(src)) cpSync(src, join(r.state.worktreePath, ".claude", d), { recursive: true });
    }
    process.stdout.write(`dagrun gate: re-seeded payload commands/agents into ${r.state.worktreePath}/.claude\n`);
  }
  process.stdout.write(
    `dagrun gate: attached ${args.reconstructed ? "RECONSTRUCTED " : ""}companion session ${args.session} to run ${args.runId}\n`,
  );
  return 0;
}
