# dr-build brief: selectable runtime (claude | copilot), first user = the `review` node

Self-contained. Evidence for every claim below is in `SPIKE-REPORT.md` and the probe scripts next
to this file (probe1..4; re-runnable with `node`). Baseline: dagrunner v0.1.77, then bump.

## Goal

Let a node or a workflow choose its agent runtime: `"claude"` (today's `makeSDKRunner`, the
default) or `"copilot"` (new, GitHub Copilot SDK). Reason: spread usage between the Claude
Code enterprise subscription and the Copilot subscription. First use: the read-only `review`
node on Copilot. Everything else keeps running on Claude.

## Decisions already made by Eddie (do not re-litigate)

1. `runtime` is settable per node AND per workflow. Precedence: node > workflow > default
   `"claude"`. No machine-config default and no `--runtime` flag for now.
2. Dependency: `@github/copilot-sdk` as an OPTIONAL dependency, dynamically imported only when a
   copilot-runtime node actually runs. Log the exception to "zero new dependencies" in
   `DECISIONS.md`. A Claude-only user must never load or need it.
3. First node on Copilot: the whole `review` node (`id: "review"`, `command: "/review"`) in
   `src/workflow/bugfix-workflow.ts` and `src/workflow/feature-workflow.ts`. It is read-only and
   fans out the seven `payload/agents/reviewer-*.md` lenses as subagents INSIDE that node.
   Opt-in: ship the capability; set `runtime: "copilot"` on `review` only after the smoke check
   below passes. Do not touch other nodes.

## Scope (keep minimal, KISS)

- `src/core/types.ts`: add `Runtime = "claude" | "copilot"`; optional `runtime` on `Node` and on
  `Workflow`.
- Load-time validation (`loadWorkflow`, `src/workflow/workflow.ts`): reject unknown runtime
  values with a load error, like model strings.
- Router: in `run-engine.ts` the factory is `(config, runId, runDir, worktreePath, storeDir) =>
  NodeExecutor` and `NodeExecutor = (nodeId, node, ctx) => Promise<NodeExecResult>`. Add a
  small router executor that picks `makeSDKRunner` or `makeCopilotRunner` per node by the
  resolved runtime. Keep the existing `executorFactory` injection seam working (mock runs).
- `src/runtime/copilot-runner.ts` (new): `makeCopilotRunner(...)`: NodeExecutor. Requirements
  verified in the spike:
  - ONE `CopilotClient` per node execution; set the `DAGRUN_*` env BEFORE `client.start()`
    (env is process-wide at start; the env-propagation gotcha in CLAUDE.md applies).
  - `createSession({ model, workingDirectory: worktree, skillDirectories, agentDirectories,
    onPermissionRequest, hooks })`. `skillDirectories`/`agentDirectories` MUST be passed
    explicitly (pointing at the seeded worktree `.claude/skills` and `.claude/agents`);
    discovery alone does not load them.
  - Structured output via `sendAndWait({ prompt, responseSchema })` for `findings.json`.
  - Model mapping from dagrunner tiers to Copilot ids (e.g. opus -> `claude-opus-5.5`,
    sonnet -> `claude-sonnet-5.5`, haiku -> `claude-haiku-5.5`); validate at load.
  - Read-only permission policy for a read-only node (approve `read`; reject everything else).
    Night-mode/bypass equivalent is NOT built in this change.
  - Record session id in state so a gate can reopen with `copilot --resume <id>` (verified).
  - Usage: map `assistant.usage` events into `burn.json`; the unit is AI credits
    (`totalNanoAiu`), not USD. Make the unit explicit in the schema; do not fake dollars.
- `payload/commands/review.md` must be loadable by Copilot: Copilot does NOT load
  `.claude/commands`. Ship it as a skill (`payload/skills/review/SKILL.md`, seeded to the
  worktree `.claude/skills/`) that both runtimes can invoke as `/review`; keep the Claude path
  working. Check the `reviewer-*.md` agent frontmatter loads under Copilot `agentDirectories`
  (Claude-only frontmatter such as `tools:` may need care).
- Preflight (`src/cli/preflight.ts`): run the Claude checks (ANTHROPIC_API_KEY absent,
  CLAUDE_CONFIG_DIR) only when a Claude node exists; when a Copilot node exists, check the SDK
  resolves and `getAuthStatus().isAuthenticated`.
- Tests: load-time validation (bad runtime fails; precedence node > workflow > default),
  router dispatch, mock-executor path unchanged. Copilot SDK itself is faked in unit tests.

## Out of scope

Machine-config default, `--runtime` flag, moving any node other than `review`, translating
`.claude/settings.json` allow/deny wholesale, night-mode equivalent, parallel-client tuning.

## Acceptance (evidence, not assertion)

1. `npm test` (and the repo's existing check scripts) green; show the output.
2. A mock run with `runtime: "claude"` everywhere behaves exactly as before.
3. A live smoke on a throwaway worktree with `review` on Copilot produces a schema-valid
   `findings.json`; show the file, the Copilot session id, and the `burn.json` entry.
4. `package.json` version bumped from 0.1.77; `DECISIONS.md` (dependency exception, runtime
   precedence, review-on-Copilot) and `docs/dagrunner-master-architecture.md` reconciled in the
   same commit.

## Known unknowns to surface, not hide

Reject-path actually blocking a mutating tool; hooks that deny tool calls; ~35-minute runs and
parallel sessions; behaviour at a Copilot allowance limit (usage events do not expose it);
reviewer-agent frontmatter compatibility; skill vs command parity for `/review`.
