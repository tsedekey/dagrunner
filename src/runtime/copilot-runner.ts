/**
 * copilot-runner.ts — node executor for runtime "copilot" (GitHub Copilot SDK).
 *
 * Same NodeExecutor contract as sdk-runner.ts; chosen per node by the router
 * (runtime-router.ts). Why it exists: spread usage between the Claude Code
 * enterprise subscription and the Copilot subscription. Spike evidence:
 * docs/copilot-runtime-spike/SPIKE-REPORT.md. Locked decisions:
 * DECISIONS.md § copilot-runtime.
 *
 * Contracts (each verified in the spike):
 *   1. ONE CopilotClient per node execution, and the DAGRUN_* env is exported
 *      BEFORE client.start() — the runtime process inherits env at start, so a
 *      later set is invisible to it (the env-propagation rule in CLAUDE.md).
 *   2. skillDirectories / agentDirectories are passed EXPLICITLY (the seeded
 *      worktree .claude/skills, and a model-adapted copy of .claude/agents —
 *      adaptAgentsForCopilot); discovery alone does not load them. Copilot does
 *      not load .claude/commands at all, which is why `/review` ships as a skill.
 *   3. `@github/copilot-sdk` is an OPTIONAL dependency, loaded by dynamic import
 *      only here, only when a copilot node runs. Nothing may import it statically
 *      (enforced by a test), so a Claude-only user never loads or needs it.
 *   4. Read-only node => read-only permission policy (makeReadOnlyPermissionHandler).
 *   5. Usage is AI credits (nano-AIU), written to burn.json as a distinct
 *      BurnDocCopilot; `cost` (USD) is 0 — dollars are never faked.
 *   6. The seeded .claude/settings.json hooks (deny-guard, session-start sync,
 *      session-end reflection capture) do NOT run under Copilot — a known gap.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  ExecutionCtx,
  NodeExecResult,
  NodeExecutor,
} from "./mock-executor.js";
import type { ModelTier, Node } from "../core/types.js";
import type { DagrunnerConfig } from "../config/xdg.js";
import { applyNodeEnv, buildNodeEnv } from "./launcher.js";
import { buildNodePrompt } from "./sdk-runner.js";
import {
  buildCopilotBurn,
  modelIdToTier,
  type CopilotUsageData,
} from "./burn.js";
import { FINDINGS_SCHEMA, validateFindings } from "../core/findings-schema.js";

// ---------------------------------------------------------------------------
// Minimal structural view of the Copilot SDK (so we need no static import)
// ---------------------------------------------------------------------------

export interface CopilotSessionLike {
  sessionId: string;
  sendAndWait(
    options: { prompt: string; responseSchema?: Record<string, unknown> },
    timeoutMs: number,
  ): Promise<{ data?: { content?: string } } | undefined>;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    statusMessage?: string;
  }>;
  listModels(): Promise<Array<{ id: string }>>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
}

export interface CopilotSdkModule {
  CopilotClient: new (options?: Record<string, unknown>) => CopilotClientLike;
}

export const COPILOT_SDK_PACKAGE = "@github/copilot-sdk";

/** Dynamic-import the optional SDK (the runner turns a failure into a loud install hint). */
export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  // Variable specifier: keeps tsc/bundlers from resolving it statically, so a
  // checkout without the optional dependency still builds and runs Claude nodes.
  const specifier: string = COPILOT_SDK_PACKAGE;
  return (await import(specifier)) as CopilotSdkModule;
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

/** dagrunner tier -> Copilot model id (ids verified against listModels in the spike). */
export const COPILOT_MODEL_IDS: Record<ModelTier, string> = {
  opus: "claude-opus-5.5",
  sonnet: "claude-sonnet-5.5",
  haiku: "claude-haiku-5.5",
};

/** Unpinned node (no tier) => undefined => the Copilot runtime's own default. */
export function copilotModelId(node: Pick<Node, "model">): string | undefined {
  return node.model === undefined ? undefined : COPILOT_MODEL_IDS[node.model];
}

