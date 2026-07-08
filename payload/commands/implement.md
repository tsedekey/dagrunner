## Known environment constraints (read before starting)

These facts are pre-verified — do not re-investigate them:

- **Maven:** use `./mvnw <goal>` directly. The bare `./mvnw *` pattern is allow-listed.
  Do NOT prefix with `JAVA_HOME=...` or any other env variable — that pattern is not
  allow-listed and will be blocked. If Maven fails with a permission error, the cause is
  the env prefix, not the command itself.
- **Format hook:** the PostToolUse formatter covers frontend files only (TypeScript, JS, CSS).
  Java and Kotlin files do not need a manual format call after editing.
- **`.tool-versions` / Java version:** the worktree lives at
  `~/.local/share/dagrunner/worktrees/<run-id>/` — a separate directory tree from the main
  repo. `asdf` traverses upward from the worktree and never reaches `$DEVHARNESS_SRC`, so
  Java is not resolvable by default. If Maven fails with "No version is set for command java",
  copy the `java` line from `$DEVHARNESS_SRC/.tool-versions` into the worktree's
  `.tool-versions`:
  ```bash
  grep '^java ' "$DEVHARNESS_SRC/.tool-versions" >> "$DAGRUN_WORKTREE/.tool-versions"
  ```
- **`qa/acceptance-tests` module isolation:** this module resolves its ENTIRE dependency chain
  from `~/.m2`, NOT from the source tree — not just `clients/java`. When writing or modifying
  ITs in `qa/acceptance-tests`, install the full transitive closure first, before any compile or
  test run in the acceptance module:
  ```bash
  ./mvnw install -pl qa/acceptance-tests -am -Dquickly -T1C
  ```
  Skipping this step, or installing only a narrower subset (e.g. `clients/java` alone), leaves
  `~/.m2` holding stale/skewed transitive jars after a rebase or any multi-module production
  change. This does not just cause visible compile failures — a version-mismatched transitive
  class can also break the actor scheduler's future-chain in a way that never resolves, causing
  the embedded broker to **hang silently and indefinitely in `Broker.internalStart()`**, with no
  error and no timeout. `-am` ("also make") has Maven compute and install the full transitive
  dependency closure `qa/acceptance-tests` actually needs, so it structurally can't
  under-enumerate the way a hand-picked module list can. Run this install step once per session
  before touching `qa/acceptance-tests`.

---

Read the implementation guide. Check these paths in order and use the first one that exists:

1. `$DAGRUN_ARTIFACTS/../define/guide.md` (feature workflow)
2. `$DAGRUN_ARTIFACTS/../reproduce/guide.md` (bugfix workflow)

Also check for any reviewer feedback files at the same directory as the guide (`feedback-\*.md`).
If any feedback files exist, incorporate those instructions into the implementation — they represent
reviewer requests that were not fully addressed in the guide itself.

**When the guide names a precedent implementation** (phrases like "modeled on X", "following X
precedent", "similar to ExistingClass"): read that reference file before writing any new interface
or class. Only then implement, matching the structural shape of the reference. Do not design a new
interface without first reading the reference — interface shape mismatches require full rewrites.

Write a brief implementation summary to $DAGRUN_ARTIFACTS/summary.md describing:

1. What was implemented
2. Files changed (can be hypothetical for smoke test purposes)

Keep it under 100 words. Write to $DAGRUN_ARTIFACTS/summary.md.

Optionally, if you discover non-obvious facts about the Camunda code area while implementing
(hidden coupling, module quirks, surprising invariants), write them to $DAGRUN_ARTIFACTS/reflections.md.
Only write reflections.md if there is something genuinely useful for future runs. Absence is fine.

## Pre-stage deliverables check (mandatory)

Before running `git add`, re-read the guide and build a checklist of every required
deliverable — new files, test classes, modules, and any explicit "must implement" items.
For each deliverable, confirm it exists in the worktree:

```bash
# Example: check each expected file is present
ls <expected-file-1> <expected-file-2> ...
```

Produce a table in summary.md under a "Deliverables check" heading:

| Deliverable                      | Status    |
| -------------------------------- | --------- |
| `path/to/NewClass.java`          | ✓ created |
| `qa/acceptance-tests/...IT.java` | ✓ created |

**Do not stage until every deliverable is present.** If a deliverable is missing, implement it
now. An item that appears in the guide but is absent from the worktree is an incomplete
implementation, not a known omission.

## Final step — Stage implementation

After the deliverables check passes, stage your code changes:

```bash
cd "$DAGRUN_WORKTREE"
git add -A
git status --short
```

If the working tree is already clean, note it in summary.md and skip.

## Reflections (optional, do this last)

After all artifacts are written, write any high-signal tips
to $DAGRUN_ARTIFACTS/reflections.md — hidden couplings, build quirks, patterns worth
flagging for future runs. The SessionEnd hook captures this automatically.
Absence is fine — only write if you discovered something non-obvious.
