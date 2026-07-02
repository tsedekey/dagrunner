---
description: Triage new PR review comments — one incremental tick: fetch new comments, classify each, draft replies as artifacts, surface per-comment human approve/post gate
argument-hint: [--pr <number>] [--repo owner/repo] [--run-id <run-id>]  # all optional — auto-discovered from git branch
---

# /pr-triage — PR Review Comment Triage Tick

**Input**: $ARGUMENTS

One incremental tick of PR review comment triage. Fetches new and edited review comments
(inline, PR-level, review summaries) from all sources (Copilot bot, human reviewers), classifies
each, and drafts a reply artifact. Surfaces each draft for **per-comment human approve/post** — it
never posts anything automatically.

Run repeatedly to triage continuously:

```
/loop 60s /pr-triage
```

**NEVER AUTO-POST**: This command never posts a comment without explicit per-comment human approval
in the session. Drafts accumulate as artifacts if no human is present; they are presented on the
next interactive session.

**WORKTREE LIFETIME CONSTRAINT (dagrunner-managed runs only):** when `DAGRUN_RUN_ID` is set (i.e.
running inside a dagrunner-managed worktree), `dagrun cleanup` MUST NOT run while this command is
active and the PR is open — the worktree and branch must persist for the full PR lifetime, and
pr-triage fails loud if either is gone on the next tick. Outside a dagrunner-managed worktree (any
other git checkout) this constraint does not apply — there is no `dagrun cleanup` to avoid.

**Coexistence with ci-babysit:** both run on the same PR. pr-triage owns
`~/.local/share/dagrunner/runs/<run-id>/pr-triage/` only. It never touches the branch, never
pushes, never rebases — those are ci-babysit's domain.

**gh comment surface verified from live camunda/camunda PRs (gh v2.93.0):**

- Inline: `pulls/{pr}/comments` — fields: `id`, `user.login`, `user.type`, `body`, `path`, `line`,
  `in_reply_to_id`, `created_at`, `updated_at`, `commit_id`, `diff_hunk`
- Issue: `issues/{pr}/comments` — fields: `id`, `user.login`, `user.type`, `body`, `created_at`,
  `updated_at`
- Reviews: `pulls/{pr}/reviews` — fields: `id`, `user.login`, `user.type`, `body`, `state`,
  `submitted_at`, `commit_id`
- Bot detection: `user.type == "Bot"` is RELIABLE; login `[bot]` suffix is NOT always present
  (Copilot inline shows as `"Copilot"` with no suffix but `type == "Bot"`). See
  `.claude/scripts/pr-triage/gh-comment-capabilities.md` for the full spike record.

**Scripts:** bash logic lives in `.claude/scripts/pr-triage/`. Phases 0–2 and 5 use scripts;
phases 3–4 are model work described inline.

---

## Phase 0 — Bootstrap

Parse `$ARGUMENTS` (all optional). Validate this is a git checkout on a real branch (any branch
name — not detached HEAD). Discover the open PR for that branch via `gh`. Fail loud if the
checkout or branch is missing, or if no open PR is found — PR discovery is the real gate, not the
branch name. All values (PR number, repo, run-id) are auto-discovered from git if not supplied as
arguments.

```bash
SCRIPT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/scripts/pr-triage"
zsh "$SCRIPT_DIR/phase-0-bootstrap.sh" "$ARGUMENTS"
```

**PHASE_0_CHECKPOINT:**

- [ ] Running on a real branch (not detached HEAD) inside a git checkout
- [ ] PR number discovered (non-empty) for that branch
- [ ] `$ARTIFACTS_DIR/pr-triage-state.json` written with `{run_id, pr_number, branch, worktree, repo, artifacts}`
      where `ARTIFACTS_DIR = ~/.local/share/dagrunner/runs/<run-id>/pr-triage/`

---

## Phase 1 — Fetch comments and compute new/edited

Fetch all three comment types. Compute which are new or edited since the last tick.

```bash
SCRIPT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/scripts/pr-triage"
zsh "$SCRIPT_DIR/phase-1-fetch-comments.sh"
```

**PHASE_1_CHECKPOINT:**

