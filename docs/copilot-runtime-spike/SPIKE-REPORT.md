# Copilot SDK feasibility spike for Dagrunner (2026-10-22)

## Process: who builds this?

- The spike (this folder) is throwaway scratchpad code. Nothing in `~/dev/dagrunner` or the
  Camunda repo was changed, so it did not need `dr-build`.
- The runtime switch IS a Dagrunner self-change. Per Dagrunner's `CLAUDE.md`: agree the change
  in conversation first, then implement inline or delegate to the `dr-build` agent. It also
  bumps the version and reconciles `DECISIONS.md` + `docs/dagrunner-master-architecture.md`.
- `dr-build` and `sdk-researcher` live in `~/dev/dagrunner/.claude/agents/`, so that step must
  run from a session started in `~/dev/dagrunner`. They are not available from the Camunda
  session. This file is in a session-scoped scratchpad; copy it before that session.

## Setup

`@github/copilot-sdk@1.0.25` (runtime 1.0.102), installed only in `../copilot-sdk-spike/`.
Scripts (re-runnable): `probe1-models.mjs`, `probe2-session.mjs`, `probe3-claude-dir.mjs`
(superseded by probe 4), `probe4-strict.mjs`. Model used: `claude-haiku-5.5`. Each result is n=1.

## Verified live