// ---------------------------------------------------------------------------
// Agent adaptation
// ---------------------------------------------------------------------------

/**
 * The seeded reviewer agents pin Claude model ids in their frontmatter
 * (`model: claude-sonnet-4-6`). Copilot fails the subagent ("model … is not
 * available" — observed live: reviewer-test-adequacy, an always-run lens, was
 * skipped), so the runner points `agentDirectories` at an ADAPTED COPY where the
 * `model:` line is mapped by tier to the Copilot id (unmappable => line dropped,
 * the subagent inherits the session model). The seeded `.claude/agents` stay
 * byte-identical for the Claude runner. Only the frontmatter is touched.
 */
export function adaptAgentsForCopilot(
  srcDir: string,
  destDir: string,
): Array<{ file: string; from: string; to: string | null }> {
  mkdirSync(destDir, { recursive: true });
  const changes: Array<{ file: string; from: string; to: string | null }> = [];
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(join(srcDir, file), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    let out = text;
    if (m !== null) {
      const fm = m[1] ?? "";
      const modelLine = /^model:[ \t]*(.+?)[ \t]*$/m.exec(fm);
      if (modelLine !== null) {
        const from = modelLine[1] ?? "";
        const tier = modelIdToTier(from);
        const to = tier === "unknown" ? null : COPILOT_MODEL_IDS[tier];
        const newFm =
          to === null
            ? fm.replace(/^model:.*(\n|$)/m, "")
            : fm.replace(/^model:.*$/m, `model: ${to}`);
        out = `---\n${newFm}\n---\n` + text.slice(m[0].length);
        changes.push({ file, from, to });
      }
    }
    writeFileSync(join(destDir, file), out, "utf8");
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Read-only permission policy
// ---------------------------------------------------------------------------

/** The subset of the SDK's PermissionRequest this policy reads. */
export type CopilotPermissionRequest = {
  kind: string;
  path?: string;
  fileName?: string;
  resolvedPath?: string;
  commands?: Array<{ identifier: string; readOnly: boolean }>;
  /** One entry per simple command in a compound line (`a && b | c`); identifier is e.g. "git status" / "cat". */
  commandSegments?: Array<{ identifier: string; fullCommandText: string }>;
  hasWriteFileRedirection?: boolean;
  fullCommandText?: string;
};

export type PermissionDecision = {
  kind: string;
  decision: "approve" | "reject";
  detail: string;
};

/**
 * Read-only shell allowlist, matched on the runtime's own per-segment
 * `identifier` ("cat", "git status"). The runtime's `commands[].readOnly` flag
 * was observed FALSE even for `ls`/`cat`/`git status` (spike follow-up, live
 * smoke), so it cannot be the gate on its own. Deliberately small and
 * conservative: nothing that can write via flags (`sed -i`, `tee`, `uniq in out`,
 * `tree -o`, `xargs`, `awk`, `git branch <name>`, `git checkout` …).
 */
const READ_ONLY_SHELL = new Set([
  "cat",
  "ls",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "pwd",
  "cd",
  "echo",
  "printf",
  "sort",
  "diff",
  "file",
  "stat",
  "jq",
  "basename",
  "dirname",
  "realpath",
  "which",
  "true",
  "false",
  "test",
  "[",
  "cut",
  "nl",
  "tr",
  "find",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git rev-parse",
  "git ls-files",
  "git ls-tree",
  "git merge-base",
  "git blame",
  "git cat-file",
  "git rev-list",
  "git describe",
  "git shortlog",
  "git grep",
  "git for-each-ref",
  "git name-rev",
  "git diff-tree",
  "git show-ref",
]);

/** Constructs that execute or write regardless of the command name. */
const UNSAFE_SHELL_TEXT =
  /\$\(|`|<\(|>\(|--output\b|--pre\b|--ext-diff\b|--compress-program\b|--hostname-bin\b|--open-files-in-pager\b|\s-o\s|\s-o\S/;
/** `VAR=value cmd` — GIT_EXTERNAL_DIFF / GIT_PAGER / GIT_SSH_COMMAND … turn a read into code execution. */
const ENV_ASSIGNMENT_PREFIX = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;
/** git options that run configured programs: -c k=v (core.fsmonitor/pager/…), --config-env, --exec-path, grep -O<cmd>. */
const UNSAFE_GIT = /\s-c(\s|$)|\s--config-env\b|\s--exec-path\b|\s-O/;
const UNSAFE_FIND =
  /\s-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls|fprint0)\b/;

/**
 * True if the text redirects output to a file. The runtime's own
 * `hasWriteFileRedirection` flag was observed FALSE for `echo hi > evil2.txt`
 * (live probe: the file was created), so we check the text ourselves. Redirects
 * to /dev/null and fd duplication (`2>&1`) are fine; any other `>` is rejected
 * (conservative: a quoted `>` is rejected too).
 */
export function hasFileRedirect(text: string): boolean {
  const stripped = text
    .replace(/&?\d*>>?\s*\/dev\/null/g, "")
    .replace(/\d*>&\d+/g, "");
  return stripped.includes(">");
}

export function isReadOnlySegment(identifier: string, text: string): boolean {
  if (!READ_ONLY_SHELL.has(identifier)) return false;
  if (UNSAFE_SHELL_TEXT.test(text)) return false;
  if (ENV_ASSIGNMENT_PREFIX.test(text)) return false;
  if (identifier.startsWith("git ") && UNSAFE_GIT.test(text)) return false;
  if (identifier === "find" && UNSAFE_FIND.test(text)) return false;
  return true;
}

function isInside(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Permission policy for a read-only node (the `review` node):
 *   read   -> approve
 *   write  -> approve only inside the node's own artifactsDir (reflections.md etc.)
 *   shell  -> approve only if the runtime classifies EVERY command read-only and
 *             nothing redirects output to a file (git diff / cat / grep …)
 *   other  -> reject (mcp, url, memory, custom tools…)
 * Every decision is reported via onDecision (transcript evidence). The night-mode
 * / bypass equivalent is deliberately NOT built (DECISIONS.md § copilot-runtime).
 */
export function makeReadOnlyPermissionHandler(opts: {
  artifactsDir: string;
  worktreePath: string;
  onDecision?: (d: PermissionDecision) => void;
}): (
  req: CopilotPermissionRequest,
) => Promise<{ kind: "approve-once" } | { kind: "reject"; feedback: string }> {
  const decide = (
    req: CopilotPermissionRequest,
  ): { ok: boolean; detail: string; why: string } => {
    switch (req.kind) {
      case "read":
        return { ok: true, detail: req.path ?? "", why: "" };
      case "write": {
        const target =
          req.resolvedPath ??
          (req.fileName !== undefined
            ? resolve(opts.worktreePath, req.fileName)
            : "");
        return target !== "" && isInside(opts.artifactsDir, target)
          ? { ok: true, detail: target, why: "" }
          : {
              ok: false,
              detail: target,
              why: `this node is read-only; it may only write inside ${opts.artifactsDir}`,
            };
      }
      case "shell": {
        const cmds = req.commands ?? [];
        const segs = req.commandSegments ?? [];
        // Approve when the runtime itself classifies every command read-only, OR
        // every segment is on our read-only allowlist. Never with a file redirect.
        const runtimeSaysRo = cmds.length > 0 && cmds.every((c) => c.readOnly);
        const allowlisted =
          segs.length > 0 &&
          segs.every((g) => isReadOnlySegment(g.identifier, g.fullCommandText));
        const redirects =
          req.hasWriteFileRedirection === true ||
          hasFileRedirect(req.fullCommandText ?? "") ||
          segs.some((g) => hasFileRedirect(g.fullCommandText));
        const ro = (runtimeSaysRo || allowlisted) && !redirects;
        return {
          ok: ro,
          detail:
            req.fullCommandText ?? cmds.map((c) => c.identifier).join(" "),
          why: "this node is read-only; only read-only shell commands (cat, ls, grep, git diff/log/show/status …) without file redirection are allowed",
        };
      }
      default:
        return {
          ok: false,
          detail: "",
          why: `permission kind "${req.kind}" is not allowed in a read-only node`,
        };
    }
  };
  return async (req) => {
    const d = decide(req);
    opts.onDecision?.({
      kind: req.kind,
      decision: d.ok ? "approve" : "reject",
      detail: d.detail,
    });
    return d.ok
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: d.why };
  };
}

// ---------------------------------------------------------------------------
// Structured output registry
// ---------------------------------------------------------------------------

type StructuredSpec = {
  schema: Record<string, unknown>;
  /** Returns a list of problems; empty = valid. */
  validate: (doc: unknown) => string[];
  /**
   * Cross-check the document's claims against what the runner OBSERVED. A
   * mismatch is a retryable failure (model nondeterminism), not a config error.
   */
  crossCheck?: (doc: unknown, observed: { subagentStarts: number }) => string[];
};

/**
 * A findings.json that lists N reviewers in `reviewers_run` is only believable if
 * at least N subagents actually started in this session. Observed live: with a
 * small diff the model sometimes reviewed inline and still wrote a plausible,
 * schema-valid reviewers_run (0 subagents started). Schema-valid is not proof the
 * review fanned out, so the claim is attested against the observed count.
 */
export function crossCheckFindings(
  doc: unknown,
  observed: { subagentStarts: number },
): string[] {
  const run = (doc as { reviewers_run?: unknown }).reviewers_run;
  const claimed = Array.isArray(run) ? run.length : 0;
  return observed.subagentStarts < claimed
    ? [
        `findings.json claims ${claimed} reviewer(s) run but only ${observed.subagentStarts} subagent(s) started in the session — the review was not actually fanned out`,
      ]
    : [];
}

/**
 * Which produced artifact is obtained via Copilot structured output (the runner
 * writes it, so the model cannot get the shape wrong or hit the read-only write
 * policy). Keyed by the node's primary produces file so the Claude path — where
 * the node's command writes the file itself — is untouched. A node's own
 * `outputSchema` takes precedence (JSON parse only, like sdk-runner).
 */
const STRUCTURED_BY_PRODUCES: Record<string, StructuredSpec> = {
  "findings.json": {
    schema: FINDINGS_SCHEMA,
    validate: validateFindings,
    crossCheck: crossCheckFindings,
  },
};

export function structuredSpecFor(node: Node): StructuredSpec | undefined {
  if (node.outputSchema !== undefined) {
    return { schema: node.outputSchema, validate: () => [] };
  }
  const primary = node.produces?.[0];
  return primary !== undefined ? STRUCTURED_BY_PRODUCES[primary] : undefined;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** A failure retrying cannot fix (config, auth, schema, timeout). */
class FatalError extends Error {}

/** A review runs ~35 min (spike notes); the SDK's own default is 60 s. */
export const COPILOT_TURN_TIMEOUT_MS = 90 * 60_000;

function trunc(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function makeCopilotRunner(
  config: DagrunnerConfig,
  runId: string,
  runDir: string,
  worktreePath: string,
  storeDir: string,
  deps: {
    loadSdk?: () => Promise<CopilotSdkModule>;
    turnTimeoutMs?: number;
  } = {},
): NodeExecutor {
  return async function copilotRunner(
    nodeId: string,
    node: Node,
    ctx: ExecutionCtx,
  ): Promise<NodeExecResult> {
    const fail = (error: string, retryable: boolean): NodeExecResult => ({
      status: "failed",
      error,
      retryable,
    });

    // Env BEFORE the client (and its runtime process) starts.
    applyNodeEnv(
      buildNodeEnv(config, runId, nodeId, runDir, worktreePath, storeDir),
    );
    // Snapshot the env in the SAME synchronous turn as applyNodeEnv and hand it to
    // the client explicitly: process.env is shared by parallel nodes and we await
    // (SDK import, auth) before the runtime process is spawned, so relying on
    // process.env at spawn time could pick up a sibling node's DAGRUN_* values.
    const runtimeEnv = { ...process.env };
    mkdirSync(ctx.artifactsDir, { recursive: true });

    // Explicit skill/agent dirs (discovery alone does not load them) — fail
    // loud if the seed is missing rather than running with no /review skill.
    const skillsDir = join(worktreePath, ".claude", "skills");
    const agentsDir = join(worktreePath, ".claude", "agents");
    for (const [label, dir] of [
      ["skills", skillsDir],
      ["agents", agentsDir],
    ] as const) {
      if (!existsSync(dir)) {
        return fail(
          `copilot runtime: seeded ${label} directory missing at ${dir} — the worktree was not seeded (package installation or seeding broken)`,
          false,
        );
      }
    }

    let sdk: CopilotSdkModule;
    try {
      sdk = await (deps.loadSdk ?? loadCopilotSdk)();
    } catch (e) {
      return fail(
        `copilot runtime: cannot load ${COPILOT_SDK_PACKAGE} (optional dependency, needed only for runtime "copilot" nodes). ` +
          `Run: npm install  (do not use --omit=optional). Cause: ${e instanceof Error ? e.message : String(e)}`,
        false,
      );
    }

    const transcriptPath = join(ctx.artifactsDir, "transcript.log");
    const log = (obj: unknown): void => {
      const raw = JSON.stringify(obj);
      appendFileSync(
        transcriptPath,
        raw.length > 8192 ? raw.slice(0, 8192) + "…}\n" : raw + "\n",
        "utf8",
      );
    };
    const progress = (line: string): void => {
      process.stdout.write(`[${nodeId}] ${line}\n`);
    };

    const usage: CopilotUsageData[] = [];
    let subagentStarts = 0;
    let sessionId = "";
    const spec = structuredSpecFor(node);
    const timeoutMs = deps.turnTimeoutMs ?? COPILOT_TURN_TIMEOUT_MS;

    // Adapted agents copy (see adaptAgentsForCopilot); removed in `finally`.
    const adaptedAgentsRoot = mkdtempSync(join(tmpdir(), "dagrun-copilot-agents-"));
    const adaptedAgentsDir = join(adaptedAgentsRoot, "agents");
    const client = new sdk.CopilotClient({ env: runtimeEnv });
    let session: CopilotSessionLike | undefined;
    let outcome: NodeExecResult;
    try {
      for (const c of adaptAgentsForCopilot(agentsDir, adaptedAgentsDir)) {
        log({ type: "dagrun.agent-adapted", ...c });
      }
      await client.start();

      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw new FatalError(
          `copilot runtime: not authenticated${auth.statusMessage ? ` (${auth.statusMessage})` : ""}. Log in with the Copilot CLI (\`copilot\` then /login) or set a GitHub token.`,
        );
      }

      const model = copilotModelId(node);
      if (model !== undefined) {
        const available = (await client.listModels()).map((m) => m.id);
        if (!available.includes(model)) {
          throw new FatalError(
            `copilot runtime: model "${model}" (tier "${node.model}") is not available on this Copilot plan. Available: ${available.join(", ")}`,
          );
        }
      }

      session = await client.createSession({
        ...(model !== undefined ? { model } : {}),
        workingDirectory: worktreePath,
        skillDirectories: [skillsDir],
        agentDirectories: [adaptedAgentsDir],
        onPermissionRequest: makeReadOnlyPermissionHandler({
          artifactsDir: ctx.artifactsDir,
          worktreePath,
          onDecision: (d) => {
            log({ type: "dagrun.permission", ...d });
            if (d.decision === "reject")
              progress(
                `✗ permission rejected: ${d.kind} ${trunc(d.detail, 80)}`,
              );
          },
        }),
        hooks: {
          onPreToolUse: async (input: { toolName?: string }) => {
            progress(`→ ${input.toolName ?? "tool"}`);
          },
          onSubagentStart: async () => {
            subagentStarts += 1;
          },
        },
        onEvent: (e: { type: string; data?: Record<string, unknown> }) => {
          log(e);
          if (e.type === "assistant.usage" && e.data !== undefined) {
            usage.push(e.data as unknown as CopilotUsageData);
          }
        },
      });
      sessionId = session.sessionId;

      // Reuse the Claude prompt assembly: `<command> <run-environment block>`
      // (a gate-resume sessionId is never passed — gated nodes are rejected at load).
      const { sessionId: _ignored, ...ctxNoSession } = ctx;
      void _ignored;
      let prompt = buildNodePrompt(node, ctxNoSession, worktreePath);
      if (spec !== undefined) {
        prompt +=
          `\n\n<runtime-note>Your FINAL reply must be exactly the JSON document for ${node.produces?.[0] ?? "the output file"} ` +
          `(it is constrained by the required response schema). dagrunner writes that file itself from your reply; do not write it yourself. ` +
          `Any subagent dispatch the instructions require is still mandatory and is verified against the session's subagent count.</runtime-note>`;
      }

      let reply;
      try {
        reply = await session.sendAndWait(
          spec !== undefined
            ? { prompt, responseSchema: spec.schema }
            : { prompt },
          timeoutMs,
        );
      } catch (e) {
        if (e instanceof Error && /^Timeout after/.test(e.message)) {
          await session.abort().catch(() => undefined);
          throw new FatalError(
            `copilot runtime: ${e.message} (aborted; not retried)`,
          );
        }
        throw e;
      }

      if (spec !== undefined) {
        const content = reply?.data?.content;
        let doc: unknown;
        try {
          doc = JSON.parse(content ?? "");
        } catch {
          throw new FatalError(
            `copilot runtime: structured reply is not valid JSON: ${trunc(String(content), 200)}`,
          );
        }
        const problems = spec.validate(doc);
        if (problems.length > 0) {
          throw new FatalError(
            `copilot runtime: structured reply failed schema validation: ${problems.slice(0, 5).join("; ")}`,
          );
        }
        const mismatch = spec.crossCheck?.(doc, { subagentStarts }) ?? [];
        if (mismatch.length > 0) {
          // Plain Error => retryable: the next attempt may actually fan out.
          throw new Error(mismatch.join("; "));
        }
        writeFileSync(
          join(ctx.artifactsDir, node.produces?.[0] ?? "output.json"),
          JSON.stringify(doc, null, 2),
          "utf8",
        );
      }

      const artifacts = (node.produces ?? [])
        .map((f) => join(ctx.artifactsDir, f))
        .filter((p) => existsSync(p));
      outcome = { status: "done", artifacts, cost: 0, sessionId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcome = fail(
        e instanceof FatalError ? msg : `copilot runtime error: ${msg}`,
        !(e instanceof FatalError),
      );
    } finally {
      if (session !== undefined)
        await session.disconnect().catch(() => undefined);
      await client.stop().catch(() => undefined);
      rmSync(adaptedAgentsRoot, { recursive: true, force: true });
    }

    // Observability (independent try/catch: never block or mask the node result).
    try {
      appendFileSync(
        join(runDir, "friction.jsonl"),
        JSON.stringify({
          ts: new Date().toISOString(),
          node: nodeId,
          sessionId,
          event: "session-end",
          runtime: "copilot",
        }) + "\n",
        "utf8",
      );
    } catch {
      // observability-only
    }
    try {
      writeFileSync(
        join(ctx.artifactsDir, "burn.json"),
        JSON.stringify(
          buildCopilotBurn({ node: nodeId, sessionId, subagentStarts, usage }),
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // observability-only
    }

    return outcome;
  };
}
