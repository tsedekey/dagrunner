#!/bin/zsh
set -euo pipefail

ARTIFACTS_DIR=$(jq -r .artifacts /tmp/pr-triage-state.json)
PR_NUMBER=$(jq -r .pr_number /tmp/pr-triage-state.json)
REPO_ARG=$(jq -r '.repo' /tmp/pr-triage-state.json)
TRIAGE_STATE="$ARTIFACTS_DIR/triage-state.json"

# Discover repo name (needed for gh api calls)
if [ -z "$REPO_ARG" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
else
  REPO="$REPO_ARG"
fi
[ -z "$REPO" ] && { echo "ERROR: Could not determine repo name. Pass --repo owner/repo."; exit 1; }

# Check PR is still OPEN
PR_VIEW=$(gh pr view "$PR_NUMBER" --json state,headRefOid -R "$REPO" 2>&1)
if ! echo "$PR_VIEW" | jq -e '.state' > /dev/null 2>&1; then
  echo "ERROR: Could not fetch PR #${PR_NUMBER} state."
  echo "$PR_VIEW"
  exit 1
fi
PR_STATE=$(echo "$PR_VIEW" | jq -r '.state')
if [ "$PR_STATE" != "OPEN" ]; then
  echo "PR #${PR_NUMBER} is ${PR_STATE} — nothing to triage. Exiting."
  rm -f /tmp/pr-triage-state.json
  exit 0
fi

WORKTREE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

# Fetch inline review comments
INLINE_RAW=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" 2>&1) || {
  echo "WARNING: Could not fetch inline review comments: $INLINE_RAW"
  INLINE_RAW="[]"
}
if ! echo "$INLINE_RAW" | jq -e 'if type == "array" then true else false end' > /dev/null 2>&1; then
  echo "WARNING: Inline comments response was not an array — defaulting to []"
  INLINE_RAW="[]"
fi

# Fetch PR-level issue comments
ISSUE_RAW=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>&1) || {
  echo "WARNING: Could not fetch PR-level issue comments: $ISSUE_RAW"
  ISSUE_RAW="[]"
}
if ! echo "$ISSUE_RAW" | jq -e 'if type == "array" then true else false end' > /dev/null 2>&1; then
  echo "WARNING: Issue comments response was not an array — defaulting to []"
  ISSUE_RAW="[]"
fi

# Fetch review summaries (skip those with empty body)
REVIEWS_RAW=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" 2>&1) || {
  echo "WARNING: Could not fetch review summaries: $REVIEWS_RAW"
  REVIEWS_RAW="[]"
}
if ! echo "$REVIEWS_RAW" | jq -e 'if type == "array" then true else false end' > /dev/null 2>&1; then
  echo "WARNING: Reviews response was not an array — defaulting to []"
  REVIEWS_RAW="[]"
fi
# Filter out reviews with empty body
REVIEWS_FILTERED=$(echo "$REVIEWS_RAW" | jq '[.[] | select(.body != null and (.body | length) > 0)]')

# Load known comment state from triage-state.json
if [ -f "$TRIAGE_STATE" ]; then
  KNOWN_COMMENTS=$(jq -c '.comments // {}' "$TRIAGE_STATE")
else
  KNOWN_COMMENTS="{}"
fi

# Compute new_or_edited for inline comments
INLINE_NEW=$(echo "$INLINE_RAW" | jq -c \
  --argjson known "$KNOWN_COMMENTS" '
  [.[] | . as $c |
    ($c.id | tostring) as $id |
    ($known[$id] // null) as $prior |
    if $prior == null then
      {id: $c.id, source: "inline", updated_at: $c.updated_at, is_edit: false,
       login: $c.user.login, user_type: $c.user.type}
    elif $c.updated_at > ($prior.updated_at // "") then
      {id: $c.id, source: "inline", updated_at: $c.updated_at, is_edit: true,
       login: $c.user.login, user_type: $c.user.type}
    else empty
    end
  ]')

# Compute new_or_edited for issue comments
ISSUE_NEW=$(echo "$ISSUE_RAW" | jq -c \
  --argjson known "$KNOWN_COMMENTS" '
  [.[] | . as $c |
    ("issue_" + ($c.id | tostring)) as $id |
    ($known[$id] // null) as $prior |
    if $prior == null then
      {id: $c.id, source: "issue", updated_at: $c.updated_at, is_edit: false,
       login: $c.user.login, user_type: $c.user.type}
    elif $c.updated_at > ($prior.updated_at // "") then
      {id: $c.id, source: "issue", updated_at: $c.updated_at, is_edit: true,
       login: $c.user.login, user_type: $c.user.type}
    else empty
    end
  ]')

# Compute new_or_edited for review summaries (keyed as review_<id>)
REVIEW_NEW=$(echo "$REVIEWS_FILTERED" | jq -c \
  --argjson known "$KNOWN_COMMENTS" '
  [.[] | . as $c |
    ("review_" + ($c.id | tostring)) as $id |
    ($known[$id] // null) as $prior |
    if $prior == null then
      {id: $c.id, source: "review", updated_at: ($c.submitted_at // ""), is_edit: false,
       login: $c.user.login, user_type: $c.user.type}
    else empty
    end
  ]')

# Merge all new_or_edited
NEW_OR_EDITED=$(jq -n \
  --argjson a "$INLINE_NEW" \
  --argjson b "$ISSUE_NEW" \
  --argjson c "$REVIEW_NEW" \
  '$a + $b + $c')

INLINE_COUNT=$(echo "$INLINE_RAW" | jq 'length')
ISSUE_COUNT=$(echo "$ISSUE_RAW" | jq 'length')
REVIEW_COUNT=$(echo "$REVIEWS_FILTERED" | jq 'length')
NEW_COUNT=$(echo "$NEW_OR_EDITED" | jq 'length')
TOTAL_COUNT=$((INLINE_COUNT + ISSUE_COUNT + REVIEW_COUNT))

jq -n \
  --arg pr "$PR_NUMBER" \
  --arg worktree_sha "$WORKTREE_SHA" \
  --argjson inline_comments "$INLINE_RAW" \
  --argjson issue_comments "$ISSUE_RAW" \
  --argjson review_summaries "$REVIEWS_FILTERED" \
  --argjson new_or_edited "$NEW_OR_EDITED" \
  --arg repo "$REPO" \
  '{pr_number: $pr, worktree_sha: $worktree_sha, repo: $repo,
    inline_comments: $inline_comments,
    issue_comments: $issue_comments,
    review_summaries: $review_summaries,
    new_or_edited: $new_or_edited}' \
  > /tmp/pr-triage-tick.json

echo "PR #${PR_NUMBER}  worktree_sha: ${WORKTREE_SHA:0:8}  repo: ${REPO}"
echo "Comments:  inline=${INLINE_COUNT}  issue=${ISSUE_COUNT}  reviews=${REVIEW_COUNT}  total=${TOTAL_COUNT}"
echo "New/edited: ${NEW_COUNT}"
if [ "$NEW_COUNT" -gt 0 ]; then
  echo ""
  echo "New/edited comment summary:"
  echo "$NEW_OR_EDITED" | jq -r '.[] | "  [\(.source)] id=\(.id) login=\(.login) type=\(.user_type) edit=\(.is_edit)"'
fi
