# /apply-reflection — Apply Approved Reflection Proposals

Read the reflect gate's approval history from state.json, then apply ONLY the approved
Flavor-1 proposals to DEVHARNESS_SRC private files, and append approved Flavor-2 proposals
to the dagrunner store.

## Four guardrails (HARD — violations must be refused, not worked around)

1. **Path allowlist** — write ONLY to `*.local.md` files or private `.claude/` variants
   inside `$DEVHARNESS_SRC`. Refuse any proposal targeting source files, committed `CLAUDE.md`,
   `state.json`, dagrunner code, `.git/`, or any path outside DEVHARNESS_SRC.
2. **Private-only** — after writing, add each path to `$DEVHARNESS_SRC/.git/info/exclude`.
   NEVER run `git add` or stage any file.
3. **Exact-approved-diffs only** — apply precisely what the gate approved (the diff in the
   proposal). Do not re-reason, expand, or add extra edits.
4. **Snapshot-before-apply** — copy every target file to the backup dir before modifying it.

## Step 1 — Read the approved proposals

Read the reflect gate history from state.json to determine which proposals were approved:

```bash
cat "$DAGRUN_RUN_DIR/state.json" | python3 -c "
import json, sys
state = json.load(sys.stdin)
history = state.get('nodes', {}).get('reflect', {}).get('gateHistory', [])
print(json.dumps(history, indent=2))
"
```

Read both proposal files:

```bash
cat "$DAGRUN_RUN_DIR/reflect/camunda-knowledge.md"
cat "$DAGRUN_RUN_DIR/reflect/dagrunner-proposals.md"
```

From the gate history, identify which proposals were rejected (rejection comments reference
proposal numbers, e.g. "reject proposals 2, 4"). All others are approved by default.
If the gate history shows no rejections (approved unconditionally), all proposals are approved.

## Step 2 — Set up the backup directory

Create the backup directory and initialise the manifest:

```bash
BACKUP_DIR="$DAGRUN_RUN_DIR/reflect/backup"
mkdir -p "$BACKUP_DIR"
```

Write `$BACKUP_DIR/manifest.json` (start as empty, fill in as you go):

```json
{ "files": [] }
```

## Step 3 — Apply approved Flavor-1 proposals to DEVHARNESS_SRC

For each approved Flavor-1 proposal:

a. **Validate the target path** — check that it ends in `.local.md` or is under a `.claude/`
private directory within `$DEVHARNESS_SRC`. If the path fails validation, SKIP the proposal
and log the refusal to `$DAGRUN_ARTIFACTS/apply-summary.md`.

b. **Snapshot** — if the target file already exists, copy it to the backup dir:

```bash
TARGET_ABS="$DEVHARNESS_SRC/<target-relative-path>"
BACKUP_PATH="$BACKUP_DIR/<escaped-target-name>"
[ -f "$TARGET_ABS" ] && cp "$TARGET_ABS" "$BACKUP_PATH"
```

Append to the manifest: `{ "original": "<TARGET_ABS>", "backup": "<BACKUP_PATH>" }`.

c. **Apply the diff** — apply the proposal's diff to the target file. For `add` proposals,
create the file (and parent dirs) with the new content. For `update` proposals, apply the
before/after patch. For `delete` proposals, remove the file (after snapshot).

d. **Register as private** — append the path to `.git/info/exclude`:

```bash
echo "<target-relative-path>" >> "$DEVHARNESS_SRC/.git/info/exclude"
```

## Step 4 — Append approved Flavor-2 proposals to dagrunner store

For each approved Flavor-2 proposal:

```bash
STORE_DIR="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}/store/proposals"
mkdir -p "$STORE_DIR"
cat >> "$STORE_DIR/proposals.jsonl" << EOF
{"runId":"$DAGRUN_RUN_ID","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","proposal":<proposal-json>}
EOF
```

Flavor-2 proposals are NEVER applied to dagrunner code — only logged to the store.

## Step 5 — Write apply-summary.md

Write `$DAGRUN_ARTIFACTS/apply-summary.md`:

```markdown
# Apply-Reflection Summary

Run: <DAGRUN_RUN_ID>
Applied at: <ISO timestamp>

## Flavor-1 (Camunda knowledge) — applied to DEVHARNESS_SRC

| #   | Target                | Action | Outcome                        |
| --- | --------------------- | ------ | ------------------------------ |
| 1   | path/to/file.local.md | add    | applied                        |
| 2   | ...                   | ...    | refused: path not in allowlist |

Backup location: <BACKUP_DIR>
Revert with: dagrun revert-reflection <DAGRUN_RUN_ID>

## Flavor-2 (dagrunner improvements) — logged to store

| #   | Target                           | Action | Outcome         |
| --- | -------------------------------- | ------ | --------------- |
| 1   | .claude/commands/expand-guide.md | update | logged to store |

Store location: <STORE_DIR>/proposals.jsonl

## Refused proposals

<List any proposals that were refused and why>
```

If BOTH proposal files are absent or empty (reflect was skipped), write a summary noting
"No proposals to apply — reflect node was skipped." and exit successfully.
