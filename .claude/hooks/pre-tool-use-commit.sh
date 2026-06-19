#!/usr/bin/env bash
# pre-tool-use-commit.sh — PreToolUse hook: run format commands before git commit.
#
# CONTRACT (Claude Code PreToolUse hook):
#   - Receives a JSON event on stdin; tool_input.command is the shell command.
#   - exit 0                              => allow the tool to run.
#   - {"decision":"block","reason":"..."} => block the tool; agent sees the reason.
#
# Required env vars:
#   DAGRUN_FORMAT_CMD — shell command to run before git commit; absent = no-op.
#                       Example: "./mvnw spotless:apply --no-transfer-progress"
#   DAGRUN_WORKTREE   — absolute path to the node's git worktree.
#
# Failure policy: FAIL LOUD — format errors block the commit. A broken formatter
#   must never produce a silently-committed unformatted file.

set -uo pipefail

# --- no-op when format command is not configured ------------------------------

[[ -n "${DAGRUN_FORMAT_CMD:-}" ]] || exit 0

# --- require jq to parse stdin ------------------------------------------------

command -v jq >/dev/null 2>&1 || exit 0

# --- extract the Bash command from the hook payload ---------------------------

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[[ -n "$cmd" ]] || exit 0

# Only act on git commit invocations (matches: git commit, && git commit, ; git commit, etc.)
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

# --- validate worktree --------------------------------------------------------

if [[ -z "${DAGRUN_WORKTREE:-}" ]]; then
  block "pre-commit-format: DAGRUN_WORKTREE is not set; cannot run format command"
fi

if [[ ! -d "${DAGRUN_WORKTREE}" ]]; then
  block "pre-commit-format: DAGRUN_WORKTREE '${DAGRUN_WORKTREE}' does not exist"
fi

# --- run the format command in the worktree -----------------------------------

cd "${DAGRUN_WORKTREE}" || block "pre-commit-format: cannot cd to '${DAGRUN_WORKTREE}'"

FORMAT_OUTPUT=""
FORMAT_EXIT=0
FORMAT_OUTPUT=$(eval "${DAGRUN_FORMAT_CMD}" 2>&1) || FORMAT_EXIT=$?

if [[ "${FORMAT_EXIT}" -ne 0 ]]; then
  TRUNCATED=$(printf '%s' "${FORMAT_OUTPUT}" | head -10)
  block "pre-commit-format: format command exited ${FORMAT_EXIT}: ${TRUNCATED}"
fi

# Re-stage any files the formatter rewrote so they land in the commit.
# -u updates all tracked files (those already in the index), which covers:
#   - files the agent modified and staged, then spotless reformatted on disk
#   - new files the agent staged with `git add path` (indexed = tracked)
git add -u || block "pre-commit-format: git add -u failed after formatting"

exit 0
