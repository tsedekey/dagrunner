# Sibling Implementation Plan #1 — `/verify-demo` Environment Creator

Status: Build brief for a local implementing agent. Self-contained. Canonical context: `dagrunner-master-architecture.md` §7c (verify-guide / verify-demo) and §9 (siblings).
Scope: the FIRST of two halves of `/verify-demo`. This plan builds the **environment creator** (stand up a debuggable headless cluster + place the tour breakpoints). The **seed-data creator** (c8ctl) is sibling plan #2 and is OUT OF SCOPE here.

---

## 0. What this is

`/verify-demo` is an **interactive Claude Code command** (a sibling, like ci-babysit / pr-triage), living in `.claude/` — NOT a dagrunner pipeline node, NOT sandboxed. It is workstation-coupled by design (JetBrains + DMS plugin + Docker) and always human-driven. Its job is to turn the two artifacts dagrunner's `verify-guide` node produced into a live, followable demonstration of a feature change.

This plan covers the **environment** half: stand up a real headless C8 Orchestration Cluster with Elasticsearch as secondary storage, attached to the debugger, with the tour breakpoints placed — so a human can step through the code trail. It does NOT seed data (plan #2) and does NOT drive the tour narration.

## 1. Inputs it consumes

- `tour-spec.json` (from verify-guide) — the contract is confirmed and stable. Relevant fields:
  - `feature_summary` — one-line context for the run.
  - `breakpoints[]` — each `{ file, line, why, what_to_observe }`. **These are the breakpoints to place.** They are real repo file:line locations.
  - `before_path[]` — may be empty for additive features (it is, for the reference `position` feature). Place these too when present (the "before" trail).
- The existing **run configuration** for the headless Orchestration Cluster (assume it already exists in the project; the agent must locate and use it, not author a new cluster launch from scratch).

## 2. Deliverable 1 (FIRST) — Tool-introspection spike (DMS)

Before building anything, the agent must confirm the **actual** capabilities of the Debugger MCP Server (DMS) plugin's MCP surface on this machine — do NOT assume. Determine and record:
- Can DMS **launch a run configuration** programmatically (start the OC), and detect when it's up?
- Can DMS **set a breakpoint at a file:line** programmatically? (THE linchpin — the whole tour depends on it.)
- Can it **enable/disable/clear** breakpoints, and **resume / run-to-next-breakpoint**, and **read frame/variable state** at a stop?
- What are the exact MCP tool names + argument shapes for each?

Write findings to `verify-demo/dms-capabilities.md`. **Branch on the linchpin:**
- If DMS CAN set breakpoints programmatically → full environment creator (below).
- If DMS can only **inspect** a running debug session (not set breakpoints) → degrade gracefully: place nothing, instead emit a `verify-demo/breakpoint-instructions.md` listing the tour breakpoints as file:line for the human to set manually, and still stand up the cluster. Record this degradation explicitly; do not fail.

## 3. Deliverable 2 — Environment stand-up

- **Elasticsearch (secondary storage):** start ES in Docker (the version/config the OC expects). Wait for green/health before proceeding; fail loud on timeout.
- **Orchestration Cluster:** launch the existing headless OC run configuration **via DMS** (so it comes up under the debugger, attached). Broker + gateway. Await topology/readiness before declaring ready.
- **Ordering:** ES must be up before the OC (secondary storage dependency).
- **Idempotency / re-run:** detect an already-running ES/OC and reuse rather than double-starting (port clashes). Provide a clean way to tear down at the end of the session.
- Record connection details (gateway address, ES URL) to `verify-demo/environment.json` so sibling #2 (seeding) and the human know where to point.

## 4. Deliverable 3 — Breakpoint placement (the tour skeleton)

- Read `tour-spec.json`; for each `breakpoints[]` entry (and `before_path[]` when present), place a breakpoint at `file:line` via DMS.
- Preserve **order** — the breakpoints are an ordered walkthrough; the human (or plan #2's tour driver) will run-to-next through them in sequence.
- Attach/record each breakpoint's `why` + `what_to_observe` so they can be surfaced when the human hits that stop (echo to `verify-demo/tour-placed.md` mapping each placed breakpoint to its narration).
- If a `file:line` no longer resolves (the worktree moved since verify-guide ran), warn loudly per-breakpoint and continue with the rest — never silently skip.

## 5. Out of scope (critical — do not build)

- **Data seeding** (deploy BPMN, start instances) — that is sibling plan #2 (`c8ctl`), which runs AFTER this environment exists.
- **Tour narration / driving the human through breakpoints** — the demo execution layer; later.
- **The before/after comparison logic** using the Glean companion guide — later (the "before" demonstration). This plan only places `before_path` breakpoints if present; it does not orchestrate a before-vs-after comparison.
- Any change to dagrunner itself or the verify-guide node. This is a standalone command.

## 6. Acceptance

1. The DMS capability spike is recorded; the build branched correctly on the set-breakpoint linchpin.
2. Running `/verify-demo` (environment phase) on the reference `position` feature worktree: ES comes up in Docker, the OC launches under DMS and reaches ready topology, and `environment.json` records the endpoints.
3. The 6 `tour-spec.json` breakpoints are placed at their file:line (or, in the degraded path, written to `breakpoint-instructions.md`).
4. Re-running does not double-start or port-clash; teardown cleanly stops ES + OC.
5. A stale file:line warns loudly rather than failing or silently skipping.

## 7. Constraints & reminders

- Runs under `CLAUDE_CONFIG_DIR=~/.claude-work`; ANTHROPIC_API_KEY unset.
- NOT sandboxed (it needs Docker, host ports, broad network) — this is exactly why it lives OUTSIDE dagrunner as an interactive command, not a sandboxed node.
- Workstation-coupled and human-driven: never expected to run unattended. It is fine for it to assume a human is present.
- Fail loud, no silent fallback; degrade explicitly (the DMS linchpin) rather than pretending success.
