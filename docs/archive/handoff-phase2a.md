# dagrunner — Phase 2a Build Handoff (review + fix)

Status: Active brief. Self-contained. Read `dagrunner-master-architecture.md` (in-repo) as the canonical source of truth; this brief is the Phase 2a work order built on top of it.
Date: 2026-06-12 (rev 2 — classify retired; review self-triages the diff; verifier gated by finding count; verify is a human election)
Supersedes: handoff-phase1-ARCHIVE.md (Phase 1 only — historical).

---

## 0. Definition of done (target first)

Phase 2a is done when, on a real source repo with a substantive change:

1. `dagrun preflight` runs before the graph and fails loud on any misconfiguration (branch, git state, DEVHARNESS_SRC, sandbox, config, network allowlist, artifact dir).
2. Each node runs under the seeded runtime permission/sandbox/network model: free inside the worktree, read anywhere, mutation/network outside the project hard-blocked, NO permission prompts before a gate.
3. `review` self-triages the diff to select reviewers, runs a read-only parallel subagent fan-out over the bounded reviewer set (+ adversarial verifier when findings count > threshold N), and writes ONE schema-valid `findings.json`.
4. `fix` consumes `findings.json`, mutates the worktree, self-verifies (addressed-each-finding checklist + build/test post-condition), and pauses at a conversation-led accept/reject gate.
5. Rejecting the fix gate with a comment revises in the SAME session and re-pauses; approving proceeds.
6. `npm run verify-baseline` exits 0; the full slice (expand-guide -> implement -> review -> fix) runs green end to end with state/resume intact.

Deliver runnable proof (captured transcript + the produced findings.json + a before/after worktree diff), not prose assertions.

---

## 1. Context: what exists, what shifted

**Phase 1 is DONE and hardened** (your compacted context already holds the detail). It delivered the complete engine + spine + thin slice:

- Nodes: classify -> expand-guide -> implement, with Gate 1 (review-the-guide, conversation-led).
- Spine: run-id, state.json, checkpoint-and-exit, reconcile-on-resume, worktree lifecycle, run-dir artifact channel, `produces` contract, XDG home, native hooks (SessionStart sync, PostToolUse format, Stop friction/gates, SessionEnd cost), launcher with env propagation, `dagrun report` static HTML.
- Hardened: 5 fresh-model bugs fixed, formatter hook fixed (parses `tool_input.file_path` from stdin), seeded-command/hook path resolution from package root, scoped worktree sync, enterprise-config dress rehearsal passed.

**What SHIFTED since Phase 1 was specced** (do NOT follow the old Phase-1 handoff on these):

- The six reviewers are NOT six static DAG nodes, and there is NO `synthesize-and-fix` loop node. That design is superseded.
- Instead: **review and fix are SPLIT into two static nodes.** `review` is read-only parallel fan-out over a bounded reviewer set using NATIVE SUBAGENTS inside one static node, producing a single findings artifact. `fix` is a separate static node that mutates the worktree and carries the conversation-led gate.
- The feature pipeline is **fully static** — no dynamic workflows inside it. Dynamic workflows (`/pr-review`) and the siblings are Phase 3, out of scope here.
- A new **runtime permission/sandbox/network model** replaces the build-time `bypassPermissions` posture.
- A new **preflight check** ("Prepare") runs before the graph.
- **classify-as-a-node is RETIRED** (returns in Phase 5/6 for task-TYPE routing — see master doc §7). Its only live job was change-AREA detection to select reviewers; that is now a cheap **diff-triage first step INSIDE the review node** (haiku), reading the actual diff rather than predicting from the plan. The current pipeline starts at expand-guide. Do NOT build a classify node.
- The **adversarial verifier is triggered by a RUNTIME finding-count threshold** inside the review node (run only when findings > N, N tunable) — NOT a classify flag.
- **Runtime verification is a HUMAN election** after the fix gate (y/n), not a classify `needs_runtime` prediction (this is Phase 2b; just do not reintroduce needs_runtime here).

