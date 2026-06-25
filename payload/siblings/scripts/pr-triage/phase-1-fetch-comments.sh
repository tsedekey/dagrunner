#!/bin/zsh
set -euo pipefail

# Derive artifacts dir from git — same formula as phase-0, no inter-phase temp file needed
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
RUN_ID="${DAGRUN_RUN_ID:-$(echo "$BRANCH" | sed -E 's/^feat(ure)?\///')}"
ARTIFACTS_DIR="${DAGRUN_ARTIFACTS:-$HOME/.local/share/dagrunner/runs/${RUN_ID}/pr-triage}"
STATE_FILE="$ARTIFACTS_DIR/pr-triage-state.json"
TICK_FILE="$ARTIFACTS_DIR/pr-triage-tick.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: State file not found: $STATE_FILE"
  echo "Run phase-0-bootstrap.sh first."
  exit 1
fi

PR_NUMBER=$(jq -r .pr_number "$STATE_FILE")
REPO_ARG=$(jq -r '.repo' "$STATE_FILE")
TRIAGE_STATE="$ARTIFACTS_DIR/triage-state.json"

if [ -z "$REPO_ARG" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
else
  REPO="$REPO_ARG"
fi
[ -z "$REPO" ] && { echo "ERROR: Could not determine repo name. Pass --repo owner/repo to phase-0."; exit 1; }

# Check PR is still OPEN — write response to file (not shell variable)
PR_STATE_FILE="$ARTIFACTS_DIR/pr-state.json"
gh pr view "$PR_NUMBER" --json state,headRefOid -R "$REPO" > "$PR_STATE_FILE" 2>&1 || {
  echo "ERROR: Could not fetch PR #${PR_NUMBER} state."
  cat "$PR_STATE_FILE"
  exit 1
}
if ! jq -e '.state' "$PR_STATE_FILE" > /dev/null 2>&1; then
  echo "ERROR: PR state response is not valid JSON."
  cat "$PR_STATE_FILE"
  exit 1
fi
PR_STATE=$(jq -r '.state' "$PR_STATE_FILE")
if [ "$PR_STATE" != "OPEN" ]; then
  echo "PR #${PR_NUMBER} is ${PR_STATE} — nothing to triage. Exiting."
  exit 0
fi

WORKTREE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

# Fetch all three endpoints — write directly to files; never capture in shell variables.
# Large comment bodies with \r\n or other control chars corrupt jq when captured via $().
INLINE_FILE="$ARTIFACTS_DIR/inline-raw.json"
ISSUE_FILE="$ARTIFACTS_DIR/issue-raw.json"
REVIEWS_FILE="$ARTIFACTS_DIR/reviews-raw.json"
REVIEWS_FILTERED_FILE="$ARTIFACTS_DIR/reviews-filtered.json"
KNOWN_FILE="$ARTIFACTS_DIR/known-comments.json"
INLINE_NEW_FILE="$ARTIFACTS_DIR/inline-new.json"
ISSUE_NEW_FILE="$ARTIFACTS_DIR/issue-new.json"
REVIEW_NEW_FILE="$ARTIFACTS_DIR/review-new.json"
NEW_OR_EDITED_FILE="$ARTIFACTS_DIR/new-or-edited.json"

gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" > "$INLINE_FILE" 2>&1 || echo "[]" > "$INLINE_FILE"
if ! jq -e 'type == "array"' "$INLINE_FILE" > /dev/null 2>&1; then
  echo "WARNING: Inline comments response was not an array — defaulting to []"
  echo "[]" > "$INLINE_FILE"
fi

gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" > "$ISSUE_FILE" 2>&1 || echo "[]" > "$ISSUE_FILE"
if ! jq -e 'type == "array"' "$ISSUE_FILE" > /dev/null 2>&1; then
  echo "WARNING: Issue comments response was not an array — defaulting to []"
  echo "[]" > "$ISSUE_FILE"
fi

gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" > "$REVIEWS_FILE" 2>&1 || echo "[]" > "$REVIEWS_FILE"
if ! jq -e 'type == "array"' "$REVIEWS_FILE" > /dev/null 2>&1; then
  echo "WARNING: Reviews response was not an array — defaulting to []"
  echo "[]" > "$REVIEWS_FILE"
fi
jq '[.[] | select(.body != null and (.body | length) > 0)]' "$REVIEWS_FILE" > "$REVIEWS_FILTERED_FILE"

# Load known comment state — write to file for --slurpfile consumption
if [ -f "$TRIAGE_STATE" ]; then
  jq '.comments // {}' "$TRIAGE_STATE" > "$KNOWN_FILE"
else
  echo "{}" > "$KNOWN_FILE"
fi

# Build set of IDs we already posted as replies — these must be excluded from new_or_edited
# so the model never tries to triage its own outgoing comments.
POSTED_IDS_FILE="$ARTIFACTS_DIR/posted-ids.json"
if [ -f "$TRIAGE_STATE" ]; then
  jq '[.comments // {} | to_entries[] | .value.posted_comment_id | select(. != null)] | map(tostring) | unique' \
    "$TRIAGE_STATE" > "$POSTED_IDS_FILE"
else
  echo "[]" > "$POSTED_IDS_FILE"
fi

# Compute new_or_edited — use --slurpfile so jq reads from files, not shell variables
jq -c \
  --slurpfile known "$KNOWN_FILE" \
  --slurpfile posted_ids "$POSTED_IDS_FILE" '
  [.[] | . as $c |
    ($c.id | tostring) as $id |
    ($known[0][$id] // null) as $prior |
    if ($posted_ids[0] | index($id)) != null then empty  # own reply — skip
    elif $prior == null then
      {id: $c.id, source: "inline", updated_at: $c.updated_at, is_edit: false,
       login: $c.user.login, user_type: $c.user.type}
    elif $c.updated_at > ($prior.updated_at // "") then
      {id: $c.id, source: "inline", updated_at: $c.updated_at, is_edit: true,
       login: $c.user.login, user_type: $c.user.type}
    else empty
    end
  ]' "$INLINE_FILE" > "$INLINE_NEW_FILE"

jq -c \
  --slurpfile known "$KNOWN_FILE" \
  --slurpfile posted_ids "$POSTED_IDS_FILE" '
  [.[] | . as $c |
    ("issue_" + ($c.id | tostring)) as $id |
    ($c.id | tostring) as $raw_id |
    ($known[0][$id] // null) as $prior |
    if ($posted_ids[0] | index($raw_id)) != null then empty  # own reply — skip
    elif $prior == null then
      {id: $c.id, source: "issue", updated_at: $c.updated_at, is_edit: false,
       login: $c.user.login, user_type: $c.user.type}
    elif $c.updated_at > ($prior.updated_at // "") then
      {id: $c.id, source: "issue", updated_at: $c.updated_at, is_edit: true,
       login: $c.user.login, user_type: $c.user.type}
    else empty
    end
  ]' "$ISSUE_FILE" > "$ISSUE_NEW_FILE"

jq -c \
  --slurpfile known "$KNOWN_FILE" \
  --slurpfile posted_ids "$POSTED_IDS_FILE" '
  [.[] | . as $c |
    ("review_" + ($c.id | tostring)) as $id |
    ($c.id | tostring) as $raw_id |
    ($known[0][$id] // null) as $prior |
    if ($posted_ids[0] | index($raw_id)) != null then empty  # own reply — skip
    elif $prior == null then
      {id: $c.id, source: "review", updated_at: ($c.submitted_at // ""), is_edit: false,
       login: $c.user.login, user_type: $c.user.type}
    else empty
    end
  ]' "$REVIEWS_FILTERED_FILE" > "$REVIEW_NEW_FILE"

jq -s '.[0] + .[1] + .[2]' "$INLINE_NEW_FILE" "$ISSUE_NEW_FILE" "$REVIEW_NEW_FILE" > "$NEW_OR_EDITED_FILE"

# Build tick.json — entirely from files via --slurpfile
jq -n \
  --arg pr "$PR_NUMBER" \
  --arg worktree_sha "$WORKTREE_SHA" \
  --arg repo "$REPO" \
  --slurpfile inline_comments "$INLINE_FILE" \
  --slurpfile issue_comments "$ISSUE_FILE" \
  --slurpfile review_summaries "$REVIEWS_FILTERED_FILE" \
  --slurpfile new_or_edited "$NEW_OR_EDITED_FILE" \
  '{pr_number: $pr, worktree_sha: $worktree_sha, repo: $repo,
    inline_comments: $inline_comments[0],
    issue_comments: $issue_comments[0],
    review_summaries: $review_summaries[0],
    new_or_edited: $new_or_edited[0]}' \
  > "$TICK_FILE"

INLINE_COUNT=$(jq 'length' "$INLINE_FILE")
ISSUE_COUNT=$(jq 'length' "$ISSUE_FILE")
REVIEW_COUNT=$(jq 'length' "$REVIEWS_FILTERED_FILE")
NEW_COUNT=$(jq 'length' "$NEW_OR_EDITED_FILE")
TOTAL_COUNT=$((INLINE_COUNT + ISSUE_COUNT + REVIEW_COUNT))

echo "PR #${PR_NUMBER}  worktree_sha: ${WORKTREE_SHA:0:8}  repo: ${REPO}"
echo "Comments:  inline=${INLINE_COUNT}  issue=${ISSUE_COUNT}  reviews=${REVIEW_COUNT}  total=${TOTAL_COUNT}"
echo "New/edited: ${NEW_COUNT}"
if [ "$NEW_COUNT" -gt 0 ]; then
  echo ""
  echo "New/edited comment summary:"
  jq -r '.[] | "  [\(.source)] id=\(.id) login=\(.login) type=\(.user_type) edit=\(.is_edit)"' "$NEW_OR_EDITED_FILE"
fi
