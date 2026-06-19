# Plan: Pre-commit format hook for code-changing nodes

## Problem

The `fix` and `implement` nodes commit code without running the Camunda monorepo's
required formatting step (`./mvnw spotless:apply`), causing CI failures on the format check.

## Confirmed context

- **Agent commits in-session**: sdk-runner spawns a full Claude Code session with `cwd: worktreePath`;
  run-engine.ts has zero `git commit` calls. The agent is who commits.
- **PreToolUse on Bash** fires before every Bash tool call the agent makes, including `git commit`.
- **CWD of hooks** = `$CLAUDE_PROJECT_DIR` = the worktree (set via `cwd` in SDK options).
  `DAGRUN_WORKTREE` env var is the same value, set before query().

## Mechanism

A new **PreToolUse hook** (`pre-tool-use-commit.sh`) intercepts `git commit` Bash calls.
When `DAGRUN_FORMAT_CMD` env var is set:

1. `cd "$DAGRUN_WORKTREE"`
2. Run `$DAGRUN_FORMAT_CMD` (e.g. `./mvnw spotless:apply --no-transfer-progress`)
3. `git add -u` to re-stage any files spotless reformatted
4. Exit 0 → allow the commit (which now includes the formatted changes)
5. If the format command exits non-zero → emit block JSON and exit 0 (fail loud)

When `DAGRUN_FORMAT_CMD` is not set → no-op immediately (exit 0).
When the Bash command does not contain `git commit` → no-op immediately (exit 0).

**Failure policy**: fail loud — a format failure BLOCKS the commit. The agent sees the error
and can debug. A silent commit of unformatted code is the bug we're fixing.

## Changes (6 files)

### 1. `src/core/types.ts` — add `formatCommand` to Node

```typescript
/** Shell command to run before git commit (e.g. "./mvnw spotless:apply"). */
formatCommand?: string;
```

Add after `maxBudget?: number` in the Node type.

### 2. `src/runtime/launcher.ts` — plumb DAGRUN_FORMAT_CMD

In `NodeLaunchEnv`:

```typescript
/** Format command to run before git commit; absent means no-op. */
DAGRUN_FORMAT_CMD?: string;
```

In `buildNodeEnv`, add `formatCommand?: string` as the last parameter:

```typescript
export function buildNodeEnv(
  config: DagrunnerConfig,
  runId: string,
  nodeId: string,
  runDir: string,
  worktreePath: string,
  storeDir: string,
  formatCommand?: string,
): NodeLaunchEnv {
  return {
    ...existing fields...
    ...(formatCommand !== undefined ? { DAGRUN_FORMAT_CMD: formatCommand } : {}),
  };
}
```

In `applyNodeEnv`:

```typescript
if (env.DAGRUN_FORMAT_CMD !== undefined) {
  process.env["DAGRUN_FORMAT_CMD"] = env.DAGRUN_FORMAT_CMD;
}
```

### 3. `src/runtime/sdk-runner.ts` — pass node.formatCommand

Line 100 (buildNodeEnv call):

```typescript
buildNodeEnv(
  config,
  runId,
  nodeId,
  runDir,
  worktreePath,
  storeDir,
  node.formatCommand,
);
```

### 4. `.claude/hooks/pre-tool-use-commit.sh` — new hook (create)

