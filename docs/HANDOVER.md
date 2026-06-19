# dagrunner — HANDOVER (chat-architect → Claude Code agent)

> **Read this first, then read the pointers in §1.** This document transfers the driver's seat from
> the chat-based architect ("chat-Claude") to **you** — a Claude Code agent with live repo access.
> It is deliberately thin on durable project state (that lives in the repo docs — §1) and rich on
> what is _changing now_ and what was decided in chat but isn't written down anywhere else yet (§3–§5).
>
> Created: 2026-06-19.

## 0. Who you are now

You are the **fused PM + solution architect + builder** for dagrunner — the role chat-Claude held,
now with live repo access so design and execution no longer round-trip through Eddie and zip files.
You design, ground in real code, write plans, AND build — delegating deep code execution to
**sub-agents** to keep your own context clean. Eddie remains reachable on chat-Claude for second
opinions / architecture sanity-checks, but **you are the primary driver.**

Run **rooted in `~/dev/dagrunner`** (so you inherit the repo's `.claude/` harness + `CLAUDE.md`), on
the **personal** subscription (`CLAUDE_CONFIG_DIR=~/.claude-personal`). See §4 for why personal, and
its limits.

## 1. Your durable context — READ THESE (don't let me restate them here)

All of this is current in the repo. Read it before acting; it is the source of truth, not this file:

- `docs/dagrunner-architect-charter.md` — your role, working model, anti-drift discipline.
- `docs/STATUS.md` — where the project is / what's next (live handoff layer).
- `docs/dagrunner-master-architecture.md` — the WHY (canonical design).
- `DECISIONS.md` — every build-time judgment call (large; grep it).
- `.claude/skills/testing-protocol/SKILL.md` — how "done" is proven (tiers, smoke:mock/live, TDD).
- `.claude/commands/dr-build.md` — the build harness + standing rules (golden rules, autonomy-to-commit,
  done-by-evidence, TDD). You use `/dr-build docs/changes/<plan>.md` to execute self-change plans.

**Anti-drift rule (inherited, non-negotiable):** code = WHAT, master doc = WHY; reconcile in the same
commit. When a decision changes, update the charter/STATUS/master-doc/DECISIONS in the same breath.

## 2. Your first task — redesign the siblings

**Bring the siblings under dagrunner as the versioned source of truth.** Today they live in the Camunda
private `.claude/` (`DEVHARNESS_SRC`), git-ignored there, therefore **unversioned** — and agents
sometimes edit them on a live worktree, so the improvements die when the worktree is deleted. Two real
bugs to fix.

**Target design (agreed in chat — this is the spec):**

- dagrunner **owns and versions** the siblings (their `.md` + `scripts/`). Source of truth = dagrunner.
- At workflow-run time, siblings are **copied/seeded onto the Camunda worktree** (same mechanism that
  already seeds dagrunner's pipeline `.claude/` bits), used there, and the worktree is disposable.
- **No live-worktree edits.** If an agent finds a sibling improvement mid-run, it goes to the
  **reflection store** (the hook-driven `store/reflection-log.jsonl` — see master doc/§reflection),
  NOT edited in place. Improvements are applied back at the dagrunner source later, via a plan.

**Scope check — confirm the sibling set with Eddie before starting.** The Camunda `.claude/commands/`
currently holds **four**, not three: `ci-babysit`, `pr-triage`, `seed-data`, **and `pr-review`**. Eddie
has referred to "three siblings" — resolve whether `pr-review` is a fourth, or folded into `pr-triage`,
before scoping the redesign.

**Out of scope for this task (explicitly parked — do NOT conflate):** versioning the Camunda _knowledge_
`CLAUDE.md` files (see §5). That is a separate, unsolved design question. The siblings are
dagrunner-owned and clear-cut; the Camunda knowledge is Camunda-owned and thorny. Keep them apart.

## 3. State as of this handover (what's done / pending)

**Shipped + committed (this multi-day push):** build/payload split, node renames, src restructure,
full unit-test backfill (Tier A + B + golden + schema), interrupt-retry cap, **smoke:mock/live split**
(the deterministic-gate keystone), verify-election observability recommendation, TDD-into-`/dr-build`,
remove-classify, fix-smoke-fixture, expand-challenge, **reflect re-architecture** (pure capture, delete
auto-apply), **hook-driven reflection capture** (SessionEnd hook → `store/reflection-log.jsonl`),
de-flake-reflection-capture-test, and **night-mode gate auto-decisioning** (auto-approve-unless-flagged;
verify-election always parks). A **real overnight-style feature run** (job-priority task, #53855) ran
and the **core pipeline behaved correctly** — siblings are the weak point, hence this task.

**Ready / pending plans — ACTION REQUIRED, see §6:** the plans below were authored in chat and are
**not all in the repo yet.** They must be saved into `docs/changes/ready/` or they're lost:

- `night-mode-permission-posture` — **the last gap before overnight works.** `--night` must run nodes
  under `bypassPermissions` (so they don't hang on `mvnw`/bash prompts) while keeping sandbox +
  deny-guard. Attended stays `acceptEdits`. (Currently `acceptEdits` is hardcoded → a real `--night`
  run hangs at the first Maven prompt.) **Build this, then a watched `--night` run, before any real
  overnight run.**
- Small crumbs: `cli.ts` help-text sync (drop `revert-reflection`, add `dagrun reflect`); master-doc
  `CLASSIFY_SCHEMA`→`FINDINGS_SCHEMA` staleness (~L92); re-add charter + STATUS to the chat Project
  knowledge (Eddie's task, not yours).

## 4. Subscription / environment rules (load-bearing)

- Run on **personal** (`CLAUDE_CONFIG_DIR=~/.claude-personal`) for **harness/sibling development** —
  TypeScript, tests, dagrunner-owned files. Personal was topped up with the dagrunner bash/edit
  allowlist; it does NOT have the Camunda MCPs / enterprise LSPs, and **does not need them for this work.**
- **Work subscription (`~/.claude`) is reserved for real Camunda feature runs** — those need the
  enterprise `camunda-knowledge` MCPs + Java/TS LSPs that only exist on work. **Do not attempt a real
  feature run on personal — it will lack the tooling.** Rule of thumb: _personal = build dagrunner;
  work = run dagrunner against Camunda._
- **Unattended auth is unresolved.** Subscription login may not resolve in a stripped/headless shell
  (the token is in the macOS Keychain, not the `.claude` dir). A real overnight run likely needs a
  dedicated **`ANTHROPIC_API_KEY`** exported by the launcher, not subscription login. Treat this as an
  open pre-flight for any overnight work.

## 5. Parked design question (do not start without a design pass)

**Versioning the Camunda knowledge `CLAUDE.md` files.** They can't be pushed upstream (would conflict
with / impose on canonical company files) but need versioning. Options floated: local-only branch in
Camunda; a private overlay git repo inside the Camunda tree; or dagrunner mirroring (rejected-leaning —
inverts ownership, drifts). **Unresolved. Likely Camunda-owned with dagrunner only _capturing_ proposed
improvements via the reflection store.** Do not fold this into the sibling task; raise it with Eddie as
its own pass.

## 6. Boot sequence (do these in order)

1. Confirm you are rooted in `~/dev/dagrunner` on personal; `git status` clean.
2. Read everything in §1.
3. **Get the ready-pile plans into the repo.** Eddie has them as files (from chat) — have him drop
   `night-mode-permission-posture.md` (+ any other un-saved plans) into `docs/changes/ready/`. Without
   this, §3's pending work is invisible to you.
4. Confirm the sibling set with Eddie (§2 — three or four?).
5. Begin the sibling redesign per §2, under the charter's working model and the testing-protocol/TDD
   rules. Ground in the real sibling files (in `DEVHARNESS_SRC`'s `.claude/`) before designing.

## 7. What chat-Claude remains for

Second opinions, architecture sanity-checks, "right idea / wrong harness" catches, and design
discussion when you want a sounding board. You drive; chat-Claude advises.
