#!/usr/bin/env bash
# build-queue.sh (v2) — run an ordered queue of /dr-build plans, gating each on verify-baseline.
# v2 adds OBSERVABILITY over v1: live build output (tail -f), a heartbeat during quiet stretches,
# and a per-step TIMEOUT that kills a hung build/verify and stops the queue.
# STOP-ON-FAIL. Logs live OUTSIDE the repo (dagrunner home) so they never dirty the tree.
#
# Usage:  scripts/build-queue.sh docs/changes/a.md docs/changes/b.md   (run from repo root)

set -uo pipefail

# ── CONFIG ──────────────────────────────────────────────────────────────────
DAGRUNNER_DIR="${DAGRUNNER_DIR:-$HOME/dev/dagrunner}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
VERIFY_CMD="${VERIFY_CMD:-npm run verify-baseline}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
PER_STEP_TIMEOUT="${PER_STEP_TIMEOUT:-5400}"   # 90 min — kill a build/verify that exceeds this
HEARTBEAT="${HEARTBEAT:-300}"                  # 5 min — elapsed ping during quiet stretches
# ────────────────────────────────────────────────────────────────────────────

if [ -z "${NQ_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  exec env NQ_CAFFEINATED=1 caffeinate -dis "$0" "$@"
fi

cd "$DAGRUNNER_DIR" || { echo "ERROR: DAGRUNNER_DIR not found: $DAGRUNNER_DIR" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found on PATH" >&2; exit 1; }
[ "$#" -ge 1 ] || { echo "ERROR: pass plan files in order (e.g. docs/changes/a.md docs/changes/b.md)" >&2; exit 1; }

PLANS=("$@")
TS="$(date +%Y%m%d-%H%M%S)"
LOGDIR="$DAGRUNNER_HOME/build-queue/$TS"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/queue.log"

log(){ echo "$*" | tee -a "$LOG"; }
clean_tree(){ [ -z "$(git status --porcelain)" ]; }

# run_watched <label> <outfile> -- <cmd...>
#   streams output live (tail -f), prints an elapsed heartbeat during quiet stretches,
#   and KILLS the command if it exceeds PER_STEP_TIMEOUT. Returns: cmd rc, or 124 on timeout.
run_watched() {
  local label="$1" out="$2"; shift 2; [ "$1" = "--" ] && shift
  : > "$out"
  local start; start=$(date +%s)
  "$@" >"$out" 2>&1 &           # the work, output to file
  local pid=$!
  tail -f "$out" 2>/dev/null &  # live view to terminal (BSD-portable)
  local tailpid=$!
  local last_hb=$start timed_out=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 15
    local now; now=$(date +%s)
    if [ $(( now - start )) -ge "$PER_STEP_TIMEOUT" ]; then
      timed_out=1
      kill -TERM "$pid" 2>/dev/null; sleep 3; kill -KILL "$pid" 2>/dev/null
      break
    fi
    if [ $(( now - last_hb )) -ge "$HEARTBEAT" ]; then
      log "    ⏳ $label — $(( (now-start)/60 ))m elapsed, still running (timeout $((PER_STEP_TIMEOUT/60))m)…"
      last_hb=$now
    fi
  done
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$tailpid" 2>/dev/null; wait "$tailpid" 2>/dev/null
  [ "$timed_out" -eq 1 ] && return 124
  return "$rc"
}

trap 'log "INTERRUPTED at $(date "+%H:%M:%S")."' INT TERM

log "build-queue $TS — ${#PLANS[@]} plan(s) queued"
log "repo: $DAGRUNNER_DIR    branch: $(git rev-parse --abbrev-ref HEAD)"
log "logs: $LOGDIR    per-step timeout: $((PER_STEP_TIMEOUT/60))m"
log ""

clean_tree || { log "ABORT: working tree dirty before starting. Commit/stash first."; exit 1; }
for p in "${PLANS[@]}"; do [ -f "$p" ] || { log "ABORT: plan not found: $p"; exit 1; }; done

i=0
for plan in "${PLANS[@]}"; do
  i=$((i+1)); name="$(basename "$plan")"; label="[$i/${#PLANS[@]}] $name"
  bout="$LOGDIR/$i-$name.build.out"; vout="$LOGDIR/$i-$name.verify.out"
  decbefore="$LOGDIR/$i-decisions.before"; cp -f DECISIONS.md "$decbefore" 2>/dev/null || : > "$decbefore"

  log "── $label ──────────────────────────────"
  log "  $(date '+%H:%M:%S')  building (live output below)…"
  run_watched "build $label" "$bout" -- $CLAUDE_CMD "/dr-build $plan"
  case $? in
    124) log "  STOP — build TIMED OUT after $((PER_STEP_TIMEOUT/60))m (possibly stuck). See $bout"; exit 5 ;;
    0)   : ;;
    *)   log "  STOP — builder exited non-zero. See $bout"; exit 2 ;;
  esac

  log "  $(date '+%H:%M:%S')  verify-baseline (live output below)…"
  run_watched "verify $label" "$vout" -- $VERIFY_CMD
  case $? in
    124) log "  STOP — verify-baseline TIMED OUT after $((PER_STEP_TIMEOUT/60))m. See $vout"; exit 5 ;;
    0)   : ;;
    *)   log "  STOP — verify-baseline FAILED. See $vout"; exit 3 ;;
  esac

  clean_tree || { log "  STOP — builder left uncommitted changes (dirty tree after green build)."; exit 4; }

  if ! diff -q "$decbefore" DECISIONS.md >/dev/null 2>&1; then
    log "  ✓ committed. NEW DECISIONS.md entries to review."
  else
    log "  ✓ committed."
  fi
  log ""
done

log "ALL ${#PLANS[@]} plan(s) completed and committed; verify-baseline green throughout."
log "Review: 'git log', DECISIONS.md, and per-plan output in $LOGDIR"
