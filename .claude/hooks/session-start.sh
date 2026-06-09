#!/usr/bin/env bash
# session-start.sh — SessionStart hook: sync private files from DEVHARNESS_SRC into worktree.
#
# CONTRACT (Claude Code SessionStart hook):
#   - Receives a JSON event on stdin (not used here).
#   - exit 0           => allow the session to proceed.
#   - {"decision":"block","reason":"..."} on stdout => block the session from starting.
#
# Required env vars (must be set by launcher BEFORE spawning SDK query()):
#   DEVHARNESS_SRC    — path to the main checkout (source of private .claude/ files)
#   DAGRUN_WORKTREE   — absolute path to the worktree for this node's run
#
# Sync behaviour:
#   Copies .devharness/, CLAUDE.local.md, and nested apply-reflection CLAUDE.local.md
#   files from DEVHARNESS_SRC into the worktree. Existing worktree files win
#   (--ignore-existing) so committed worktree content is never silently overwritten.
#
# Failure policy: FAIL the node if DEVHARNESS_SRC is unreadable. A broken sync
#   must never look like success. (Note: the block JSON signals the intent; hard
#   enforcement of node cancellation is the launcher's responsibility when it
#   processes the hook output.)

set -uo pipefail

# --- helpers ------------------------------------------------------------------

block() {
  # Emit a JSON block decision. Escape reason via printf.
  local reason
  reason=$(printf '%s' "$1" | tr '\n' ' ')
  printf '{"decision":"block","reason":"%s"}\n' "${reason//\"/\\\"}"
  exit 0
}

# --- validate required env vars -----------------------------------------------

if [[ -z "${DEVHARNESS_SRC:-}" ]]; then
  block "SessionStart: DEVHARNESS_SRC is not set — cannot sync private files"
fi

if [[ -z "${DAGRUN_WORKTREE:-}" ]]; then
  block "SessionStart: DAGRUN_WORKTREE is not set — cannot sync private files"
fi

# --- validate DEVHARNESS_SRC is accessible ------------------------------------

if [[ ! -d "${DEVHARNESS_SRC}" ]]; then
  block "SessionStart: DEVHARNESS_SRC '${DEVHARNESS_SRC}' is not an accessible directory"
fi

if [[ ! -r "${DEVHARNESS_SRC}" ]]; then
  block "SessionStart: DEVHARNESS_SRC '${DEVHARNESS_SRC}' is not readable"
fi

# --- ensure worktree destination exists --------------------------------------

if [[ ! -d "${DAGRUN_WORKTREE}" ]]; then
  block "SessionStart: DAGRUN_WORKTREE '${DAGRUN_WORKTREE}' does not exist"
fi

# --- sync private .claude/ files ---------------------------------------------

SRC_CLAUDE="${DEVHARNESS_SRC}/.claude"
DEST_CLAUDE="${DAGRUN_WORKTREE}/.claude"

if [[ -d "${SRC_CLAUDE}" ]]; then
  # rsync: src .claude/ → worktree .claude/
  # --ignore-existing: existing worktree files win (never silently overwrite committed content)
  # Failure is non-fatal only if rsync is missing; actual sync errors should not be swallowed.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --ignore-existing "${SRC_CLAUDE}/" "${DEST_CLAUDE}/" \
      || block "SessionStart: rsync of .claude/ failed (exit $?)"
  else
    # Fallback: cp -n (no-clobber) for systems without rsync
    mkdir -p "${DEST_CLAUDE}"
    cp -rn "${SRC_CLAUDE}/." "${DEST_CLAUDE}/" 2>/dev/null \
      || true  # cp -n exits non-zero when files are skipped on some platforms; ignore
  fi
fi

# --- sync .devharness/ -------------------------------------------------------

SRC_DEVHARNESS="${DEVHARNESS_SRC}/.devharness"
DEST_DEVHARNESS="${DAGRUN_WORKTREE}/.devharness"

if [[ -d "${SRC_DEVHARNESS}" ]]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --ignore-existing "${SRC_DEVHARNESS}/" "${DEST_DEVHARNESS}/" \
      || block "SessionStart: rsync of .devharness/ failed (exit $?)"
  else
    mkdir -p "${DEST_DEVHARNESS}"
    cp -rn "${SRC_DEVHARNESS}/." "${DEST_DEVHARNESS}/" 2>/dev/null || true
  fi
fi

# --- sync root CLAUDE.local.md -----------------------------------------------

SRC_LOCAL_MD="${DEVHARNESS_SRC}/CLAUDE.local.md"
DEST_LOCAL_MD="${DAGRUN_WORKTREE}/CLAUDE.local.md"

if [[ -f "${SRC_LOCAL_MD}" ]] && [[ ! -f "${DEST_LOCAL_MD}" ]]; then
  cp "${SRC_LOCAL_MD}" "${DEST_LOCAL_MD}" \
    || block "SessionStart: failed to copy CLAUDE.local.md"
fi

exit 0
