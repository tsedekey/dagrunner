# dagrunner — STATUS (live handoff)

> The live "where we are / what's next" layer. **Why** lives in
> `docs/dagrunner-master-architecture.md`; the PM/architect **role** lives in
> `docs/dagrunner-architect-charter.md`; **how "done" is proven** lives in the
> `testing-protocol` skill. This file is kept current under the same anti-drift discipline —
> when state changes, update it.
>
> Last updated: 2026-06-19 (sibling ownership redesign + run-id collision guard shipped).

## Next session: start here

> Read this block first. Everything else in this file is background.

**Both this-session tasks are complete** (committed as of `95ea625` / `b8c37cf`):

- **sibling-ownership** — `ci-babysit`, `pr-triage`, `seed-data` versioned in `payload/siblings/`;
  seeded at run-start and re-applied at every node session-start via `session-start.sh`; `DAGRUNNER_ROOT` exported.
- **run-id-collision-guard** — run-id is now `<slug>-<timestamp>-<6-hex>`; fail-loud existsSync backstop added.

**Next task (no plan yet — needs drafting):**

Pick one of the open items from the "Pending / next" section below. Good candidates:

- **Pin the Claude Code CLI/SDK version** — the `-p` empty-result regression is still open.
- **Wire siblings to `dagrun reflect`** — have `ci-babysit` / `pr-triage` append to the reflection store (separate plan, see STATUS "Pending").
- **Build-queue credit cap** — per-build budget guard on `scripts/build-queue.sh`.

**Working model (see memory):** always delegate implementation to the `dr-build` agent; this
session is coordinator only. Start a fresh session after 1–2 tasks complete.

---

## What dagrunner is

A thin static TypeScript orchestrator (`dagrun`) that walks a feature change through a fixed,
gated pipeline on the Camunda monorepo. Each node is a Claude Code Agent-SDK session in an
isolated git worktree. Principle: **code coordinates, the model judges** — reuse Claude Code
primitives, build only the cross-process/worktree gaps.

## Pipeline (current)

`expand → implement → review → fix → verify → pr` (terminal)
(`verify` is elected after Gate 2; `pr` is the final node.) Each node may write `reflections.md`; the SessionEnd hook appends it to `~/.local/share/dagrunner/store/reflection-log.jsonl`
(fail-soft — never blocks shipping). Manual/sibling append: `dagrun reflect`. Plus three human-driven sibling commands
outside the pipeline: `ci-babysit`, `pr-triage`, `/seed-data`
(canonical home: dagrunner `payload/siblings/`).

## Repo structure (post-restructure)

- `src/` in 5 cohesion folders: `core/` (dag, state, lock, types), `workflow/`, `runtime/`
  (run-engine, sdk-runner, mock-executor, launcher), `config/` (xdg, settings-seed), `cli/`
  (cli, preflight, report).
- `.claude/` = **build-only** harness (author/researcher agents, build skills, `/dr-build`,
  hooks, settings, CLAUDE.md) — auto-loaded for sessions editing dagrunner, never seeded.
- `payload/` = **runtime-only** (pipeline commands, reviewer agents) — seeded into worktrees,
  never auto-loaded.
- `scripts/` = dev helpers: `make-bundle.sh`, `build-queue.sh`, `zip-build-queue.sh`.

## Testing & the gate

- **Tiers** per `testing-protocol`: unit (deterministic, mock executor) → `smoke:mock`
  (full gated pipeline in-process, fast/free/deterministic) → `smoke:live` (real-SDK 8-step,
  occasional).
- **`verify-baseline = npm ci && typecheck && test && smoke:mock`** — the per-plan gate. Fast
  and deterministic.
- **Run `smoke:live` by hand** when a plan touches node prompts (`payload/commands/*.md`) or
  before a real merge — `smoke:mock` can't catch a bad prompt.
- **TDD is standing** for the deterministic layer (failing test first); model-judgment behaviour
  stays evidence-based (`smoke:live` + human). Encoded in `/dr-build`.

