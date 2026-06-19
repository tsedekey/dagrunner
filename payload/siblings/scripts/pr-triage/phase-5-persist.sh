#!/bin/zsh
set -euo pipefail

ARTIFACTS_DIR=$(jq -r .artifacts /tmp/pr-triage-state.json)
RUN_ID=$(jq -r .run_id /tmp/pr-triage-state.json)
PR_NUMBER=$(jq -r .pr_number /tmp/pr-triage-state.json)
TRIAGE_STATE="$ARTIFACTS_DIR/triage-state.json"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TICK_LOG="$ARTIFACTS_DIR/tick-${TS}.md"
WORKTREE_SHA=$(jq -r '.worktree_sha' /tmp/pr-triage-tick.json)
NEW_OR_EDITED=$(jq -c '.new_or_edited' /tmp/pr-triage-tick.json)
INLINE_COMMENTS=$(jq -c '.inline_comments' /tmp/pr-triage-tick.json)
ISSUE_COMMENTS=$(jq -c '.issue_comments' /tmp/pr-triage-tick.json)
REVIEW_SUMMARIES=$(jq -c '.review_summaries' /tmp/pr-triage-tick.json)

# Load or initialize triage-state.json
if [ -f "$TRIAGE_STATE" ]; then
  CURRENT_STATE=$(cat "$TRIAGE_STATE")
else
  CURRENT_STATE=$(jq -n --arg run_id "$RUN_ID" '{"run_id": $run_id, "comments": {}}')
fi

# For each new_or_edited comment not already in triage-state, add it with lifecycle: seen.
# Comments already processed (drafted/posted/skipped) by phase 3/4 model work are untouched —
# their lifecycle was already updated. Only un-touched `seen` entries are added here.
NEW_STATE="$CURRENT_STATE"