- [ ] PR state confirmed OPEN (or exited cleanly if merged/closed)
- [ ] All three comment endpoints fetched (or warned on failure, defaulting to [])
- [ ] `new_or_edited` array computed (empty if nothing changed)
- [ ] `$ARTIFACTS_DIR/pr-triage-tick.json` written (alongside per-source raw + delta files)

---

## Phase 2 — No-op gate

If there are no new or edited comments, this tick has nothing to do. Write `noop=true` and stop.
Phase 5 still runs to update the tick timestamp.

```bash
SCRIPT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/scripts/pr-triage"
zsh "$SCRIPT_DIR/phase-2-noop-gate.sh"
```

If the script exits 0 with "tick is a no-op" output, skip to Phase 5. Otherwise continue.

**PHASE_2_CHECKPOINT:**

- [ ] If no new/edited comments: `noop=true` in tick.json; jump to Phase 5
- [ ] If new/edited comments exist: `noop=false`; continue to Phase 3

---

## Phase 3 — Classify and draft replies

**MODEL WORK — no script.** Derive the artifacts path, then read the tick and triage state:

```bash
RUN_ID="${DAGRUN_RUN_ID:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')}"
ARTIFACTS_DIR="${DAGRUN_ARTIFACTS:-$HOME/.local/share/dagrunner/runs/${RUN_ID}/pr-triage}"
TRIAGE_STATE="$ARTIFACTS_DIR/triage-state.json"
TICK_FILE="$ARTIFACTS_DIR/pr-triage-tick.json"
```

For each entry in `new_or_edited` (read from `$TICK_FILE`):

### 3.1 Load the full comment

Pull the full comment object from the per-source files in `$ARTIFACTS_DIR`:

- `source == "inline"` → `jq --argjson id <id> '.[] | select(.id == $id)' "$ARTIFACTS_DIR/inline-raw.json"`
- `source == "issue"` → `jq --argjson id <id> '.[] | select(.id == $id)' "$ARTIFACTS_DIR/issue-raw.json"`
- `source == "review"` → `jq --argjson id <id> '.[] | select(.id == $id)' "$ARTIFACTS_DIR/reviews-filtered.json"`

### 3.2 Determine source type

```
if user.type == "Bot":
  if login contains "copilot" (case-insensitive):  source_type = "copilot"
  elif login contains "[bot]":                      source_type = "<name>-bot"
  else:                                             source_type = "automation-bot"
else:
  source_type = "human"  (includes crev if encountered)
```

### 3.3 Handle edited comments (superseded lifecycle)

If `entry.is_edit == true` AND the comment already has a draft (`lifecycle == "drafted"`):

- Set `lifecycle = "superseded"` in triage-state.json
- Move `draft_file` → `prior_draft_file` in state
- Proceed to draft a fresh reply (the prior draft is archived, not silently overwritten)

### 3.4 Ground the comment against the current worktree

For **inline comments** only:

1. Check if `path` exists: `git show HEAD:<path> -- 2>/dev/null | head -1`
2. Check if the file's line count covers the comment's `line`
3. Compare comment's `commit_id` (or `original_commit_id`) to `git rev-parse HEAD`
4. Mark `grounded: true` if the file+line still exists at the current SHA
5. Mark `grounded: false` with a reason if: file not in worktree, line out of range, or
   `commit_id` differs from HEAD significantly (file may have changed)

For **issue comments** and **review summaries**: mark `grounded: true` by default (they reference
the PR as a whole, not a specific line).

### 3.5 Classify

Apply one classification from this taxonomy:

| Class                          | Use when                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| `needs-code-change`            | Comment identifies a real defect or improvement requiring a code edit |
| `reply-only`                   | Clarification or acknowledgment; no code change needed                |
| `question-back`                | Reviewer asking for information; the reply must answer it             |
| `nit-or-style`                 | Minor naming/style suggestion, low severity                           |
| `ungrounded-or-false-positive` | Comment about code that no longer exists or misreads the diff         |
| `already-addressed`            | Issue was fixed in a prior commit; reply points to it                 |
| `defer-out-of-scope`           | Valid concern but out of scope; propose a follow-up issue             |

**Reply length rules (apply regardless of source type):**

