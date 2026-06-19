# gh comment capabilities — pr-triage spike

Recorded: 2026-06-15
gh version: 2.93.0 (2026-05-27)
Repo: camunda/camunda

---

## Auth

Reuse ci-babysit's auth — same `tsedekey` account, same token. No deltas.

```
gh auth status
# github.com: ✓ Logged in as tsedekey (keyring)
# Token scopes: gist, project, read:org, repo, workflow
```

Auth confirmed un-sandboxed from the worktree. `user.type` and login fields are available without
elevated token scopes beyond `repo`.

---

## Reading review comments

### 1. Inline review comments

Endpoint: `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`

```bash
gh api "repos/camunda/camunda/pulls/{pr}/comments"
```

Confirmed field names (from live PR 55201):

| Field                    | Type        | Notes                                           |
| ------------------------ | ----------- | ----------------------------------------------- |
| `id`                     | number      | Unique comment ID                               |
| `user.login`             | string      | e.g. `"Copilot"`, `"jonathanlukas"`             |
| `user.type`              | string      | `"Bot"` or `"User"` — PRIMARY bot detector      |
| `body`                   | string      | Comment text                                    |
| `path`                   | string      | File path relative to repo root                 |
| `line`                   | number      | Current line (after rebases)                    |
| `original_line`          | number      | Line at the original commit                     |
| `start_line`             | number/null | First line of multi-line range (null if single) |
| `diff_hunk`              | string      | The diff context shown in review UI             |
| `in_reply_to_id`         | number/null | Parent comment ID if reply; null for root       |
| `pull_request_review_id` | number      | The review this comment belongs to              |
| `commit_id`              | string      | SHA the comment was made against                |
| `original_commit_id`     | string      | Original SHA (before force-push)                |
| `created_at`             | string      | ISO 8601 UTC                                    |
| `updated_at`             | string      | ISO 8601 UTC — use for incremental `--since`    |
| `html_url`               | string      | Link to the comment in the GitHub UI            |

### 2. PR-level issue comments

Endpoint: `GET /repos/{owner}/{repo}/issues/{pull_number}/comments`

```bash
gh api "repos/camunda/camunda/issues/{pr}/comments"
```

Confirmed field names (from live PR 55201):

| Field        | Type   | Notes                                               |
| ------------ | ------ | --------------------------------------------------- |
| `id`         | number | Unique comment ID (different namespace from inline) |
| `user.login` | string | e.g. `"monorepo-devops-automation[bot]"`            |
| `user.type`  | string | `"Bot"` or `"User"`                                 |
| `body`       | string | Comment text                                        |
| `created_at` | string | ISO 8601 UTC                                        |
| `updated_at` | string | ISO 8601 UTC                                        |
| `html_url`   | string | Link to comment                                     |

Note: `performed_via_github_app` field present on bot comments — not used for detection; `user.type`
is sufficient.

### 3. Review summaries

Endpoint: `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

```bash
gh api "repos/camunda/camunda/pulls/{pr}/reviews"
```

Confirmed field names (from live PRs 55201 and 55169):

| Field          | Type   | Notes                                                     |
| -------------- | ------ | --------------------------------------------------------- |
| `id`           | number | Unique review ID                                          |
| `user.login`   | string | e.g. `"copilot-pull-request-reviewer[bot]"`, human        |
| `user.type`    | string | `"Bot"` or `"User"`                                       |
| `body`         | string | Review summary text (may be empty — skip those)           |
| `state`        | string | `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` |
| `submitted_at` | string | ISO 8601 UTC                                              |
| `commit_id`    | string | SHA the review was submitted against                      |
| `html_url`     | string | Link to the review                                        |

---

## Bot vs human detection

**Primary detector: `user.type == "Bot"`** — confirmed RELIABLE.

All bot comments observed had `user.type == "Bot"`. All human comments had `user.type == "User"`.
Do not rely on login suffix alone — Copilot inline comments use login `"Copilot"` (no `[bot]`
suffix) but `type == "Bot"`.

**Secondary detector: `[bot]` login suffix** — present on MOST bots but NOT all.

- `monorepo-devops-automation[bot]` — suffix present
- `copilot-pull-request-reviewer[bot]` — suffix present (review summaries)
- `Copilot` — NO suffix (inline review comments from Copilot)

**Known bots on camunda/camunda repo (confirmed from live data):**

| Login                                | Type | Source           | Description                    |
| ------------------------------------ | ---- | ---------------- | ------------------------------ |
| `Copilot`                            | Bot  | Inline comments  | GitHub Copilot PR review       |
| `copilot-pull-request-reviewer[bot]` | Bot  | Review summaries | GitHub Copilot PR review       |
| `monorepo-devops-automation[bot]`    | Bot  | Issue comments   | Camunda CI/backport automation |

**CodeRabbit:** NOT present on this repo. Recorded as absent (not unknown) — do not build
special-case handling.

**crev:** Not confirmed on this repo from spike data. Treat any crev comments as `user.type == "User"`
(human reviewer) unless `user.type == "Bot"`.

---

## Reply endpoints

**DO NOT fire these without per-comment explicit human approval in the session.**

### Reply to an inline review comment (creates a thread reply)

```bash
# POST to the replies sub-resource of the comment
gh api -X POST \
  "repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies" \
  -f body="<reply text>"
# Returns: the new comment object with .id field
```

This works for both root inline comments and existing replies — the parent `comment_id` is always
the root of the thread (or any comment in the thread; GitHub handles threading).

### Post a new PR-level issue comment

```bash
# POST to the issues comments endpoint — creates a new top-level comment
gh api -X POST \
  "repos/{owner}/{repo}/issues/{pull_number}/comments" \
  -f body="<reply text>"
# Returns: the new comment object with .id field
```

Use this for:

- Replies to PR-level issue comments (no thread reply endpoint for issue comments)
- Replies to review summaries (no review summary reply endpoint)

### Review summary reply

There is no direct reply endpoint for review summaries. Post via the PR-level issue comment endpoint
above, quoting the review if needed for context.

---

## Rate limits

Observed at spike time: core = 5000/5000 remaining (full bucket).

```bash
gh api rate_limit --jq '.resources.core'
# {"limit":5000,"remaining":5000,"reset":...,"used":0}
```

A 60s poll cadence with two pr-triage fetches (comments + issue comments + reviews = ~3 calls/tick)
and ci-babysit's ~2 calls/tick = ~5 calls/minute = ~300/hour. Well within the 5000/hour core limit.

---

## Inline thread reply vs PR-level reply

| Comment type   | Reply via                                   | Thread structure          |
| -------------- | ------------------------------------------- | ------------------------- |
| Inline review  | `pulls/{pr}/comments/{id}/replies`          | Threaded on the diff line |
| PR-level issue | `issues/{pr}/comments` (new top-level post) | Flat (no threading)       |
| Review summary | `issues/{pr}/comments` (new top-level post) | Flat (quote for context)  |

To identify which endpoint to use, check the `source` field in triage-state.json:

- `source == "inline"` → use pull review comment reply endpoint
- `source == "issue"` or `source == "review"` → use issues comment endpoint