while IFS= read -r ENTRY; do
  ID=$(echo "$ENTRY" | jq -r '.id')
  SOURCE=$(echo "$ENTRY" | jq -r '.source')
  IS_EDIT=$(echo "$ENTRY" | jq -r '.is_edit')
  UPDATED_AT=$(echo "$ENTRY" | jq -r '.updated_at')

  # Build the state key: inline uses id, issue uses issue_<id>, review uses review_<id>
  case "$SOURCE" in
    inline) STATE_KEY="$ID" ;;
    issue)  STATE_KEY="issue_${ID}" ;;
    review) STATE_KEY="review_${ID}" ;;
    *)      STATE_KEY="$ID" ;;
  esac

  # Check if this comment is already in state (e.g., phase 4 model already updated it)
  EXISTING_LIFECYCLE=$(echo "$NEW_STATE" | jq -r --arg k "$STATE_KEY" '.comments[$k].lifecycle // ""')

  if [ -z "$EXISTING_LIFECYCLE" ]; then
    # New comment not yet in state — find its body and author from the tick data
    case "$SOURCE" in
      inline)
        COMMENT_DATA=$(echo "$INLINE_COMMENTS" | jq -c --argjson id "$ID" '.[] | select(.id == $id)')
        AUTHOR=$(echo "$COMMENT_DATA" | jq -r '.user.login // ""')
        AUTHOR_TYPE=$(echo "$COMMENT_DATA" | jq -r '.user.type // ""')
        BODY=$(echo "$COMMENT_DATA" | jq -r '.body // ""' | head -c 300)
        PATH_VAL=$(echo "$COMMENT_DATA" | jq -r '.path // ""')
        LINE_VAL=$(echo "$COMMENT_DATA" | jq -r '.line // ""')
        CREATED_AT=$(echo "$COMMENT_DATA" | jq -r '.created_at // ""')
        ;;
      issue)
        COMMENT_DATA=$(echo "$ISSUE_COMMENTS" | jq -c --argjson id "$ID" '.[] | select(.id == $id)')
        AUTHOR=$(echo "$COMMENT_DATA" | jq -r '.user.login // ""')
        AUTHOR_TYPE=$(echo "$COMMENT_DATA" | jq -r '.user.type // ""')
        BODY=$(echo "$COMMENT_DATA" | jq -r '.body // ""' | head -c 300)
        PATH_VAL=""
        LINE_VAL=""
        CREATED_AT=$(echo "$COMMENT_DATA" | jq -r '.created_at // ""')
        ;;
      review)
        COMMENT_DATA=$(echo "$REVIEW_SUMMARIES" | jq -c --argjson id "$ID" '.[] | select(.id == $id)')
        AUTHOR=$(echo "$COMMENT_DATA" | jq -r '.user.login // ""')
        AUTHOR_TYPE=$(echo "$COMMENT_DATA" | jq -r '.user.type // ""')
        BODY=$(echo "$COMMENT_DATA" | jq -r '.body // ""' | head -c 300)
        PATH_VAL=""
        LINE_VAL=""
        CREATED_AT=$(echo "$COMMENT_DATA" | jq -r '.submitted_at // ""')
        ;;
    esac

    NEW_STATE=$(echo "$NEW_STATE" | jq \
      --arg key "$STATE_KEY" \
      --argjson id "$ID" \
      --arg source "$SOURCE" \
      --arg lifecycle "seen" \
      --arg author "$AUTHOR" \
      --arg author_type "$AUTHOR_TYPE" \
      --arg path "$PATH_VAL" \
      --arg line "$LINE_VAL" \
      --arg body "$BODY" \
      --arg created_at "$CREATED_AT" \
      --arg updated_at "$UPDATED_AT" \
      '.comments[$key] = {
        id: $id,
        source: $source,
        lifecycle: $lifecycle,
        author: $author,
        author_type: $author_type,
        path: $path,
        line: $line,
        body: $body,
        created_at: $created_at,
        updated_at: $updated_at
      }')
  elif [ "$IS_EDIT" = "true" ] && [ "$EXISTING_LIFECYCLE" = "drafted" ]; then
    # Comment was edited after we drafted a reply — mark superseded
    PRIOR_DRAFT=$(echo "$NEW_STATE" | jq -r --arg k "$STATE_KEY" '.comments[$k].draft_file // ""')
    NEW_STATE=$(echo "$NEW_STATE" | jq \
      --arg key "$STATE_KEY" \
      --arg updated_at "$UPDATED_AT" \
      --arg prior_draft "$PRIOR_DRAFT" \
      '.comments[$key].lifecycle = "superseded" |
       .comments[$key].updated_at = $updated_at |
       .comments[$key].prior_draft_file = $prior_draft |
       .comments[$key].draft_file = ""')
  fi
done < <(echo "$NEW_OR_EDITED" | jq -c '.[]')

# Update timestamp markers
NEW_STATE=$(echo "$NEW_STATE" | jq \
  --arg ts "$TS" \
  --arg sha "$WORKTREE_SHA" \
  '. + {"last_tick_at": $ts, "last_fetched_sha": $sha}')

echo "$NEW_STATE" > "$TRIAGE_STATE"
echo "triage-state updated: last_tick=${TS}  sha=${WORKTREE_SHA:0:8}"

# Write tick log
TOTAL_INLINE=$(echo "$INLINE_COMMENTS" | jq 'length')
TOTAL_ISSUE=$(echo "$ISSUE_COMMENTS" | jq 'length')
TOTAL_REVIEW=$(echo "$REVIEW_SUMMARIES" | jq 'length')
NEW_COUNT=$(echo "$NEW_OR_EDITED" | jq 'length')

LIFECYCLE_SUMMARY=$(echo "$NEW_STATE" | jq -r '
  .comments | to_entries |
  group_by(.value.lifecycle) |
  map({lifecycle: .[0].value.lifecycle, count: length}) |
  .[] | "  \(.lifecycle): \(.count)"')

cat > "$TICK_LOG" << LOGEOF
# pr-triage tick — ${TS}

PR: #${PR_NUMBER}
Worktree SHA: ${WORKTREE_SHA}

## Fetched

inline=${TOTAL_INLINE}  issue=${TOTAL_ISSUE}  reviews=${TOTAL_REVIEW}
New/edited this tick: ${NEW_COUNT}

## New/edited comments

$(echo "$NEW_OR_EDITED" | jq -r '.[] | "  [\(.source)] id=\(.id) login=\(.login) edit=\(.is_edit)"' 2>/dev/null || echo "  (none)")

## Lifecycle summary

${LIFECYCLE_SUMMARY:-  (no comments in state)}
LOGEOF

echo "Tick log: $TICK_LOG"

rm -f /tmp/pr-triage-state.json /tmp/pr-triage-tick.json