| Question | Result | Probe |
|---|---|---|
| SDK reuses the existing Copilot login | Yes | 1 |
| Claude models on this plan | Yes: sonnet-5.5, sonnet-5, opus-5.5, opus-5, opus-4.8, haiku-5.5 (all enabled) | 1 |
| Structured output | Yes: `responseSchema` returned `{"magic": 4217}` | 2 |
| Resume in SDK | Yes: recalled the value with 0 tool calls | 2 |
| Resume from the CLI | Yes: `copilot --resume <sdk-session-id> -p ...` answered 4217, so gates can reopen with `copilot --resume` | 2 + CLI |
| Hooks | Yes: sessionStart, preTool/postTool, agentStop, sessionEnd, subagentStart | 2, 4 |
| Permission callback | Yes: read approved; with everything rejected, 0 rejections were needed for skill/agent loading | 2, 4 |
| Env set before `client.start()` reaches a shell tool call | Yes (`DAGRUN_SPIKE_VAR` echoed). Env is process-wide at start, so per-node env means one `CopilotClient` per node | 4 |
| Skill in `.claude/skills` | Only with explicit `skillDirectories`. Discovery alone did NOT load it (probe 3's "yes" was the model reading the file) | 4 |
| Agent in `.claude/agents` | Only with explicit `agentDirectories`: real `task` subagent started, replied `AGENT_LOADED_99` | 4 |
| `.claude/commands/*.md` slash commands | NO (empty reply). Convert to skills | 3 |
| Usage data | Tokens per type + `totalNanoAiu` (AI credits), no USD. `aiCreditsStatus: complete`; `accounting` has IDs only, no limit/remaining | 2, 4 |

## Not tested

- Permission reject path blocking a mutating tool; hooks that deny a tool call.
- Parallel sessions/clients; runs near 35 min; behaviour on a rate-limit or allowance hit.
- `.claude/settings.json` allow/deny (Claude-specific; translate to SDK options).
- Night-mode equivalent of `bypassPermissions`.
- Mapping nano-AIU to the plan's allowance (the limit is still unknown).
- Other Claude models (only haiku-5.5 was run).

## Proposal (not decided)

Smallest version that meets the requirement:

- A `runtime: "claude" | "copilot"` field on a node AND on a workflow (DECIDED by Eddie:
  per-workflow setting). Precedence: node > workflow > default `"claude"`. Validated at load
  time. A small router executor behind the existing `executorFactory` seam (`run-engine.ts`)
  dispatches to `makeSDKRunner` or a new `makeCopilotRunner`.
- Add only when needed: machine-config default, `--runtime` flag.
- Copilot runner: one `CopilotClient` per node (env), `skillDirectories` + `agentDirectories`
  pointing at the seeded worktree, translate hooks/permissions, record AIU in `burn.json`.
- Pipeline commands become skills (one source for both runtimes).
- Dependency: `CLAUDE.md` forbids new dependencies. Options: optional, dynamically imported
  `@github/copilot-sdk` (log in `DECISIONS.md`), or shell out to `copilot -p`.
- Preflight checks only the selected runtime's prerequisites.

## Design questions for Eddie (one at a time)

1. Granularity: DECIDED: per-node plus per-workflow.
2. Dependency: DECIDED (Eddie): Option A, optional dynamically imported
   `@github/copilot-sdk` (log in `DECISIONS.md` as an exception to zero-new-dependencies).
3. First node to move to Copilot. Eddie said "one reviewer lens in review". FINDING: the lenses
   (`payload/agents/reviewer-*.md`) are subagents fanned out INSIDE the single `review` DAG node
   (`src/workflow/{bugfix,feature}-workflow.ts`, id "review"), not nodes of their own. A single
   lens cannot get its own `runtime` without a structural change. OPEN: pick between
   (a) `runtime: copilot` on the whole read-only `review` node, (b) split one lens into its own
   node, (c) add a parallel report-only shadow node running one lens on Copilot for comparison.
   DECIDED (Eddie): (a). Brief for dr-build: `DR-BUILD-BRIEF.md` in this folder.

## Re-running the probes

`probes/*.mjs` import the SDK from an absolute path inside the original session scratchpad
(`SDK` constant at the top of each file). To re-run: `npm install @github/copilot-sdk@1.0.25`
in an empty directory outside this repo and point `SDK` at its `dist/index.js`. Do not add the
SDK to this repo's `package.json` for that purpose.

## Follow-up from the build (dagrunner v0.1.78)

Run from the repo root (`node --import tsx docs/copilot-runtime-spike/probes/<file>.mts`; they import
`src/runtime/copilot-runner.ts` and the repo's `node_modules/@github/copilot-sdk`). n=1-2 each.

- `probe5-reject-hook-parallel.mts`: reject path blocked `create`; a `preToolUse` hook returning
  `{permissionDecision:"deny"}` blocked a read (secret did not leak); 3 parallel clients all completed.
- `probe5c-reject-per-step.mts` (fresh session per step): `touch`, `rm`, `git init`, `echo > f`, `cat > f`
  rejected, no file appeared/changed; `ls` approved; a write inside the artifacts dir approved. A first
  version of the policy let `echo hi > evil2.txt` through (the runtime's `hasWriteFileRedirection` was
  false) -- fixed in the policy and regression-tested.
- `smoke-review-on-copilot.mts`: the real `review` skill + 7 reviewer agents on a throwaway repo via the
  router. Findings: shell `commands[].readOnly` is false even for `ls`/`cat`; the pinned
  `model: claude-sonnet-4-6` agents fail on Copilot (adapted per run); a small diff can make the model skip
  the subagents (cross-checked against the observed subagent count). Passing run: 4 subagents, 8
  schema-valid findings, 36,123,570,000 nano-AIU (the Copilot CLI footer printed "AI Credits 36.57" for it:
  1 credit = 1e9 nano-AIU); `copilot --resume <session id>` answered "8" when asked its finding count.
- `smoke-review-on-claude.mts` (set `BASELINE=1` for the pre-change command): the same node on the Claude
  runner, no override. Needs a TRUSTED workspace (a git worktree of the trusted scratch repo
  `~/tmp/toy-src`, cleaned up on exit) -- Claude Code ignores a project's settings.json permissions in an
  untrusted dir, which broke an earlier /tmp attempt identically for the old and new prompt. Result: the
  model wrote a schema-valid findings.json, 4 Agent subagents, 0 permission denials.
- Final Copilot run on the committed prompt: session 03383e99-a1c6-41fa-a9b0-f37b0afaccfd, 3 subagents,
  10 schema-valid findings, 41,718,480,000 nano-AIU.
- Still not tested: 35-minute runs, behaviour at an allowance limit, other models beyond opus/sonnet/haiku
  5.5 in a full review.