## How we work

- **Coordinator** (this Claude Code session, rooted in `~/dev/dagrunner` on personal) owns plan
  design, sequencing, and architecture decisions. Has live repo access — no zip uploads needed.
- **Implementation** is always delegated to the `dr-build` agent
  (`Agent({ subagent_type: "dr-build", prompt: "docs/changes/ready/<plan>.md" })`). The agent
  self-briefs, TDDs, runs `verify-baseline`, reconciles docs, commits, and returns a build report.
  Independent plans can be fanned out in parallel.
- **Plans** use `docs/changes/_TEMPLATE.md` (the lean delta). Built plans archive to
  `docs/changes/done/`.
- **Session cadence:** fresh session after 1–2 tasks. Each session boots from this file's
  "Next session: start here" block — no re-orientation needed.
- **Night queue:** `scripts/build-queue.sh <plans…>` for unattended batches — gates each on
  `verify-baseline`, stop-on-fail, `caffeinate`. Night queue takes `smoke:mock`-only plans;
  prompt-touching plans need `smoke:live` run by hand.

## Done this session

build-vs-payload split · expand/verify rename (clean break) · src restructure + `verify-seed`
stub deleted · unit-test backfill 2a (Tier A) + 2b (Tier B + golden + schema) · interrupt-retry
cap (+ a latent `resume`/`start` exit-1 fix) · **smoke:mock/live split** (the keystone — gate is
now fast + deterministic) · verify-election observability recommendation · TDD folded into
`/dr-build` + charter · **reflect re-architecture**: pure capture via `dagrun reflect-append`,
auto-apply subsystem removed, `pr` is terminal. **hook-driven reflection capture**: SessionEnd
hook reads `reflections.md` → store log; `notes.md` → `reflections.md` sweep; CLI renamed to
`dagrun reflect`; smoke hard-asserts ≥1 store entry. **Night-mode permission posture**: attended nodes keep `acceptEdits`; `--night` nodes use
`bypassPermissions` so no maven/bash hangs; sandbox + deny-guard boundary unchanged (proven by
teeth-check unit tests). **`dr-build` agent**: slash command retired, single self-briefing agent
now handles all plan execution. **Core hardening + reflection + night-mode prompt posture complete.** **Sibling ownership**: `ci-babysit`, `pr-triage`, `seed-data` moved to `payload/siblings/` (versioned); `seedWorktreeSiblings` seeds both run-start and resume; `session-start.sh` re-seeds after DEVHARNESS_SRC sync so dagrunner always wins; 4 TDD unit tests green.

## Pending / next

- **Pin the Claude Code CLI/SDK version** (the `-p` empty-result regression — open from the
  original STATUS).
- Confirm the **Agent SDK credit pool** covers volume; set a per-build budget cap on the queue.
- Doc: mention `build-queue.sh` in the README `scripts/` note + charter.
- Follow-up: `build-queue.sh` could auto-run `smoke:live` once after a clean queue / when prompt
  files changed.
- **Sibling capture** (companion Camunda private `.claude/` change): wire `ci-babysit` and
  `pr-triage` to call `dagrun reflect` — separate plan (out of scope for this change).

## Reflection-harvest notes (banked for the reflect work)

- The live-SDK smoke is irreducibly flaky as a per-plan gate — every real node is a flake point;
  a mock gate + occasional live is the right model (now implemented).
- The independent queue gate caught a flaky build the builder's own verify passed — redundancy
  earned its keep.
- Several latent bugs were surfaced by writing tests / building (formatter-hook, exit-1 on failed
  run, the feedback-iteration regex) — characterization-first pays off.

## Pointers

`docs/dagrunner-master-architecture.md` (WHY) · `docs/dagrunner-architect-charter.md` (role) ·
`testing-protocol` skill (proof) · `DECISIONS.md` (build-time judgment calls).
