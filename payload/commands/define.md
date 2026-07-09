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
- Every concrete, checkable claim the plan makes about the codebase: named files,
  classes, methods, "no helper exists for X," line numbers, "this field is only
  written by Y." These are exactly the claims Step 2 must verify.
- Whether the plan proposes adding or changing a REST endpoint (new/changed
  `@Path`/`@GET`/`@POST`/etc., request/response DTOs, pagination). If so, Step 2's
  REST guideline check applies.

## Step 2 — Verify the plan's claims against the current codebase (mandatory)

`implement` reads **only** guide.md — it never reads plan.md. Whatever you don't
verify or carry forward here, the implementer never sees. This step is not
optional and not deferred to a later review round; it runs before you write the
guide, because the guide should already reflect the corrected picture.

For every concrete claim identified in Step 1:

- **Existence/absence claims** ("no test helper exists," "no handler is registered
  for X") — confirm with `grep`/`find` before repeating them. Do not propagate an
  unverified negative claim; it is exactly the kind of thing that later gets
  disproved and has to be walked back.
- **Mutable/shared-state hazards** — if the plan's approach adds a new call that
  reads or iterates a data structure (column family, cache, shared buffer, static
  field) that other code paths also touch, trace who else holds a reference to
  that state and whether your new call could observe or clobber it mid-iteration.
  This class of bug (shared mutable state corrupted by a "side-effect-free"-looking
  read) is easy to miss by reading the plan alone — it requires reading the actual
  implementation.
- **Consistency** — if the plan's own steps are internally ambiguous or
  inconsistent about how a value is passed between two of its own steps, resolve
  it explicitly in the guide (pick one representation, state it once).
- **REST API guideline conformance** — if the plan proposes adding or changing a
  REST endpoint (per Step 1), run `cat docs/rest-api-endpoint-guidelines.md`
  (worktree-relative — this file is git-tracked in the target repo, so it is
  already present) and check the plan's _proposed design_ against it: resource
  naming, HTTP verb choice, pagination shape, error-response format, and any
  other rule the guideline states. This is a design-level check — no diff exists
  yet, so it catches what the plan intends, not what gets implemented;
  `reviewer-api-stability` still re-checks the actual code against the same
  guideline at review time. Fold any violation directly into the guide as a
  corrected constraint (Step 3), the same way any other Step 2 correction is
  handled. If the plan touches REST endpoints but the guideline doc can't be
  read, do not silently skip this check — add a **"Concerns / plan challenges"**
  entry (Step 4) stating conformance could not be verified, rather than letting
  the guide look like conformance was confirmed.

If the plan contains a GitHub issue URL, use WebFetch to read it and compare:
does the plan faithfully capture the requirement, and does its proposed
implementation align with the issue's prescribed approach or diverge from it?

Anything you find — a wrong claim, a missed hazard, a gap — gets corrected or
added directly into the guide in Step 3. This is define's core job: catching what
the plan got wrong or missed, before the implementer builds on it.

## Step 3 — Write the implementation guide

**guide.md is mechanically scanned for placeholder markers after you write it** — a `TBD`, `TODO`,
`FIXME`, or `XXX` left anywhere outside a fenced code block fails this node outright (`dag.ts`'s
`checkNoPlaceholders`, no human review saves it). Any gap Step 2's verification didn't fully resolve
must be resolved before writing the guide, not deferred with a placeholder — if something genuinely
can't be resolved yet, say so in prose ("the exact retry count is not yet decided; default to 3
pending review") rather than leaving a placeholder token.

Write to $DAGRUN_ARTIFACTS/guide.md. The guide is **additive**, not a summary: the
implementer reads guide.md instead of plan.md, so anything decision-relevant in
the plan that you drop is gone, not just shortened. Carry forward and elaborate on:

1. **What to implement** — summary, but keep the plan's constraints and rationale,
   not just the headline.
2. **Key implementation steps** — as much detail as the implementer needs to act
   without re-deriving it, including anything you added or corrected in Step 2.
3. **Change surface / key files** — carry forward the plan's file-and-line map.
4. **Validation commands** — carry forward the plan's build/test commands verbatim
   if present; do not make the implementer hunt for them in plan.md.
5. **Edge cases** — carry forward the plan's edge-case list; expand any that your
   Step 2 verification touched.
6. **Out of scope** — carry forward, so the implementer doesn't over-build.
7. **Decision log** — carry forward locked decisions and their rationale; the
   implementer should not have to re-litigate something already decided.
8. **Architectural risks / diagrams** — carry forward if the plan has them; these
   are exactly the kind of context that prevents a technically-correct-but-wrong
   implementation.
9. **Acceptance criteria** — the plan's, expanded with anything Step 2 surfaced
   (e.g. a regression scenario that must now be covered).

There is no word cap. Compress prose, never information. Sparse implementation
detail in the _plan_ is fine and expected — filling that gap with verified,
concrete detail is define's job. A guide that is shorter than the plan because it
dropped sections is a defect, not concision.

- **Batch operation plans specifically:** does the guide include a check against
  `DefaultExporterResourceProvider` (the ES/OS exporter) to confirm whether a new
  handler is needed for the new operation type? The RDBMS exporter
  (`JobBatchOperationExportHandler` pattern) and the ES/OS exporter are independent
  registries — a missing ES/OS handler causes the `@MultiDbTest` IT to time out
  silently at the `COMPLETED` state assertion without any compile error.

## Step 4 — Concerns beyond the guide's scope (advisory)

Some findings from Step 2 are corrections you fold directly into the guide.
Others are broader problems with the plan itself that a guide rewrite can't fix:

- Does the plan **diverge** from the source issue's prescribed approach (if any)?
- Is the **requirement or acceptance** incomplete or unclear in a way that no
  amount of implementation detail resolves — i.e. a scoping or product decision,
  not an implementation gap?

If you find genuine concerns of this kind, append a **"Concerns / plan
challenges"** section to guide.md. State each concern concretely: what you
observed, what the requirement or issue says, and what a better plan would look
like.

If the plan is clean and well-scoped, omit the section entirely. Do not add
concerns for style preferences or minor wording — only for substantive
divergence or gaps that would mislead an implementer even after Step 2/3.

## Step 5 — Reflections (optional, do this last)

After guide.md is written and all other steps are complete, write any useful tips
or gotchas to $DAGRUN_ARTIFACTS/reflections.md. Cover both:

- Non-obvious facts about the Camunda code area (module invariants, gotchas, internal APIs)
- Anything that would help future define runs (tricky requirement patterns, issue-divergence pitfalls)

Absence is fine — only write reflections.md if there is something genuinely useful.
The SessionEnd hook captures this file automatically; you do not need to call any CLI command.
