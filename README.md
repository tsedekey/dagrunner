# dagrunner

A thin TypeScript binary (`dagrun`) that orchestrates a DAG of Claude Code (Agent SDK) sessions
across isolated git worktrees, with checkpoint-and-exit human gates. It owns only what has no
native Claude Code primitive that survives across separate processes/worktrees — the DAG
executor, conditional skip, gate checkpoints, worktree lifecycle, per-run artifacts — and reuses
Claude Code for everything else. See `CLAUDE.md` for the reuse law and engineering discipline.

## What it does

Walks a feature or bugfix change through a fixed, gated pipeline (e.g.
`expand → implement → review → fix → verify → pr`), pausing at human gates and checkpointing to
disk so it survives process exit. Each node is a Claude Code session spawned via the Agent SDK in
its own git worktree. Three human-driven sibling commands (`ci-babysit`, `pr-triage`,
`/seed-data`) run outside the pipeline against a live PR/cluster.

## Repo layout

```
.
├── CLAUDE.md                          # always-on build context (reuse law, stack, discipline)
├── src/                                # the dagrun binary — core/ workflow/ runtime/ config/ cli/
├── payload/                            # runtime-only: pipeline commands + reviewer agents,
│                                        #   seeded into worktrees at run time — never auto-loaded
├── .claude/                            # build-only harness: dr-build agent, hooks, skills —
│                                        #   auto-loaded when editing dagrunner, never seeded
│   ├── agents/dr-build.md              # executes a self-change plan end-to-end
│   └── skills/testing-protocol/        # mock executor + test tiers + smoke:mock/live
├── docs/
│   ├── dagrunner-master-architecture.md  # the canonical design (WHAT + WHY)
│   ├── dagrunner-architect-charter.md    # role / working-model / anti-drift discipline
│   ├── STATUS.md                         # live "where we are / what's next"
│   └── changes/                          # self-change plans (ready/ → done/)
├── DECISIONS.md                        # build-time judgment-call journal
└── scripts/                            # build-queue.sh, make-bundle.sh, etc.
```

## Building and running

```
npm install
npm run build          # tsc + dist/build-meta.json
npm run dagrun -- <command>   # run from source (tsx), or use the built dist/cli/cli.js
```

`npm run verify-baseline` (`npm ci && typecheck && unit tests && smoke:mock`) is the standing
gate — run it before any commit. `npm run smoke:live` runs the real 8-step SDK pipeline
(requires `ANTHROPIC_API_KEY`, ~35 min) — run by hand when `payload/commands/*.md` changes.

Machine setup (XDG home, `DEVHARNESS_SRC`, secrets) is documented in `CLAUDE.md`.

## Where to look next

- **What dagrunner is and why it's built this way:** `docs/dagrunner-master-architecture.md`.
- **Where the project is right now / what's next:** `docs/STATUS.md`.
- **How a build session should behave:** `docs/dagrunner-architect-charter.md`.
- **Every build-time judgment call:** `DECISIONS.md` (grep it, it's long by design).
- **How "done" is proven:** the `testing-protocol` skill.

## The one law above all

Do not reinvent wheels. Lean on Claude Code. Build only the cross-process/worktree gaps. Zero new
runtime dependencies beyond the Agent SDK.
