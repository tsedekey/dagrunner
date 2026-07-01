Read the feature plan at $DAGRUN_ARTIFACTS/../plan/plan.md.

## Step 0 — Consult the reflection store

Before writing anything, check whether a prior run has already learned something about this code area:

```bash
cat ~/.local/share/dagrunner/store/reflection-log.jsonl 2>/dev/null | \
  python3 -c "
import sys, json
entries = [json.loads(l) for l in sys.stdin if l.strip()]
for e in entries:
    print(e.get('ts',''), e.get('source',''), e.get('body','')[:120])
" 2>/dev/null || true
```

If any entries mention modules, classes, or patterns that overlap with the plan, copy the relevant `body` text into a **"Prior context"** section at the top of guide.md. This prevents known pitfalls from being rediscovered at fix time.

---

## Step 1 — Understand the requirement

Read plan.md carefully. Identify:

- The core requirement (WHAT and WHY)
- Any acceptance criteria
- The proposed implementation approach, if any
- Any GitHub issue URL present in the plan (e.g. `https://github.com/<org>/<repo>/issues/<N>`)

## Step 2 — Consult the source issue (if linked)

If the plan contains a GitHub issue URL, use WebFetch to read it. Note what the
issue asks for and any prescribed solution path.

Compare: does the plan faithfully capture the requirement? Does the plan's proposed
implementation align with the issue's approach, or does it diverge?

If no issue is linked, or if the issue is unreachable, work from the requirement
as stated in the plan.

## Step 3 — Write the implementation guide

Write to $DAGRUN_ARTIFACTS/guide.md. Cover:

1. **What to implement** (brief summary)
2. **Key implementation steps** (3-5 bullet points)
3. **Acceptance criteria**

Aim for under 200 words for the core guide. Be specific and actionable.

## Step 4 — Critical evaluation (advisory)

After drafting the guide, assess whether the plan's proposed implementation is
well-scoped:

- Does it **over-specify** detail that belongs to the implementer?
- Does it **diverge** from the source issue's prescribed approach (if any)?
- Is the **requirement or acceptance** incomplete or unclear in ways that would block a good implementation? (Sparse implementation detail is expected and good — that is define's job, not the plan's.)
- **Batch operation plans specifically:** does the guide include a check against `DefaultExporterResourceProvider` (the ES/OS exporter) to confirm whether a new handler is needed for the new operation type? The RDBMS exporter (`JobBatchOperationExportHandler` pattern) and the ES/OS exporter are independent registries — a missing ES/OS handler causes the `@MultiDbTest` IT to time out silently at the `COMPLETED` state assertion without any compile error.

If you find genuine concerns, append a **"Concerns / plan challenges"** section to
guide.md. State each concern concretely: what you observed, what the requirement or
issue says, and what a better plan would look like. You may exceed 200 words when
this section warrants it.

If the plan is clean and well-scoped, omit the section entirely. Do not add concerns
for style preferences or minor wording — only for substantive divergence,
over-prescription, or gaps that would mislead an implementer.

## Step 5 — Reflections (optional, do this last)

After guide.md is written and all other steps are complete, write any useful tips
or gotchas to $DAGRUN_ARTIFACTS/reflections.md. Cover both:

- Non-obvious facts about the Camunda code area (module invariants, gotchas, internal APIs)
- Anything that would help future define runs (tricky requirement patterns, issue-divergence pitfalls)

Absence is fine — only write reflections.md if there is something genuinely useful.
The SessionEnd hook captures this file automatically; you do not need to call any CLI command.