State only what will happen or what the evidence shows. No preamble, no restating
the reviewer's concern, no explaining why the existing code is structured the way it is.

- **Bot (copilot, automation-bot):** ≤1 sentence. No acknowledgment.
  - `needs-code-change` → "Will apply [action]."
  - `ungrounded-or-false-positive` → cite the evidence: "This was addressed in <sha8> / line N now reads X."
  - `nit-or-style` → "Will apply." or "Keeping as-is — [one-word reason]."
- **Human:** ≤2 sentences. Answer the question or state the action. No "Good catch", no "Great point".
  - `needs-code-change` → "Will [action]." (Phase 4 appends the commit SHA automatically.)
  - `question-back` → answer directly in 1–2 sentences.
  - `defer-out-of-scope` → "Valid point — opened #<issue> to track."

✓ "Will apply the rename."
✗ "Good catch on the naming. The REST test layer can't observe the client-side timeout config (it
only captures the serialized request body), so the assertion is intentionally limited to
`priority`. Renaming to `shouldSend…` would make the intent clearer. Will apply the rename."

### 3.6 Write the draft

Write to `$ARTIFACTS_DIR/drafts/<comment-id>.md` where `ARTIFACTS_DIR` is from triage-state.json.
Use the numeric `id` for the filename. For issue comments use `issue_<id>.md`; for reviews use
`review_<id>.md`.

Draft format:

```
# Draft reply — comment <id>

**Author:** <login> (<Bot|User>)
**Source type:** <copilot|automation-bot|human|crev>
**Location:** <path>:<line> (inline) | PR-level comment | review summary
**Classification:** <class>
**Grounded:** yes — file exists at HEAD:<sha8> line N | no — <reason>
**Rationale:** <one-line why this class>
**Original comment:**
> <body — truncated at 300 chars if needed>

---

**Proposed reply:**

<reply text>
```

For `needs-code-change` drafts, open the proposed reply section with:

```
⚠ CODE CHANGE NEEDED — human decision required before posting this reply.
```

Then draft the reply text as a single action statement per the reply length rules above.
Do not acknowledge the concern, do not explain the current code, do not describe why the
change is needed — Phase 4 will append the commit SHA. Example: "Will apply the rename."

For `needs-code-change` drafts, also write an **Implementation plan** section after the proposed reply:

```
## Implementation plan

- **File(s):** <list the specific file paths>
- **Change:** <precise description of what to change — line numbers, method names, the before/after>
- **Why:** <link back to the reviewer's concern>
```

This section is used by Phase 4 to apply the code change. Make it specific enough that Phase 4 can execute it without re-reading the original comment.

**Do NOT edit any source files. Do NOT stage or commit anything. Do NOT push.**

### 3.7 Update triage-state.json

After writing the draft, update triage-state.json for this comment's state key:

- `lifecycle: "drafted"`
- `draft_file: "<path to draft>"`
- `grounded: <true|false>`
- `grounded_sha: "<worktree_sha>"`
- `classification: "<class>"`

The state key is: `<id>` (inline), `issue_<id>` (issue comment), `review_<id>` (review summary).

```bash
TRIAGE_STATE="<artifacts>/triage-state.json"
jq --arg key "<state_key>" \
   --arg lifecycle "drafted" \
   --arg draft_file "<draft_path>" \
   --argjson grounded true \
   --arg grounded_sha "<sha>" \
   --arg classification "<class>" \
   '.comments[$key].lifecycle = $lifecycle |
    .comments[$key].draft_file = $draft_file |
    .comments[$key].grounded = $grounded |
    .comments[$key].grounded_sha = $grounded_sha |
    .comments[$key].classification = $classification' \
   "$TRIAGE_STATE" > "${TRIAGE_STATE}.tmp" && mv "${TRIAGE_STATE}.tmp" "$TRIAGE_STATE"
```

**PHASE_3_CHECKPOINT:**

- [ ] Each new/edited comment has a draft written to `drafts/<id>.md`
- [ ] Each draft includes: original comment, classification, groundedness, proposed reply
- [ ] `needs-code-change` drafts are flagged — no source files were edited, no commits made
- [ ] `needs-code-change` drafts include an "Implementation plan" section with file(s), change, and why
- [ ] triage-state.json updated with `lifecycle: drafted` for each comment

