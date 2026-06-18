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
#   Copies .claude/commands/, .claude/scripts/, .devharness/, and CLAUDE.local.md
#   from DEVHARNESS_SRC into the worktree. Existing worktree files win
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
  # Not running inside a dagrunner worktree — nothing to sync, allow the session.
  exit 0
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

# --- sync .claude/commands/ only — never touch settings.json ----------------
#
# We only sync the commands/ subdirectory from DEVHARNESS_SRC so users can
# override the seeded node commands (expand, implement, review, etc.) with their own.
# We deliberately EXCLUDE settings.json: dagrunner seeds a minimal node-run
# settings.json (hooks only, no build-harness deny-guard) and that file must
# survive untouched. A blanket sync of all of .claude/ would overwrite it with
# whatever the source repo has, pulling in hooks/permissions never intended for
# node runs.

SRC_CLAUDE="${DEVHARNESS_SRC}/.claude"
DEST_CLAUDE="${DAGRUN_WORKTREE}/.claude"

if [[ -d "${SRC_CLAUDE}/commands" ]]; then
  mkdir -p "${DEST_CLAUDE}/commands"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${SRC_CLAUDE}/commands/" "${DEST_CLAUDE}/commands/" \
      || block "SessionStart: rsync of .claude/commands/ failed (exit $?)"
  else
    # Fallback: cp (overwrite) for systems without rsync
    cp -r "${SRC_CLAUDE}/commands/." "${DEST_CLAUDE}/commands/" 2>/dev/null \
      || true
  fi
fi

if [[ -d "${SRC_CLAUDE}/scripts" ]]; then
  mkdir -p "${DEST_CLAUDE}/scripts"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${SRC_CLAUDE}/scripts/" "${DEST_CLAUDE}/scripts/" \
      || block "SessionStart: rsync of .claude/scripts/ failed (exit $?)"
  else
    cp -r "${SRC_CLAUDE}/scripts/." "${DEST_CLAUDE}/scripts/" 2>/dev/null \
      || true
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
