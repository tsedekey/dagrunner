# /gate-conclude — record a gate decision and return to dagrun

You are closing a gate review dialogue. Your job is to summarise the conversation and write the
consensus decision to `$DAGRUN_GATE_DECISION_FILE` so dagrunner can continue the pipeline.

## Steps

1. Summarise the conversation so far — what was discussed, what concerns were raised (if any),
   and what conclusion was reached.
2. Ask the human to confirm the decision if it is not unambiguous.
3. Write the gate-decision file in EXACTLY this format:

### Approve format

```
decision: approve
```

### Gate that also decides a downstream node

If `$DAGRUN_GATE_DECIDES_NODE` is set (e.g. `verify`), approving this gate ALSO decides whether that
node runs. It is an optional provision-and-hand-off (a local environment for Eddie to test by hand; it is torn down when he gives his verdict at the pre-PR gate), not a CI duplicate — ask explicitly
("run verify, or skip it?") using the fix summary's `## Verify recommendation` as the agent's advice,
then add one extra line to an approve decision:

```
decision: approve
run-next: yes
```

(`run-next: no` to skip). Do not guess: if Eddie has not answered, ask before writing the file.

### Reject format

```
decision: reject

<consensus feedback — specific, actionable, grounded in the artifact>
```

The feedback body (for reject) must be:

- Specific: reference the exact sections, claims, or patterns that need to change.
- Actionable: tell the author-agent what to do differently, not just what was wrong.
- Grounded: anchored to what is actually in the artifact, not general impressions.

## Writing the file

```bash
# Approve example:
printf 'decision: approve\n' > "$DAGRUN_GATE_DECISION_FILE"

# Reject example (use a heredoc for multi-line body):
cat > "$DAGRUN_GATE_DECISION_FILE" << 'EOF'
decision: reject

The error-handling section (lines 45-60) uses a bare catch that swallows all exceptions.
Add specific catches for network errors vs. validation errors and log each with the error
type. The retry logic at line 72 has no backoff — add exponential backoff with a cap.
EOF
```

4. After writing the file, output EXACTLY this line and nothing else:

   **Gate decision recorded. Type `/exit` now to return to dagrun and start the next node.**

5. Do NOT call `/exit` yourself — the human exits.
6. Do NOT start implementing, writing code, or making file changes after recording the decision.
   Your job ends when the file is written.

## Constraint

Write ONLY `decision: approve` or `decision: reject` on the first line. Any other value causes
dagrunner to treat the decision as absent and require another review session.