---

## Phase 4 — Per-comment human approve/post gate

**MODEL WORK — NEVER AUTO-POST.** Present each drafted comment for human disposition, in order.
Only post on explicit per-comment human approval in this session.

For each comment in the current tick's `new_or_edited` set that has `lifecycle: drafted`:

### 4.1 Present the draft

Print the full draft content, then use the **AskUserQuestion tool** to ask:

Question: "Comment [source] id=<id> by <login> (<class>) — what should we do?"
Options:

- **Approve & post** — post the reply as-is (and apply code change first if needs-code-change)
- **Edit then post** — show the reply text for human editing, then post the edited version
- **Skip** — leave the draft; do not post; move on
- **Defer** — mark deferred; do not post; move on

Wait for the human's selection before proceeding.

### 4.2 On Approve (A)

**If `classification == "needs-code-change"`:**

1. Read the "Implementation plan" section from the draft file.
2. Apply the code changes to the worktree — edit the file(s) listed in the implementation plan.
3. Stage the changed files and commit using a conventional-commit subject line only (no body, no description, no trailers):
   ```bash
   git add <specific files only>
   git commit -m "fix: <brief conventional-commit summary of the change>"
   ```
   The commit message must follow CONTRIBUTIONS.md format: subject line only, present tense, imperative mood. Do NOT add a body, description, or Co-Authored-By trailer.
4. Capture the commit SHA: `COMMIT_SHA=$(git rev-parse --short HEAD)`
5. Push immediately so the SHA is reachable on GitHub before the reply is posted:
   ```bash
   git push origin HEAD
   ```
6. Update the proposed reply to reference the commit: append `\n\nFixed in commit ${COMMIT_SHA}.` to the reply body.

**Then post the reply** (for all classifications, including needs-code-change after the above):

For **inline comment** (`source == "inline"`):

```bash
REPLY_ID=$(gh api -X POST \
  "repos/<repo>/pulls/<pr_number>/comments/<comment_id>/replies" \
  -f body="<reply_text>" \
  --jq '.id')
```

For **PR-level issue comment** (`source == "issue"`) or **review summary** (`source == "review"`):

```bash
REPLY_ID=$(gh api -X POST \
  "repos/<repo>/issues/<pr_number>/comments" \
  -f body="<reply_text>" \
  --jq '.id')
```

After a successful post, update triage-state.json:

```bash
jq --arg key "<state_key>" \
   --arg lifecycle "posted" \
   --arg reply_id "<REPLY_ID>" \
   '.comments[$key].lifecycle = $lifecycle |
    .comments[$key].posted_comment_id = ($reply_id | tonumber)' \
   "$TRIAGE_STATE" > "${TRIAGE_STATE}.tmp" && mv "${TRIAGE_STATE}.tmp" "$TRIAGE_STATE"
```

### 4.3 On Edit (E)

Show the proposed reply text. Accept the human's edited version. Then post as in 4.2 above.

### 4.4 On Skip (S)

```bash
jq --arg key "<state_key>" \
   '.comments[$key].lifecycle = "skipped" |
    .comments[$key].skipped_reason = "human decision"' \
   "$TRIAGE_STATE" > "${TRIAGE_STATE}.tmp" && mv "${TRIAGE_STATE}.tmp" "$TRIAGE_STATE"
```

### 4.5 On Defer (D)

```bash
jq --arg key "<state_key>" \
   '.comments[$key].lifecycle = "skipped" |
    .comments[$key].skipped_reason = "deferred"' \
   "$TRIAGE_STATE" > "${TRIAGE_STATE}.tmp" && mv "${TRIAGE_STATE}.tmp" "$TRIAGE_STATE"
```

### 4.6 If no human is present

If no human responds (unattended tick), leave all drafts at `lifecycle: drafted`. They will be
presented on the next interactive session. Do not mark them skipped; do not post them.

**PHASE_4_CHECKPOINT:**

