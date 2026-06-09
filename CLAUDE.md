# CLAUDE.md — dagrunner build (always-on context)

These rules are true on **every turn** of this build. Keep this file short; everything that is only
sometimes relevant lives in a skill, not here.

## What you are building
A thin **TypeScript** binary (`dagrun`) that orchestrates a DAG of Claude Code agent runs. It is a
**standalone project** in this folder — NOT the Camunda monorepo. One-shot v1 build.

## The reuse law (most important rule)
**Do not reinvent wheels. Lean on Claude Code.** Build only what has no native primitive that
survives across separate processes/worktrees: the DAG executor, conditional skip, checkpoint-and-exit
gates, worktree lifecycle, per-run artifacts. Everything inside a single agent run **reuses** Claude
Code (Agent SDK node execution, subagent fan-out, in-session Stop-hook loops, hooks, structured
output, session resume, slash-command prompts). When tempted to add a library, framework, or tool —
stop. The answer is almost always a native Claude Code mechanism.

## Tech stack (fixed — no additions)
- TypeScript + `@anthropic-ai/claude-agent-sdk`.
- Node.js built-ins only (`http`, `fs`, `path`, `child_process`, `crypto`). No Express, no frameworks.
- git + gh via native Bash. No git library.
- Static report = vanilla HTML string-templating. No React/Vite/Tailwind/build step.
- **Zero new dependencies.** If `package.json` needs a runtime dep beyond the SDK, you have taken a
  wrong turn — log it in `DECISIONS.md` and find the native path instead.

## Home layout (XDG, crev-derived)
- State/artifacts/worktrees/inbox/store: `~/.local/share/dagrunner/` (override via `DAGRUNNER_HOME`).
- Cache: `~/.cache/dagrunner/`. Binary: `~/.local/bin/dagrun`.
- Machine config: `~/.local/share/dagrunner/config.json`. `DEVHARNESS_SRC` is mandatory-explicit.
- Secrets live in env / keychain only — never written to the run tree, never logged.

## Engineering discipline
- **Fail loud, never silent.** No cwd fallback. No silent defaults for `DEVHARNESS_SRC`. A broken
  verifier script must FAIL the node — it must never look like success.
- **Typed at load.** Validate model strings, `dependsOn` references, and node IDs at load time.
  A typo is a load error, not a runtime surprise.
- **Artifacts are the only cross-node channel.** No hidden in-memory state passed between nodes.
- **Show evidence, don't assert.** End every unit of work with a runnable check, not a prose claim.
- **Minimal, not clever.** Over-engineering is a defect. The DAG core is ~25 lines — keep it that way.

## The env-propagation gotcha (do not get this wrong)
Hooks and child processes only inherit env set **before** the SDK `query()` is spawned. The launcher
must export `DEVHARNESS_SRC`, `DAGRUN_ARTIFACTS` (per-node), `DAGRUN_RUN_ID`, `DAGRUN_WORKTREE` BEFORE
spawning. A var set after spawn, or only inside a prompt, is invisible to the SessionStart sync and
artifact writes. Also: the SDK does NOT load `.claude/settings.json` (hooks/deny rules) unless
`settingSources: ["project"]` is set in `query()` options.

## Autonomy (this is an unattended overnight run)
- **Never block on ambiguity.** Pick the spec-aligned default, log it to `DECISIONS.md`, proceed.
- **Commit after every passing block.** `git commit -m "block N: <name>"`.
- **Isolate-and-continue on failure.** Retry once; if still failing, mark blocked, commit safe work,
  move to the next independent block. Never halt the whole run for one block.
- **You delegate, you do not implement.** Dispatch to the named subagent, verify its acceptance gate,
  sequence. Keep your own context to plan + state.

## Where design decisions live
The full locked design is the `architecture-spec` skill, chunked by theme. Load only the slice a
block needs. The build plan + sequencing is `HANDOFF.md`. Borrowed patterns are the `crev-patterns`
skill. Test protocol is the `testing-protocol` skill.
