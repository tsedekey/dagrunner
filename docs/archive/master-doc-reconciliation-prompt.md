# Task: Reconcile the dagrunner code with the Master Architecture doc

You are given `dagrunner-master-architecture.md` (the canonical design doc, reflecting all decisions through Phase 2b + the Phase 3 plan). Since it was last updated, you have implemented Phase 1, 2a, 2b (including the post-fixture change orders: classify removal / diff-triage-in-review, finding-count verifier, verify-election, and the verify-seed -> verify-guide swap). The code has likely DRIFTED from the doc.

Your job: produce a reconciled master doc that matches what the code ACTUALLY does, while preserving the doc's decisions and rationale. This will be used to re-align the architect and you before building the Phase 3 siblings.

## Rules (important)

1. **Code is the source of truth for WHAT exists; the doc is the source of truth for WHY.** Where they conflict, update the doc to match the code's behavior — but PRESERVE the rationale/principles unless the code deliberately overturned them.
2. **Do NOT silently fix.** Every change you make must be visible (see output format). The architect needs to SEE the drift, not have it quietly absorbed.
3. **Do NOT aspirationally describe.** Document only what is actually implemented and working. If something is partial/stubbed/TODO, label it as such.
4. **Preserve section numbering and structure.** Edit sections in place; don't restructure. If you add a section, append it and flag it as NEW.
5. **Flag contradictions you cannot resolve** rather than guessing — list them as open questions for the architect.

## What to do

1. **Summarize what you built**, per phase (1 / 2a / 2b), as a short changelog: nodes, gates, commands, key files/modules, schemas, hooks, config. Include anything you implemented that the doc does NOT mention.

2. **Walk the doc section by section** (§1–§12 plus §7b/§7c). For each, classify as:
   - `MATCHES` — code and doc agree (no change).
   - `DRIFTED` — code differs; describe the actual behavior and update the section to match.
   - `MISSING-IN-DOC` — code has something the doc omits; add it.
   - `MISSING-IN-CODE` — doc specifies something not yet built; mark it clearly as not-yet-implemented (do NOT delete — it may be future scope).

3. **Pay special attention to these high-drift-risk areas** (verify against actual code, don't assume):
   - The actual node list and their order (pipeline §3) — names, what each produces, exact gate placement.
   - The findings schema (§3) and the verify-guide output schemas (seeding-spec.json / tour-spec.json §7c) — dump the ACTUAL schemas as implemented.
   - The runtime permission/sandbox/network settings.json (§5) — the ACTUAL seeded config, including any deviations you had to make to get it working.
   - state.json shape, run-dir layout, CLI command surface (§4) — what `dagrun` subcommands actually exist.
   - Model tiers actually used per node (§8).
   - The reflect node's two flavors + apply-reflection guardrails + where it writes (§7b) — confirm DEVHARNESS_SRC write-back is actually implemented (or note if not).
   - Anything in the change orders (classify removed, diff-triage in review, finding-count verifier, verify-election, verify-guide) — confirm the code matches these LATEST decisions, not the pre-change-order design.

4. **Produce the reconciled doc** with every changed section marked inline using this convention:
   - Prefix each section heading with its status tag, e.g. `## 3. The feature pipeline [DRIFTED]`.
   - Within a drifted/added section, wrap the substantive changes in `<!-- DRIFT: ... -->` comments briefly explaining what changed vs. the original, so the architect can diff at a glance.

5. **End with two lists:**
   - **Open questions / unresolved contradictions** for the architect.
   - **Implemented-but-undocumented decisions** you made during the build that should become formal architecture (e.g. a config deviation, an extra helper command, a schema field you added).

## Output

Return the full reconciled `dagrunner-master-architecture.md` (all sections, tags inline) plus the changelog and the two end-lists. Keep rationale prose intact where unchanged; be concrete and code-accurate where changed. Do not run any sandbox/cluster operations — this is a documentation reconciliation, read the code and write the doc.
