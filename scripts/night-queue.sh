#!/usr/bin/env bash
# night-queue.sh — run an ordered queue of /dr-build plans unattended, overnight.
#
# For each plan, in order:
#   1. build it headless:  claude -p "/dr-build <plan>"   (inherits bypass + deny-guard)
#   2. gate:               npm run verify-baseline  must exit 0
#   3. gate:               the builder must have committed (clean git tree)
# STOP-ON-FAIL: the first failure halts the whole queue and leaves everything for morning triage.
# Logs are written OUTSIDE the repo (dagrunner home) so they never dirty the working tree.
#
# Usage (plans in the order you want them run):
#   ./night-queue.sh docs/changes/unit-test-backfill-2a-tier-a-core.md \
#                    docs/changes/unit-test-backfill-2b-tier-b-golden-schema.md

set -uo pipefail

# ── CONFIG ──────────────────────────────────────────────────────────────────
DAGRUNNER_DIR="${DAGRUNNER_DIR:-$HOME/dev/dagrunner}"
# The verified headless invocation. If your CLI supports a per-run budget/turn cap, append it here.
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
VERIFY_CMD="${VERIFY_CMD:-npm run verify-baseline}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
# ────────────────────────────────────────────────────────────────────────────

# Keep the Mac awake for the whole run (re-exec self under caffeinate once).
if [ -z "${NQ_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  exec env NQ_CAFFEINATED=1 caffeinate -dis "$0" "$@"
fi

cd "$DAGRUNNER_DIR" || { echo "ERROR: DAGRUNNER_DIR not found: $DAGRUNNER_DIR" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found on PATH" >&2; exit 1; }
[ "$#" -ge 1 ] || { echo "ERROR: pass plan files in order (e.g. docs/changes/a.md docs/changes/b.md)" >&2; exit 1; }

PLANS=("$@")
TS="$(date +%Y%m%d-%H%M%S)"
LOGDIR="$DAGRUNNER_HOME/night-queue/$TS"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/queue.log"

log(){ echo "$*" | tee -a "$LOG"; }
clean_tree(){ [ -z "$(git status --porcelain)" ]; }
trap 'log "INTERRUPTED at $(date "+%H:%M:%S"). Queue stopped."' INT TERM

log "night-queue $TS — ${#PLANS[@]} plan(s) queued"
log "repo: $DAGRUNNER_DIR    branch: $(git rev-parse --abbrev-ref HEAD)"
log "logs: $LOGDIR"
log ""

# Preconditions: clean tree, and every plan file exists, before we touch anything.
if ! clean_tree; then
  log "ABORT: working tree is dirty before starting. Commit or stash first."
  exit 1
fi
for p in "${PLANS[@]}"; do
  [ -f "$p" ] || { log "ABORT: plan not found: $p"; exit 1; }
done

i=0
for plan in "${PLANS[@]}"; do
  i=$((i+1)); name="$(basename "$plan")"
  out="$LOGDIR/$i-$name.build.out"
  vout="$LOGDIR/$i-$name.verify.out"
  decbefore="$LOGDIR/$i-decisions.before"
  cp -f DECISIONS.md "$decbefore" 2>/dev/null || : > "$decbefore"

  log "── [$i/${#PLANS[@]}] $name ──────────────────────────────"
  log "  $(date '+%H:%M:%S')  building…"
  if ! $CLAUDE_CMD "/dr-build $plan" >"$out" 2>&1; then
    log "  STOP — builder exited non-zero. See $out"
    log "  Queue halted at plan $i/${#PLANS[@]}."
    exit 2
  fi

  log "  $(date '+%H:%M:%S')  verify-baseline…"
  if ! $VERIFY_CMD >"$vout" 2>&1; then
    log "  STOP — verify-baseline FAILED. See $vout"
    log "  Queue halted at plan $i/${#PLANS[@]}."
    exit 3
  fi

  if ! clean_tree; then
    log "  STOP — builder left uncommitted changes (tree dirty after a green build)."
    log "  Inspect 'git status' in $DAGRUNNER_DIR. Queue halted at plan $i/${#PLANS[@]}."
    exit 4
  fi

  if ! diff -q "$decbefore" DECISIONS.md >/dev/null 2>&1; then
    log "  ✓ committed. NEW DECISIONS.md entries to review (the builder made judgment calls)."
  else
    log "  ✓ committed."
  fi
  log ""
done

log "ALL ${#PLANS[@]} plan(s) completed and committed; verify-baseline green throughout."
log "Morning review: 'git log', DECISIONS.md, and per-plan output in:"
log "  $LOGDIR"
