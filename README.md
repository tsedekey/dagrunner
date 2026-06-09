# dagrunner — build handoff scaffold

This folder is a **ready-to-drop-in Claude Code harness** for an unattended overnight build of
**dagrunner v1**. Copy its contents into your standalone dagrunner project folder (NOT the Camunda
monorepo), open Claude Code there, and start the run.

## What's inside

```
.
├── HANDOFF.md          # READ FIRST — task plan, build order, v1 definition-of-done, autonomy protocol
├── CLAUDE.md           # always-on build context (reuse law, stack, discipline, env gotcha)
├── README.md           # this file
└── .claude/
    ├── settings.json   # permission posture (bypassPermissions + settingSources) + hook wiring
    ├── hooks/
    │   └── deny-guard.sh    # fail-closed PreToolUse safety hook (fires even under bypass)
    ├── agents/         # the 6 tool-restricted subagents the coordinator delegates to
    │   ├── crev-researcher.md
    │   ├── sdk-researcher.md
    │   ├── types-author.md
    │   ├── test-author.md
    │   ├── engine-author.md
    │   └── hooks-author.md
    └── skills/         # design truth, loaded on demand by theme
        ├── architecture-spec/SKILL.md   # all 15 themes (the locked design)
        ├── testing-protocol/SKILL.md    # mock executor + 3 tiers + 6-step smoke test
        └── crev-patterns/SKILL.md       # borrowable patterns from camunda/crev
```

## How to start (pre-sleep checklist)

1. Copy this scaffold's contents into the project root. Confirm `.claude/settings.json` is present
   BEFORE the run begins — it must never be authored mid-run (writing it would prompt and hang).
2. Confirm the harness: Context7 MCP available, TypeScript LSP enabled, coordinator on Sonnet
   (Opus advisory), `@anthropic-ai/claude-agent-sdk` installed.
3. Set machine config / secrets: `DEVHARNESS_SRC` (path to your Camunda checkout) and Anthropic auth
   in env or keychain — never in a file in the run tree.
4. Set a run-level `--max-budget-usd` ceiling.
5. Tell the coordinator: "Read HANDOFF.md and execute the build plan." Then sleep.

## In the morning

Check `BUILD-REPORT.md` (blocks done/blocked, assumptions, smoke-test result, total cost, resume
command), `DECISIONS.md` (assumptions taken on ambiguity), and `git log` (one commit per passing block).

## The one law above all

Do not reinvent wheels. Lean on Claude Code. Build only the cross-process/worktree gaps. Zero new deps.
