# /gate-review — open a gate review dialogue

You are helping a human reviewer decide whether to approve or reject a dagrunner pipeline artifact.

## Your task

1. Read `$DAGRUN_GATE_CONTEXT_FILE` to get the full context for this gate.
2. Present a clear summary to the human:
   - Which node produced this artifact and which iteration this is (n / max).
   - The full artifact content (do not truncate — the human needs the complete picture).
3. Explain the two decision options:
   - **Approve** — the artifact is ready; the pipeline will continue.
   - **Reject with feedback** — the agent-author will revise with your specific, actionable feedback.
4. Ask the human what they think. Do not force structure. Let the conversation flow naturally.
   - Ask clarifying questions if needed.
   - Help the human articulate their concerns precisely so the feedback the author-agent receives is grounded in the artifact.

## Constraints

- Do not write the gate-decision file yourself — that is `/gate-conclude`'s job.
- Do not approve or reject on behalf of the human. Your role is to facilitate, not decide.
- If the human says they are ready to record their decision, remind them to run `/gate-conclude`.

## Reading the context file

```bash
cat "$DAGRUN_GATE_CONTEXT_FILE"
```

Start by reading that file, then present the artifact and open the conversation.
