# dagrunner — Phase 2b Change Order: replace verify-seed with verify-guide

Context: Phase 2b is mid-build. The `verify-seed` node (stand up a real headless cluster + seed data) is being REMOVED and replaced with `verify-guide` (information-only). Root cause: cluster bring-up (Maven build, Elasticsearch under Docker, broker/gateway) fundamentally conflicts with the runtime sandbox (§5 of the master doc) — it needs Docker, broad network, host ports, and out-of-tree writes, which the sandbox forbids. Lifting the sandbox for that one node breaks the security model for every other node. The automation is also negative-ROI: Eddie can stand the cluster up faster by hand. This is not a bug to fix — the work doesn't belong inside a sandboxed node.

This is a focused change against the in-progress 2b code. Canonical spec: master doc §3, §7c.

---

## What to remove

- The entire `verify-seed` cluster automation: no Maven build, no Docker/Elasticsearch start, no broker/gateway bring-up, no c8 cluster lifecycle, no cluster teardown in `dagrun cleanup`. Delete that node's implementation.

## What to build instead: `verify-guide` (information-only node)

- DAG node, model = haiku. Runs only when the verify-election (after the fix gate) is `y`; otherwise `skipped`.
- **No cluster, no Docker, no Maven, no network beyond reading the worktree.** It cannot fail the way verify-seed did — it only reads context and writes artifacts.
- Inputs: the implement diff, the review findings, the directional plan, and the expand-guide/implement `notes.md` side-artifacts.
- **Produces TWO structured artifacts** (design these as machine-consumable, NOT just prose — they are the input contract for a future Phase 3 `/verify-demo` command):

  1. `verify/seeding-spec.json` — what data to seed to demonstrate the feature, structured enough for `c8ctl` to execute later:
     ```
     {
       deployments: [{ bpmn_resource | description, why }],
       instances:   [{ process_id, variables, why }],
       expected_observations: [{ where: 'elasticsearch'|'operate'|..., what, expected_value }]
     }
     ```
  2. `verify/tour-spec.json` — a guided code-trail of the change, with CANDIDATE BREAKPOINTS AS file:line (computed from the diff — verify-guide has the diff context, so it must resolve the locations, not defer them):
     ```
     {
       feature_summary: string,
       breakpoints: [{ file, line, why, what_to_observe }],   // ordered = the tour
       before_path?: [{ file, line, note }]   // for MODIFICATIONS; may be thin/empty for pure ADDITIONS
     }
     ```

- Also emit a human-readable `verify/manual-test.md` rendered from the two specs (so Gate 3 has something readable to present).

## Gate 3 (repurposed, kept)

- Presents `verify/manual-test.md`. The HUMAN stands up the cluster and runs the test (or, in Phase 3, invokes `/verify-demo`). Approve -> pr; reject-with-comment -> conversation-led revise of the guide, re-pause. Single-awaiting-gate invariant holds.

## Important notes

- **`/verify-demo` is NOT built in 2b.** It is a Phase 3 sibling (interactive Claude Code command, outside dagrunner) that will consume the two specs above to: build a real headless OC via the DMS JetBrains plugin (MCP), start Elasticsearch in Docker, seed via c8ctl, and place breakpoints from tour-spec for a human-followed walkthrough. 2b only needs verify-guide to EMIT the two structured artifacts. Do not build cluster/demo execution now.
- **Design the artifact schemas carefully now** — they are verify-demo's input contract. Getting file:line breakpoints into tour-spec (from the diff) is the load-bearing piece; do not leave breakpoint-location derivation to verify-demo.
- For PURE ADDITIONS the `before_path` may be thin/empty — that is expected, not an error.

## Acceptance (re-run the synthetic 2b fixture)

1. No cluster/Docker/Maven is invoked by any node; nothing sandbox-hostile runs.
2. verify-election `y` -> verify-guide writes `seeding-spec.json` + `tour-spec.json` (valid schemas) + `manual-test.md`; `n` -> skipped -> pr.
3. tour-spec breakpoints are real file:line locations drawn from the actual diff.
4. Gate 3 presents the manual; approve -> pr; reject -> guide revises in-session.
5. `npm run verify-baseline` exits 0; full slice green.

## Out of scope

`/verify-demo` (Phase 3). pr/reflect/apply-reflection remain as already specced in the 2b handoff. No cluster automation anywhere in dagrunner.