- [ ] Every `lifecycle: drafted` comment in this tick's batch was presented to the human
- [ ] No comment was posted without explicit per-comment human approval
- [ ] Each disposition (approve/skip/defer) recorded in triage-state.json
- [ ] triage-state.json is consistent after each action (no partial writes)
- [ ] `needs-code-change` approvals: code change applied, committed (summary-only), pushed, reply references commit SHA

---

## Phase 5 — Persist state and write tick log

Advance the `since` marker and write the tick log. Runs even on a no-op tick. An interrupted
tick that did not reach Phase 5 will re-process on the next wake (fail-safe).

```bash
SCRIPT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/scripts/pr-triage"
zsh "$SCRIPT_DIR/phase-5-persist.sh"
```

**PHASE_5_CHECKPOINT:**

- [ ] triage-state.json updated: `last_tick_at` and `last_fetched_sha` advanced
- [ ] New `seen` entries added for any comments not yet touched by phase 3/4
- [ ] Tick log written to `$ARTIFACTS_DIR/tick-<timestamp>.md`
- [ ] `triage-state.json` written atomically (via temp file, no partial writes)

---

## Scheduling

Run as a poll loop using `/loop`:

```
/loop 60s /pr-triage
```

This re-invokes `/pr-triage` every 60 seconds. Each invocation is one independent tick.
The `triage-state.json` persists between ticks — an interrupted or killed tick re-processes
cleanly on the next wake.

To use with a specific PR or repo:

```
/loop 60s /pr-triage --pr 1234 --repo camunda/camunda
```

## Re-run behavior

Each tick is independent and idempotent:

- **No-op tick** (nothing new): only updates `last_tick_at`. No gh or post actions.
- **Draft tick**: classifies and drafts replies for new/edited comments.
- **Approve tick**: posts approved replies. Leaves unapproved drafts for the next session.
- **since-state** is advanced (via triage-state.json `last_tick_at`) only after all actions
  complete — an interrupted tick will re-process the same comments on the next wake.

## Acceptance criteria

1. Two consecutive ticks with no new comments → second tick exits as no-op with no gh post actions.
2. A new Copilot bot inline comment is picked up, classified `ungrounded-or-false-positive` or
   `nit-or-style` as appropriate, and a draft written; no reply posted without human approval.
3. An edited comment (updated_at newer than stored) re-enters as `superseded`; prior draft is
   archived to `prior_draft_file`; a fresh draft is written.
4. A `needs-code-change` comment produces a flagged draft with the ⚠ header; no source files
   are edited, no commits made.
5. The human approve/post gate: approve posts to the correct thread (inline reply or issue comment)
   and records `posted_comment_id`; skip/defer records terminal state; nothing is ever posted
   without explicit per-comment approval.
6. In a dagrunner-managed worktree (`DAGRUN_RUN_ID` set): `dagrun cleanup` is forbidden until PR
   closes; pr-triage fails loud (exit 1) if it wakes and the worktree or branch is missing. In
   any other git checkout this constraint does not apply.
7. Coexistence with ci-babysit: pr-triage never writes to `ci-babysit/` artifacts, never rebases
   or force-pushes. It pushes only on an approved `needs-code-change` commit (fast-forward only).
8. A `needs-code-change` comment approved by the human: code change applied to worktree, committed
   with summary-only conventional commit, pushed to origin, reply posted referencing the commit SHA.

---

## Reflections

If this tick encountered anything unexpected that would prevent wasted time on a future run,
append one JSON line to `~/.local/share/dagrunner/store/reflection-log.jsonl`:

```bash
printf '%s\n' "$(jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source "pr-triage" \
  --arg run_id "${DAGRUN_RUN_ID:-unknown}" \
  --arg body "## $(date -u +%Y-%m-%d)\n\n**Symptom:** ...\n**Root cause:** ...\n**Resolution:** ...\n**Watch for:** ..." \
  '{ts: $ts, source: $source, run_id: $run_id, body: $body}')" \
  >> ~/.local/share/dagrunner/store/reflection-log.jsonl
```

Only log if it adds knowledge not already in the log. Routine classification decisions (bot nit,
human question) do not need an entry. Novel `gh` field mismatches, endpoint surprises, or
grounding edge cases are the right candidates.
