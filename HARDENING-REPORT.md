# dagrunner pre-real-run hardening report

All 5 hardening items committed and verified. Item 4 additionally proved at runtime per
`item4-hook-firing-proof.md`.

---

## Item 1 — Pin Haiku model ID to full dated string

**Commit:** `207c390`

**Change:** `sdk-runner.ts`: `"claude-haiku-4-5"` → `"claude-haiku-4-5-20251001"`

**Evidence:** `npm run typecheck` exits 0. The short alias was previously flagged in
`DECISIONS.md` as a placeholder; confirmed dated string is the accepted form per the SDK
models table.

---

## Item 2 — Add unattended-run autonomy directive to agent files and CLAUDE.md

**Commit:** `eedb8f6`

**Change:** Added the following rule after the role line in all 6 `.claude/agents/*.md` files
(`crev-researcher`, `sdk-researcher`, `types-author`, `test-author`, `engine-author`,
`hooks-author`) and strengthened `CLAUDE.md`'s autonomy section to prohibitive wording:
`"NEVER stop to ask the user anything. On ANY ambiguity, choose the spec-aligned default,
append to DECISIONS.md, and continue. Returning a question instead of a result is a protocol
failure."`

**Evidence:** All 6 agent files verified; `npm run verify-baseline` exits 0.

---

## Item 3 — Scope session-start.sh sync to .claude/commands/ only

**Commit:** `b6732ee`

**Change:** `.claude/hooks/session-start.sh`: replaced the blanket
`rsync -a "${SRC_CLAUDE}/" "${DEST_CLAUDE}/"` with a scoped sync that only touches
`${DEST_CLAUDE}/commands/`, leaving `settings.json` and all other seeded files untouched.

**Evidence:** Simulation: source repo had a dummy `.claude/settings.json`; after the sync,
the worktree's seeded `settings.json` (with `PostToolUse` and hooks, no deny-guard) survived
unchanged. The Item 4 proof run (see below) further confirms this in a real worktree: the
worktree's `settings.json` was dagrunner's seeded version after a full node run against a toy
repo that carries its own `.claude/settings.json`.

---

## Item 4 — Confirm SDK loads seeded worktree hooks (runtime proof)

**Commits:** `1e8e7dd` (PostToolUse added to seeded settings.json);
Item 4 proof run: no dagrunner code change committed — sentinel was temporary.

**Gap closed:** The hardening pass had confirmed `settingSources: ["project"]` and
`cwd: worktreePath` were present, and had added the missing `PostToolUse` entry to the seeded
`settings.json`. But a typecheck cannot exercise a runtime hook. This proof demonstrates the
hook actually fires.

### Proof procedure

1. Added `.claude/settings.json` to the toy-repo (no `PostToolUse` entry) and committed it
   to the toy-repo's git. This mirrors the real monorepo case and makes the Item 3 sync
   protection load-bearing: if the source repo's settings overwrote the seeded one, the
   `PostToolUse` hook would disappear and the proof would fail.

2. Temporarily instrumented the seeded settings.json's inline `PostToolUse` command in
   `run-engine.ts` to append a sentinel line to `$DAGRUN_ARTIFACTS/hook-fired.log` after the
   prettier invocation.

3. Ran the full thin slice from `/tmp` (outside the dagrunner repo dir, re-confirming Item 5's
   package-root resolution):
   - `dagrun start feature --plan toy-plan.md` → classify → expand-guide → awaiting-gate
   - `dagrun resume <run-id> --approve` → implement → done

4. Checked evidence and reverted sentinel. `npm run verify-baseline` exits 0 after revert.

### Runtime evidence

**Sentinel (hook-fired.log in implement artifacts):**

```
[POSTTOOLUSE FIRED]  Thu 11 Jun 2026 23:26:22 EAT
[POSTTOOLUSE FIRED]  Thu 11 Jun 2026 23:26:31 EAT
```

The hook fired **twice** — once per Write call the implement node made (summary.md and
src/badly-formatted.ts). The 9-second gap between entries matches the time between writes.

**Seeded settings.json survived (Item 3 holds):**
The worktree's `.claude/settings.json` after the full run was dagrunner's seeded version
containing `PostToolUse`, `SessionStart`, `Stop`, and `SessionEnd` hooks with no deny-guard.
The toy-repo's own `.claude/settings.json` (committed to the toy-repo with only a `permissions`
block and no `PostToolUse`) was NOT copied over it — confirming the scoped sync protection.

**Secondary finding — `CLAUDE_FILE_PATHS` is empty in hook env:**
The double-space between `FIRED]` and the date in the sentinel shows `$CLAUDE_FILE_PATHS` was
unexpanded (empty). This means the prettier invocation `npx prettier --write ""` ran as a
no-op. The hook fires correctly; the formatting step is inert. For the real camunda run,
prettier will not actually format files via this mechanism. This is a follow-up finding, not a
blocker for the proof requirement (hook fires = proven).

### Confirm

- `DAGRUN_ARTIFACTS` IS correctly inherited by the hook process (it wrote the log there).
- The SDK IS loading the seeded `settings.json` via `settingSources: ["project"]`.
- The `PostToolUse` matcher (`Write|Edit|MultiEdit`) IS being matched and the hook IS executing.
- Proof run started from `/tmp` (outside dagrunner repo) — package-root resolution correct.

---

## Item 5 — Fail loud when bundled seed dirs are missing

**Commit:** `9981605`

**Change:** `run-engine.ts`: replaced silent `if (existsSync(srcCommands))` / `if (existsSync(srcHooks))`
guards with hard throws that include the exact path in the error message. The
`import.meta.url`-based package-root resolution was already correct.

**Evidence:** Verified from `/tmp` that `new URL("../", importMetaUrl).pathname` resolves to
the dagrunner package root regardless of `process.cwd()`, and both `srcCommands` and `srcHooks`
paths exist at runtime. `npm run verify-baseline` exits 0.

---

## Baseline verification

`npm run verify-baseline` exits 0 across all 5 hardening items and after the Item 4 proof
revert:

- 16/16 unit tests pass
- All 6 smoke steps pass: init → classify → expand-guide → gate → reject → approve →
  implement → done → reconcile

**dagrunner is ready to point `DEVHARNESS_SRC` at the real `camunda/camunda` checkout.**
