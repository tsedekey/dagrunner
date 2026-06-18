# dagrunner — STATUS (live handoff)

> The live "where we are / what's next" layer. **Why** lives in
> `docs/dagrunner-master-architecture.md`; the PM/architect **role** lives in
> `docs/dagrunner-architect-charter.md`; **how "done" is proven** lives in the
> `testing-protocol` skill. This file is kept current under the same anti-drift discipline —
> when state changes, update it.
>
> Last updated: 2026-06-18 (reflect re-architecture complete).

## What dagrunner is

A thin static TypeScript orchestrator (`dagrun`) that walks a feature change through a fixed,
gated pipeline on the Camunda monorepo. Each node is a Claude Code Agent-SDK session in an
isolated git worktree. Principle: **code coordinates, the model judges** — reuse Claude Code
primitives, build only the cross-process/worktree gaps.

## Pipeline (current)

`expand → implement → review → fix → verify → pr` (terminal)
(`verify` is elected after Gate 2; `pr` is the final node.) Each node appends tips/gotchas
to `~/.local/share/dagrunner/store/reflection-log.jsonl` via `dagrun reflect-append`
(best-effort, fail-soft — never blocks shipping). Plus three human-driven sibling commands
outside the pipeline: `ci-babysit`, `pr-triage`, `/seed-data`
(canonical home: Camunda private `.claude/`).

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

- Design/spec/grounding happen in **chat with the architect** (no live repo access — Eddie
  uploads a fresh **bundle** zip via `scripts/make-bundle.sh` before code-grounded work).
- Execution is a **Claude Code build agent** via `/dr-build docs/changes/<plan>.md`. Plans use
  `docs/changes/_TEMPLATE.md` (the lean delta); `/dr-build` carries the standing rules. Built
  plans archive to `docs/changes/done/`.
- Batches run unattended via `scripts/build-queue.sh <plans…>` — walks the queue, gates each on
  `verify-baseline`, stop-on-fail, `caffeinate`, live output + heartbeat + 90m per-step timeout.
  Headless permission posture (bypass + deny-guard) verified.
- **Build mode:** interactive `claude` (`/dr-build <plan>`) by day (watched; avoids the `-p`
  truncation regression); `build-queue.sh` reserved for unattended **night** runs. Night queue takes
  **`smoke:mock`-only** plans; prompt-touching plans (which need `smoke:live`) are built interactively
  by day.

## Done this session

build-vs-payload split · expand/verify rename (clean break) · src restructure + `verify-seed`
stub deleted · unit-test backfill 2a (Tier A) + 2b (Tier B + golden + schema) · interrupt-retry
cap (+ a latent `resume`/`start` exit-1 fix) · **smoke:mock/live split** (the keystone — gate is
now fast + deterministic) · verify-election observability recommendation · TDD folded into
`/dr-build` + charter · **reflect re-architecture**: pure capture via `dagrun reflect-append`,
auto-apply subsystem removed, `pr` is terminal. **Core hardening + reflection are complete.**

## Pending / next

- **Pin the Claude Code CLI/SDK version** (the `-p` empty-result regression — open from the
  original STATUS).
- Confirm the **Agent SDK credit pool** covers volume; set a per-build budget cap on the queue.
- Doc: mention `build-queue.sh` in the README `scripts/` note + charter.
- Follow-up: `build-queue.sh` could auto-run `smoke:live` once after a clean queue / when prompt
  files changed.
- **Sibling capture** (companion Camunda private `.claude/` change): wire `ci-babysit` and
  `pr-triage` to call `dagrun reflect-append` — separate plan.

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
