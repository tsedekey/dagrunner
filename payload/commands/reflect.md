# /reflect — Synthesise Run Learnings into Proposals

Read all run artifacts and produce two proposal files: one for Camunda codebase knowledge
(Flavor 1) and one for dagrunner improvements (Flavor 2). Each proposal must be concrete —
a named target file, a change type, a rationale tied to an actual signal from this run,
and a before/after diff.

## Inputs

```bash
# Git diff of everything in this feature branch
cd "$DAGRUN_WORKTREE" && git diff origin/main...HEAD

# Side-artifacts (optional — check existence before reading)
cat "$DAGRUN_RUN_DIR/expand/notes.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/implement/notes.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/notes.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/notes.md" 2>/dev/null

# Structured outputs
cat "$DAGRUN_RUN_DIR/review/findings.json"
cat "$DAGRUN_RUN_DIR/fix/summary.md"
cat "$DAGRUN_RUN_DIR/state.json"   # gate history, per-node costs, iterations
```

## Flavor 1 — Camunda codebase knowledge proposals

`$DAGRUN_ARTIFACTS/camunda-knowledge.md`

These are proposals to seed private knowledge files in DEVHARNESS_SRC that will help
future runs navigate the same code area faster. Each proposal must have a concrete target.

Format for each proposal (use numbered sections: `## Proposal 1`, `## Proposal 2`, …):

````markdown
## Proposal N

**Target**: `<relative path in DEVHARNESS_SRC, must be *.local.md or .claude/**>`
**Change type**: `add | update | delete`
**Rationale**: <Which discovery or finding from this run motivates this? Quote the signal.>
**Diff**:

```diff
--- a/<target>
+++ b/<target>
@@ ... @@
-<before (empty if adding)>
+<after>
```
````

````

Rules for Flavor-1 proposals:

- Target MUST be `*.local.md` or a private `.claude/` path inside DEVHARNESS_SRC.
- NEVER propose changes to committed source files, `CLAUDE.md`, state.json, or dagrunner code.
- Only propose what genuinely reduces friction for future runs in this code area.
- If nothing substantive was learned about the Camunda codebase, write zero proposals and note why.

## Flavor 2 — dagrunner improvement proposals

`$DAGRUN_ARTIFACTS/dagrunner-proposals.md`

These are proposals to improve dagrunner itself — its prompts, hooks, schemas, or engine.
Read `$DAGRUN_RUN_DIR/state.json` for gate-rejection counts, per-node cost, and loop iterations.
These are the friction signals: high iteration counts, expensive nodes, recurring gate rejections.

Format (same numbered-section structure as Flavor 1):

```markdown
## Proposal N

**Target**: `<exact file path in the dagrunner repo>`
**Change type**: `add | update | delete`
**Rationale**: <Which friction signal? e.g. "expand needed 3 rejections because guide.md
lacked error-handling section — prompt is missing that constraint">
**Diff**:

```diff
--- a/<target>
+++ b/<target>
@@ ... @@
-<before>
+<after>
````

```

Rules for Flavor-2 proposals:

- Every proposal MUST have a named target file (no vague "improve prompts" entries).
- Every proposal MUST cite the specific friction signal from state.json or findings.
- Proposals that duplicate each other should be merged into one.
- If the run was smooth with no friction, write zero proposals and note why.

## After writing both files

Print a brief summary: how many proposals in each flavor, the top signal that drove them.
```
