#!/bin/zsh
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
RUN_ID="${DAGRUN_RUN_ID:-$(echo "$BRANCH" | sed -E 's/^feat(ure)?\///')}"
ARTIFACTS_DIR="${DAGRUN_ARTIFACTS:-$HOME/.local/share/dagrunner/runs/${RUN_ID}/pr-triage}"
STATE_FILE="$ARTIFACTS_DIR/pr-triage-state.json"
TICK_FILE="$ARTIFACTS_DIR/pr-triage-tick.json"
TRIAGE_STATE="$ARTIFACTS_DIR/triage-state.json"
NEW_OR_EDITED_FILE="$ARTIFACTS_DIR/new-or-edited.json"
INLINE_FILE="$ARTIFACTS_DIR/inline-raw.json"
ISSUE_FILE="$ARTIFACTS_DIR/issue-raw.json"
REVIEWS_FILTERED_FILE="$ARTIFACTS_DIR/reviews-filtered.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: State file not found: $STATE_FILE"
  exit 1
fi
if [ ! -f "$TICK_FILE" ]; then
  echo "ERROR: Tick file not found: $TICK_FILE"
  exit 1
fi

PR_NUMBER=$(jq -r .pr_number "$STATE_FILE")
WORKTREE_SHA=$(jq -r '.worktree_sha' "$TICK_FILE")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TICK_LOG="$ARTIFACTS_DIR/tick-${TS}.md"

# Initialize working state — write to a temp file, never accumulate in a shell variable
TRIAGE_STATE_TMP="$ARTIFACTS_DIR/triage-state-new.json"
if [ -f "$TRIAGE_STATE" ]; then
  cp "$TRIAGE_STATE" "$TRIAGE_STATE_TMP"
else
  jq -n --arg run_id "$RUN_ID" '{"run_id": $run_id, "comments": {}}' > "$TRIAGE_STATE_TMP"
fi

# Update state for all new_or_edited comments in one jq pass — no shell variable capture of JSON
jq \
  --slurpfile entries "$NEW_OR_EDITED_FILE" \
  --slurpfile inline "$INLINE_FILE" \
  --slurpfile issues "$ISSUE_FILE" \
  --slurpfile reviews "$REVIEWS_FILTERED_FILE" \
  '
  reduce ($entries[0][]) as $entry (
    .;
    ($entry.source) as $src |
    (if $src == "inline" then ($entry.id | tostring)
     elif $src == "issue" then "issue_" + ($entry.id | tostring)
     else "review_" + ($entry.id | tostring) end) as $key |
    (.comments[$key].lifecycle // "") as $existing_lc |

    if $existing_lc == "" then
      (if $src == "inline" then ($inline[0] | map(select(.id == $entry.id)) | .[0])
       elif $src == "issue" then ($issues[0] | map(select(.id == $entry.id)) | .[0])
       else ($reviews[0] | map(select(.id == $entry.id)) | .[0]) end) as $cd |
      .comments[$key] = {
        id: $entry.id,
        source: $src,
        lifecycle: "seen",
        author: ($cd.user.login // ""),
        author_type: ($cd.user.type // ""),
        path: ($cd.path // ""),
        line: ($cd.line // "" | tostring),
        body: (($cd.body // "") | .[0:300]),
        created_at: (($cd.created_at // $cd.submitted_at) // ""),
        updated_at: $entry.updated_at
      }
    elif ($entry.is_edit == true) and ($existing_lc == "drafted") then
      .comments[$key].lifecycle = "superseded" |
      .comments[$key].updated_at = $entry.updated_at |
      .comments[$key].prior_draft_file = (.comments[$key].draft_file // "") |
      .comments[$key].draft_file = ""
    else
      .
    end
  )
  ' "$TRIAGE_STATE_TMP" > "$ARTIFACTS_DIR/triage-state-updated.json"

# Advance timestamp markers
jq \
  --arg ts "$TS" \
  --arg sha "$WORKTREE_SHA" \
  '. + {"last_tick_at": $ts, "last_fetched_sha": $sha}' \
  "$ARTIFACTS_DIR/triage-state-updated.json" > "$TRIAGE_STATE"

rm -f "$TRIAGE_STATE_TMP" "$ARTIFACTS_DIR/triage-state-updated.json"

echo "triage-state updated: last_tick=${TS}  sha=${WORKTREE_SHA:0:8}"

# Write tick log — read counts from files, not variables
TOTAL_INLINE=$(jq 'length' "$INLINE_FILE")
TOTAL_ISSUE=$(jq 'length' "$ISSUE_FILE")
TOTAL_REVIEW=$(jq 'length' "$REVIEWS_FILTERED_FILE")
NEW_COUNT=$(jq 'length' "$NEW_OR_EDITED_FILE")

LIFECYCLE_SUMMARY=$(jq -r '
  .comments | to_entries |
  group_by(.value.lifecycle) |
  map({lifecycle: .[0].value.lifecycle, count: length}) |
  .[] | "  \(.lifecycle): \(.count)"' "$TRIAGE_STATE")

NEW_OR_EDITED_LOG=$(jq -r '.[] | "  [\(.source)] id=\(.id) login=\(.login) edit=\(.is_edit)"' "$NEW_OR_EDITED_FILE" 2>/dev/null || echo "  (none)")

cat > "$TICK_LOG" << LOGEOF
# pr-triage tick — ${TS}

PR: #${PR_NUMBER}
Worktree SHA: ${WORKTREE_SHA}

## Fetched

inline=${TOTAL_INLINE}  issue=${TOTAL_ISSUE}  reviews=${TOTAL_REVIEW}
New/edited this tick: ${NEW_COUNT}

## New/edited comments

${NEW_OR_EDITED_LOG}

## Lifecycle summary

${LIFECYCLE_SUMMARY:-  (no comments in state)}
LOGEOF

echo "Tick log: $TICK_LOG"
