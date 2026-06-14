#!/usr/bin/env bash
# post-tool-use-format.sh — PostToolUse hook: run prettier on the edited file.
#
# CONTRACT (Claude Code PostToolUse hook):
#   - Receives a JSON event on stdin; tool_input.file_path is the edited file.
#   - exit 0 always — formatting is non-load-bearing; never block a node run.
#
# Covers: Write, Edit, MultiEdit (all carry a single tool_input.file_path;
# MultiEdit edits[] are per-hunk but the target file is the same field).
#
# Failure policy: fail-soft — missing jq, missing prettier, bad path, or
# unparseable stdin → exit 0 quietly.  Formatting problems must never fail
# a node run.

set -uo pipefail

# jq is required to parse the stdin payload; skip gracefully if absent
command -v jq >/dev/null 2>&1 || exit 0

# Extract the edited file path from the JSON payload on stdin.
# .tool_input.file_path is present for Write, Edit, and MultiEdit.
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)

# No-op if field was absent, null, or stdin was unparseable
[[ -n "$file" ]] || exit 0

# No-op if the file doesn't exist on disk
[[ -f "$file" ]] || exit 0

# Only run prettier on frontend/JS/TS files. Reformatting YAML, Java, XML,
# shell scripts, and other non-frontend formats is out of scope and can cause
# unexpected diffs (e.g. single→double quote coercion in YAML).
ext="${file##*.}"
case "$ext" in
  ts|tsx|js|jsx|mjs|cjs|css|scss|less|html|htm) ;;
  *) exit 0 ;;
esac

# Run prettier; swallow errors (fail-soft — formatting never blocks a node)
npx prettier --write "$file" 2>/dev/null || true
