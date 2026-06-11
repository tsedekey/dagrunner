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

## Item 4 — Confirm SDK loads seeded worktree hooks (runtime proof + formatter fix)

**Commits:** `1e8e7dd` (PostToolUse added to seeded settings.json);
formatter-fix commit: hook script + run-engine.ts update + toy-repo dirty file.

**Gap closed (original):** Confirmed `settingSources: ["project"]` and `cwd: worktreePath` are
applied, and the `PostToolUse` entry exists in the seeded `settings.json`. Hook fires at runtime.

**Secondary defect fixed:** `$CLAUDE_FILE_PATHS` is not populated by Claude Code in the hook
environment — the old inline `npx prettier --write "$CLAUDE_FILE_PATHS"` was a silent no-op.
Fixed: the hook now reads `tool_input.file_path` from stdin JSON via `jq`. Moved to a dedicated
script `.claude/hooks/post-tool-use-format.sh` (consistent with all other hooks).

### Fix: `post-tool-use-format.sh`

Parses the edited file path from the PostToolUse stdin JSON payload (`tool_input.file_path`),
confirmed against Claude Code hook documentation. Covers Write, Edit, and MultiEdit (MultiEdit
operates on a single target file — `tool_input.file_path` applies uniformly). Fail-soft: missing
`jq`, missing `prettier`, absent/non-existent path → exit 0, never blocks a node run.

### Proof procedure

1. Added `.claude/settings.json` (no `PostToolUse`) and a dirty `src/badly-formatted.ts`
   (single quotes, no semicolons, no spaces around operators) to the toy-repo's git. Changed
   the implement command to Edit the pre-seeded dirty file (prepend a `// reviewed` comment)
   rather than Write a new file — this guarantees dirty content reaches the hook regardless
   of whether Haiku normalizes its own Write output.

2. Temporarily instrumented `post-tool-use-format.sh` to log path, before-SHA, prettier
   version, after-SHA, and `changed=yes/no` to `$DAGRUN_ARTIFACTS/hook-format.log`.

3. Ran the full thin slice from outside the dagrunner repo dir:
   - `dagrun start feature --plan toy-plan.md` → classify → expand-guide → awaiting-gate
   - Confirmed dirty file on disk in worktree before resume (SHA `601f717f...`)
   - `dagrun resume <run-id> --approve` → implement → done

4. Checked evidence, reverted instrumentation. `npm run verify-baseline` exits 0.

### Runtime evidence

**Before (pre-seeded dirty file in worktree, SHA `601f717f...`):**

```text
const greeting = 'hello world'
const add=(a:number,b:number)=>a+b
export {greeting,add}
```

**hook-format.log (implement artifacts):**

```
[FORMAT HOOK] path=/private/tmp/.../worktrees/toy-plan-1781211033562/src/badly-formatted.ts before=34144783261dc41d6202f9ad7b8ea8e62d0c6fb0dcb9e22e9b85709ad1a1bedd prettier=3.8.4
[FORMAT HOOK] after=d8003a4cbcf0d487aef999fc177e2d080119fb96a5ee4975cfe7de3ad64ad1ae changed=yes
```

**After (on-disk in worktree, SHA `d8003a4c...`):**

```typescript
// reviewed
const greeting = "hello world";
const add = (a: number, b: number) => a + b;
export { greeting, add };
```

`changed=yes` — before SHA ≠ after SHA. The hook:

- Received the real absolute path in `tool_input.file_path` (not empty — root defect fixed)
- Found prettier 3.8.4 via `npx`
- Reformatted: single→double quotes, added semicolons, spaced operators, spaced export braces

**Seeded settings.json survived (Item 3 holds):**
The worktree's `.claude/settings.json` after the full run was dagrunner's seeded version
containing `PostToolUse`, `SessionStart`, `Stop`, and `SessionEnd` hooks with no deny-guard.
The toy-repo's own `.claude/settings.json` was NOT copied over it.

**Proof run started from outside the dagrunner repo dir** — package-root resolution correct.

### Confirm

- `DAGRUN_ARTIFACTS` IS correctly inherited by the hook process (log written there).
- The SDK IS loading the seeded `settings.json` via `settingSources: ["project"]`.
- `PostToolUse` matcher (`Write|Edit|MultiEdit`) IS being matched and the hook IS executing.
- `tool_input.file_path` from stdin JSON IS the correct mechanism (not `$CLAUDE_FILE_PATHS`).
- Prettier IS reachable (`npx prettier --version` = 3.8.4) and IS formatting dirty content.

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
