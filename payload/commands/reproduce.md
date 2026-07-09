Read the bug fix plan at $DAGRUN_ARTIFACTS/../plan/plan.md.

## Step 1 — Understand the bug

Read plan.md carefully. Identify:

- The reported symptom (what is broken and how it manifests)
- The root cause hypothesis stated in the plan
- The change surface (which files/modules are implicated)
- Any regression test the plan expects to make pass
- Validation commands listed in the plan

## Step 2 — Confirm the bug is reproducible

Run the reproducing test or validation command from the plan. Confirm it currently **fails** — the bug must be real before writing a fix guide.

If the test passes (bug appears already fixed), or cannot be found, or the test infrastructure is unavailable — document this clearly in guide.md and surface it as a concern (see Step 3).

## Step 3 — Write the reproduction guide

**guide.md is mechanically scanned for placeholder markers after you write it** — a `TBD`, `TODO`,
`FIXME`, or `XXX` left anywhere outside a fenced code block fails this node outright (`dag.ts`'s
`checkNoPlaceholders`, no human review saves it). Any gap Step 2's reproduction didn't fully resolve
must be resolved before writing the guide, not deferred with a placeholder — if something genuinely
can't be resolved yet, say so in prose rather than leaving a placeholder token.

Write to $DAGRUN_ARTIFACTS/guide.md. Cover:

1. **Confirmed root cause** — what you found when reproducing the failure
2. **Fix approach** — minimal, targeted change to address the root cause
3. **Files to change** — specific files and locations
4. **Edge cases** — any related paths or callers that need consideration
5. **Regression test** — the test that must pass after the fix (exact command to run)

Aim for under 250 words for the core guide. Be specific and actionable.

## Step 4 — Critical evaluation (advisory)

After drafting the guide, assess whether the situation warrants a pause:

- Could **not reproduce** the bug with the listed test/command?
- Does the **root cause differ** from what the plan states?
- Is the **change surface broader** than the plan expects (multiple modules, cross-cutting concern)?
- Is the reproduction test **missing, broken, or flaky**?

If any of these conditions apply, append a **"Concerns / plan challenges"** section to
guide.md. State each concern concretely: what you observed, what the plan states,
and what is needed to proceed safely.

If the bug reproduces cleanly and the root cause matches the plan, omit the section entirely.

## Step 5 — Reflections (optional, do this last)

After guide.md is written and all other steps are complete, write any useful tips
or gotchas to $DAGRUN_ARTIFACTS/reflections.md. Cover both:

- Non-obvious facts about the Camunda code area (module invariants, gotchas, hidden coupling)
- Anything that would help future reproduce runs (tricky reproduction steps, environment setup)

Absence is fine — only write reflections.md if there is something genuinely useful.
The SessionEnd hook captures this file automatically; you do not need to call any CLI command.