```bash
#!/usr/bin/env bash
# pre-tool-use-commit.sh — PreToolUse hook: run format commands before git commit.
#
# CONTRACT (Claude Code PreToolUse hook):
#   - Receives a JSON event on stdin; tool_input.command is the shell command.
#   - exit 0                              => allow the tool to run.
#   - {"decision":"block","reason":"..."} => block the tool; agent sees the reason.
#
# Required env var (optional — if unset, this hook is a no-op):
#   DAGRUN_FORMAT_CMD — shell command to run before git commit
#                        (e.g. "./mvnw spotless:apply --no-transfer-progress")
#   DAGRUN_WORKTREE   — absolute path to the node's git worktree
#
# Failure policy: FAIL LOUD — format errors block the commit. A broken formatter
#   must never produce a silently-committed unformatted file.

set -uo pipefail

# --- no-op when format command is not configured ------------------------------

[[ -n "${DAGRUN_FORMAT_CMD:-}" ]] || exit 0

# --- require jq to parse stdin ------------------------------------------------

command -v jq >/dev/null 2>&1 || exit 0

# --- check if this is a git commit Bash call ----------------------------------

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[[ -n "$cmd" ]] || exit 0

# Only act on git commit commands (not git commit --amend etc. — all are fine)
echo "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+commit([[:space:]]|$)' || exit 0

# --- helpers ------------------------------------------------------------------

block() {
  local reason
  reason=$(printf '%s' "$1" | tr '\n' ' ')
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "${reason}" '{"decision":"block","reason":$r}'
  else
    printf '{"decision":"block","reason":"%s"}\n' "${reason//\"/\\\"}"
  fi
  exit 0
}

# --- validate worktree ---------------------------------------------------

if [[ -z "${DAGRUN_WORKTREE:-}" ]]; then
  block "pre-commit-format: DAGRUN_WORKTREE is not set; cannot run format command"
fi

if [[ ! -d "${DAGRUN_WORKTREE}" ]]; then
  block "pre-commit-format: DAGRUN_WORKTREE '${DAGRUN_WORKTREE}' does not exist"
fi

# --- run format command in the worktree --------------------------------------

cd "${DAGRUN_WORKTREE}" || block "pre-commit-format: cannot cd to '${DAGRUN_WORKTREE}'"

FORMAT_OUTPUT=""
FORMAT_EXIT=0
FORMAT_OUTPUT=$(eval "${DAGRUN_FORMAT_CMD}" 2>&1) || FORMAT_EXIT=$?

if [[ "${FORMAT_EXIT}" -ne 0 ]]; then
  TRUNCATED=$(printf '%s' "${FORMAT_OUTPUT}" | head -10)
  block "pre-commit-format: format command exited ${FORMAT_EXIT}: ${TRUNCATED}"
fi

# Re-stage any files the formatter rewrote so they land in the commit.
# -u covers modifications to files already in the index (tracked); new files
# the agent staged with `git add path` are also covered because they are
# already indexed and thus "tracked" for git-add purposes.
git add -u || block "pre-commit-format: git add -u failed after formatting"

exit 0
```

### 5. `src/config/settings-seed.ts` — wire PreToolUse hook

In `buildSeededSettings`, inside `hooks:`, add a PreToolUse entry for Bash BEFORE the
existing PostToolUse entry:

```json
PreToolUse: [
  {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-tool-use-commit.sh",
      },
    ],
  },
],
```

### 6. `src/workflow/feature-workflow.ts` — add formatCommand to implement and fix nodes

```typescript
{
  id: "implement",
  dependsOn: ["expand"],
  command: "/implement",
  produces: ["summary.md"],
  formatCommand: "./mvnw spotless:apply --no-transfer-progress",
},
{
  id: "fix",
  dependsOn: ["review"],
  command: "/fix",
  produces: ["summary.md"],
  gate: { maxIterations: 5, onReject: "revise-self" },
  revisionInstruction: "...",  // keep existing
  formatCommand: "./mvnw spotless:apply --no-transfer-progress",
},
```

## Tests to update / verify

- `src/config/settings-seed.golden.json` — will need `UPDATE_SNAPSHOTS=1 npm test` to regenerate
  (new PreToolUse entry added)
- `src/workflow/feature-workflow.test.ts` — `featureWorkflow` passes `loadWorkflow` already; the
  new optional field needs no new fixture unless the test checks exact node shapes
- `src/runtime/launcher.ts` — the type change is backward-compatible (optional field)

## Done criteria

- `npm test` passes (after snapshot regeneration)
- `npm run build` compiles clean
- `pre-tool-use-commit.sh` is executable (chmod +x)
- `settings-seed.golden.json` shows the new PreToolUse hook