---

## 2. Golden rules (carry from Phase 1, unchanged)

- **Reuse Claude Code primitives; build only cross-process/worktree gaps.** No new deps beyond the Agent SDK.
- **Artifacts are the only cross-node channel.** Nodes never share memory; everything flows via run-dir artifacts read/written by absolute path.
- **`produces` is the deterministic contract.** A node is `done` only if it wrote its declared artifact(s); missing => failed. Never weaken this.
- **Fail loud, no silent cwd fallback.**
- **Show evidence, never assert success in prose.**
- **Schema is single-source-of-truth, owned by dagrunner.** Never duplicate a schema; pass it where needed.

---

## 3. Phase 2a deliverables — IN ORDER

### Deliverable 1 (FIRST): Preflight + runtime permission/sandbox/network model

This MUST land before review/fix, because review/fix are the first nodes to do autonomous MUTATION on the real repo — the permission boundary must exist first.

**1a. Seeded runtime `settings.json`** (seeded into each worktree's `.claude/`, loaded via `settingSources: ["project"]` with node `cwd` = worktree). This is DISTINCT from the build-time bypass posture.

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "additionalDirectories": ["<run-dir artifacts path — injected per run>"],
    "allow": ["Read", "Bash(git *)", "Bash(npm run *)", "Bash(npx tsc *)"],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)",
      "Bash(git push --force *)",
      "Bash(git push * --force)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/secrets/**)",
      "Write(**/.env*)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "network": {
      "allowedDomains": [
        "api.anthropic.com",
        "registry.npmjs.org",
        "*.npmjs.org",
        "github.com",
        "*.githubusercontent.com"
      ]
    }
  }
}
```

Behavior to achieve: inside-project auto (acceptEdits + worktree cwd); Read global; out-of-project mutation kernel-blocked by macOS Seatbelt (hard block, not a prompt); network proxied + allowlisted (NOT cut off — WebFetch/WebSearch tools unaffected since in-process; Bash network works for allowlisted domains, un-listed => loud failure).

**Three gotchas to handle:**

1. The run-dir artifacts live OUTSIDE the worktree — inject the per-run artifact path into `additionalDirectories` at seed time, or every node prompts. (Most likely source of unexpected prompts.)
2. Node-native `fetch` (undici) ignores the proxy and breaks under the sandbox — if any node code does raw `fetch()`, it needs a ProxyAgent or `excludedCommands`. Build/test tools (npm/git/tsc) respect the proxy and are fine.
3. Enterprise managed settings can override/lock user+project rules — verify the work config doesn't impose conflicting rules.

**1b. `dagrun preflight`** — runs before the graph (and as the first thing `start` does). NOT a DAG node. Fails loud on any miss:

- On expected base branch; git working tree clean.
- DEVHARNESS_SRC resolves and is a git repo.
- Seeded permission settings.json present; macOS Seatbelt sandbox available.
- Network allowedDomains covers what the task needs.
- ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR = ~/.claude-work.
- Enterprise managed policy doesn't block what the run needs.
- Run-dir artifact path computed and in additionalDirectories.

**Acceptance:** a deliberately-broken precondition (wrong branch, missing allowlist domain, dirty tree) makes preflight fail loud with the exact problem; a clean setup passes and a node runs through with ZERO permission prompts.

### Deliverable 2: `review` node (read-only, static subagent fan-out)

- **Depends on:** implement. **Read-only** — must NOT modify the worktree.
- **Diff-triage first step (replaces classify):** the review node's FIRST action is a cheap haiku pass that reads the actual diff and sets the area flags `touches_public_api / touches_runtime / perf_sensitive / touches_schema_or_proto`. These flags select which reviewers run — derived from the real diff, not predicted upfront. There is no classify node.
- **Reviewer set (bounded, known), selected by the diff-triage flags:** correctness (always), test-adequacy (always), api-stability (when touches_public_api), distributed-systems (when touches_runtime), performance (when perf_sensitive), migration-safety (when touches_schema_or_proto).
- **Mechanism:** ONE static DAG node that runs diff-triage, then dispatches the selected reviewers as NATIVE SUBAGENTS (isolated context each, per-reviewer model tier), then — ONLY IF the total findings count exceeds a tunable threshold N — runs an **adversarial verifier** subagent that skeptically checks the findings against the actual diff (grounds each finding to a real (file, line); drops/downgrades ungrounded ones), then synthesizes. The verifier trigger is the runtime finding count, NOT a classify flag.
- **Reviewer specialist definitions** live as `.claude/agents/*.md` (shared assets — reused later by `/pr-review`). Author the six with Camunda-specific focus. Tool allowlist: read-only.
  - **Start from crev's specialists as the template.** The `camunda/crev` repo already ships battle-tested reviewer specialist definitions (8 specialists, each a `.md` with frontmatter + system prompt + read-only tool allow-list) plus the `mcp-camunda-knowledge` server. The `review-author` subagent should READ crev's specialist `.md` files and `mcp-camunda-knowledge` first and adapt them to our six dimensions and findings schema — do NOT author from scratch. This keeps one source of truth for "what correctness/distributed-systems/etc. review means" across crev, our in-pipeline review, and the future `/pr-review`. Confirm crev's specialist set against our six and note any dimension crev covers that we drop, or vice versa, in DECISIONS.md.
- **Model tiers:** correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet. Validated at load.
- **Optional-reviewer degradation:** a non-correctness reviewer that fails degrades to skipped (record `degraded: true` + reason); correctness failure fails the node.
- **produces:** ONE `review/findings.json` validated against the dagrunner-owned findings schema (below). No worktree mutation.

**Findings schema (dagrunner owns it; single source of truth):**

```
{
  run_id, timestamp,                        // passed IN, not generated
  reviewers_run: [string],                  // coverage declared
  reviewers_skipped: [{ name, reason }],    // degraded-coverage visibility
  adversarial_verifier_run: bool,
  findings: [
    {
      reviewer_dimension: string,
      severity: 'blocker'|'major'|'minor'|'nit',
      confidence: 'high'|'med'|'low',
      file: string, line: number,
      claim: string,
      grounded: bool                        // verifier-confirmed against diff
    }
  ]
}
```

**Acceptance:** on a flawed change, review runs the correct subset by the diff-triage flags, writes schema-valid findings with grounded high-confidence items, degrades gracefully if a reviewer fails, and never touches the worktree (verify: clean `git status` in worktree except the implement diff).

### Deliverable 3: `fix` node (mutating, gated, self-verifying)

- **Depends on:** review. Consumes `review/findings.json`.
- **Behavior:** fix only high-confidence Blocker/Major findings (configurable threshold); mutate the worktree accordingly.
- **Self-verification (deterministic, on node exit):** (a) an addressed-each-targeted-finding checklist against the findings artifact; (b) the build/test post-condition (the Stop-hook verifier pattern as a node-exit assertion). No automatic re-review (decoupled by design — residual risk caught at verify-seed downstream in 2b).
- **Gate 2 (conversation-led accept/reject):** pauses on the applied fixes. Reject-with-comment resumes the SAME session, revises with memory, re-pauses (bounded iterations; exhaustion => stay paused with terminal choice, never auto-cancel). Approve => proceed.
- **produces:** `fix/summary.md` (what changed, which findings addressed/deferred) + the worktree diff. Gate decision + comments recorded in state.json gateHistory + `fix/feedback-<n>.md`.

**Acceptance:** fix addresses the high-confidence findings, self-verify passes (or fails loud), the gate pauses, a rejection comment produces a memory-aware revision in the same session, approval proceeds.

---

## 4. Build harness (how the agent should work)

Reuse the Phase 1 pattern: **a coordinator that delegates to tool-restricted subagents**, keeping its own context lean.

- Coordinator owns the task plan + this brief + the master doc; never writes implementation code itself.
- Suggested subagents: `permission-author` (deliverable 1), `review-author` (deliverable 2 + the six specialists), `fix-author` (deliverable 3), `test-author` (mock-executor tests + acceptance scripts), plus a `sdk-researcher` (read-only, Context7) to confirm SDK signatures for subagent dispatch, structured output, sandbox/permission config, and settingSources.
- **Per-block git commit** after each deliverable passes its acceptance.
- **Fresh-model verification pass** on deliverable 1 (permission model) and deliverable 3 (fix gate) — the two load-bearing pieces.
- Reuse the v1 test discipline: mock node executor for deterministic engine tests; live runs only for the integration acceptance.

---

## 5. Autonomy protocol (if run unattended)

- NEVER end a turn with a question — coordinator and every subagent. On ambiguity: pick the master-doc-aligned default, log `{decision, options, choice, rationale}` to DECISIONS.md, proceed.
- bypassPermissions + the fail-closed deny-guard hook for the BUILD session (this is build-time, distinct from the runtime model in Deliverable 1).
- Isolate-and-continue on a blocked deliverable; commit progress; surface in a HARDENING/BUILD report.
- Run under `CLAUDE_CONFIG_DIR=~/.claude-work`; ANTHROPIC_API_KEY unset.

---

## 5b. Validation target — two-target strategy

Verification uses TWO targets, in order. Do not skip the first.

**Target 1 — fake polyglot fixture (`dagrunner-fixture`) for Phase 2a MECHANICS.** The build agent scaffolds it from `phase2a-validation-fixture.md`. It is a throwaway TS+Java repo with THREE PLANTED FLAWS mapped to reviewer dimensions (correctness, test-adequacy, api-stability), so review produces KNOWN expected findings and Phase 2a acceptance becomes a concrete pass/fail assertion rather than a judgment call. Its companion-format implementation plan (no GitHub issue) is dropped in the inbox as the run input. This is the iteration target — fast, deterministic, and the only target that exercises BOTH format hooks (prettier on TS, spotless on Java) and BOTH build/test post-conditions.

Why a fake repo, not real Camunda, for mechanics: on real correct code the reviewers may find nothing, leaving fix + Gate 2 unverifiable; planted flaws guarantee the full review -> findings -> fix -> gate path runs and is checkable.

**Target 2 — de-scoped M2-6 subset on REAL camunda/camunda, ONCE, at end of Phase 2** (not 2a): a record-only single-job priority update (no column-family key rotation, no exporters), ingested as a mimicked Glean-companion plan in the inbox. Proves dagrunner handles real engine substance + the real `./mvnw` toolchain before the weekend real task (#53839), which stays untouched.

Acceptance for 2a is proven on Target 1. Target 2 is the end-of-Phase-2 integration check.

## 6. Explicitly OUT of scope for Phase 2a

- verify-seed, pr, reflect/apply-reflection (Phase 2b).
- ALL siblings: ci-babysit, /pr-review (dynamic workflow), review-triage (gh-aw) (Phase 3, gated behind enterprise/governance checks).
- Live `dagrun ui` (Phase 4).
- Any dynamic-workflow node inside the feature pipeline (by design — never).

Do not build ahead into these. Phase 2a is preflight+permissions, review, fix — nothing more.

---

## 7. Done criteria recap

All three deliverables committed (separate commits) with runnable proof; `npm run verify-baseline` exits 0; the slice expand-guide -> implement -> review -> fix runs green with the runtime permission model active and zero pre-gate prompts; a HARDENING-style report summarizes each deliverable's evidence. Then Phase 2a is complete and we move to 2b (verify-seed + pr + reflect).
