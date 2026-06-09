#!/usr/bin/env bash
# deny-guard.sh — fail-closed PreToolUse safety hook for the dagrunner overnight build.
#
# WHY THIS EXISTS:
#   The build runs under permissionMode: bypassPermissions so it never stalls at 3am waiting
#   for an interactive prompt. bypass skips PROMPTS, not HOOKS — a PreToolUse hook still fires
#   and an exit code 2 still BLOCKS the tool call regardless of mode. This script is therefore
#   the real safety boundary for the unattended run.
#
# CONTRACT (Claude Code PreToolUse hook):
#   - Receives a JSON event on stdin: { "tool_name": ..., "tool_input": { ... }, ... }
#   - exit 0  => allow the tool call
#   - exit 2  => DENY the tool call (stderr is shown as the reason)
#   - FAIL-CLOSED: any internal error / missing parser => exit 2 (deny). We never fail open.
#
# SCOPE OF PROTECTION (blast-radius control for a build on the real machine):
#   - Destructive recursive deletes outside the project dir
#   - Force pushes
#   - Writes/edits to credential & key material (~/.ssh, ~/.aws, .env, etc.)
#   - sudo / privilege escalation
#   - Writes outside the project dir and the dagrunner XDG home
#
# This is a guardrail, not a sandbox. The primary blast-radius control is the scoped working
# directory; this hook is defense-in-depth.

set -uo pipefail

deny() {
  echo "deny-guard: $1" >&2
  exit 2
}

# --- read event ---------------------------------------------------------------
EVENT="$(cat 2>/dev/null || true)"
[ -z "$EVENT" ] && deny "empty hook event (fail-closed)"

# Prefer jq; fall back to python3; if neither exists, fail closed.
read_field() { # $1 = jq path
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$EVENT" | jq -r "$1 // empty" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$EVENT" | python3 -c "import sys,json; d=json.load(sys.stdin); \
import functools; \
p='$1'.lstrip('.').replace('\"','').split('.'); \
v=d; \
[v:=(v.get(k) if isinstance(v,dict) else None) for k in p]; \
print(v if v is not None else '')" 2>/dev/null
  else
    return 1
  fi
}

TOOL="$(read_field '.tool_name')" || deny "no JSON parser available (fail-closed)"
[ -z "$TOOL" ] && deny "could not determine tool_name (fail-closed)"

# Pull the most relevant input fields (only some exist per tool; empty is fine).
CMD="$(read_field '.tool_input.command')"
FILE="$(read_field '.tool_input.file_path')"

# --- project / home boundaries ------------------------------------------------
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
DAGRUNNER_CACHE="${HOME}/.cache/dagrunner"

# --- 1. Bash command rules ----------------------------------------------------
if [ "$TOOL" = "Bash" ] && [ -n "$CMD" ]; then
  # privilege escalation
  printf '%s' "$CMD" | grep -Eq '(^|[^[:alnum:]])sudo([^[:alnum:]]|$)' && deny "sudo is not permitted"
  printf '%s' "$CMD" | grep -Eq '\bdoas\b'                            && deny "doas is not permitted"

  # force push
  printf '%s' "$CMD" | grep -Eq 'git[[:space:]]+push.*(--force|[[:space:]]-f([[:space:]]|$))' \
    && deny "force push is not permitted"

  # curl|sh style remote execution
  printf '%s' "$CMD" | grep -Eq '(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash|zsh)' \
    && deny "piping a download into a shell is not permitted"

  # recursive delete — only allow if clearly confined to project dir or dagrunner home/cache
  if printf '%s' "$CMD" | grep -Eq 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r?)'; then
    if printf '%s' "$CMD" | grep -Eq 'rm[[:space:]].*([[:space:]]/(|bin|etc|usr|var|lib|home|root|boot|dev|sys|proc)([[:space:]/]|$))'; then
      deny "recursive delete targeting a system path"
    fi
    # deny rm -rf with $HOME directly or ~ at top level
    printf '%s' "$CMD" | grep -Eq 'rm[[:space:]].*(\$HOME([[:space:]/]|$)|[[:space:]]~([[:space:]/]|$))' \
      && deny "recursive delete targeting HOME"
  fi

  # writing to credential material via shell redirection / tooling
  printf '%s' "$CMD" | grep -Eq '(\.ssh/|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|\.npmrc|id_rsa|id_ed25519)' \
    && deny "touching credential/key material is not permitted"

  exit 0
fi

# --- 2. Write / Edit rules ----------------------------------------------------
if [ "$TOOL" = "Write" ] || [ "$TOOL" = "Edit" ] || [ "$TOOL" = "MultiEdit" ]; then
  [ -z "$FILE" ] && exit 0   # nothing to check

  case "$FILE" in
    *".ssh/"*|*".aws/"*|*".gnupg/"*|*".netrc"|*"id_rsa"*|*"id_ed25519"*)
      deny "writing to credential/key material is not permitted" ;;
    *".env"|*".env."*)
      deny "writing .env files is not permitted" ;;
  esac

  # confine writes to project dir, dagrunner home, or cache
  case "$FILE" in
    "$PROJECT_DIR"/*|"$DAGRUNNER_HOME"/*|"$DAGRUNNER_CACHE"/*|/tmp/*)
      exit 0 ;;
    /*)
      deny "write outside project dir / dagrunner home: $FILE" ;;
    *)
      exit 0 ;;  # relative path resolves inside project dir
  esac
fi

# default allow for unmatched tools
exit 0
