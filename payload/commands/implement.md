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
- **Maven output volume:** this session runs many `./mvnw` invocations while iterating, and every
  one's stdout persists in context and gets re-read on every subsequent turn — verbose build/test
  output compounds across all of them into a large chunk of this session's token cost. Suffix Maven
  invocations with `-q` by default (e.g. `./mvnw compile -q`,
  `./mvnw test -pl <module> -Dtest=<ClassName> -q`). On failure, do not re-run verbose to see
  what broke — pipe the failing invocation's output through something like `tail -n 100` or
  `grep -A20 -B5 -i 'error\|failure'` to extract just the relevant failure text before deciding
  next steps.

---

> **⚠️ Do not try to print or discover the literal value of any `$DAGRUN_*` variable** (e.g. via
> `echo`, `printenv`, `env`, or `node -e ...process.env`) — this sandbox's Bash tool blocks bare
> variable-expansion/introspection commands outright, before any approval prompt; and even where
> it doesn't, printing env vars requires human approval that never arrives in this unattended
> session. Using a `$DAGRUN_*` variable inline inside a real command works fine — the shell expands
> it as part of that command's own side effect:
>
> - **Read** a `$DAGRUN_ARTIFACTS`-relative file via `cat` in Bash — not the Read tool, which needs
>   a literal path you don't have.
> - **Write** via a heredoc (`cat > "$DAGRUN_ARTIFACTS/x.md" << 'EOF' ... EOF`) — not the Write
>   tool, for the same reason.
> - If you ever genuinely need the literal path, derive it with `cd "$DAGRUN_ARTIFACTS" && pwd` —
>   a real command, not a bare print.

Read the implementation guide via `cat`. Check these paths in order and use the first one that
exists — **remember which one it was**, it decides whether the RED-step below applies:

1. `cat "$DAGRUN_ARTIFACTS/../define/guide.md"` (feature workflow)
2. `cat "$DAGRUN_ARTIFACTS/../reproduce/guide.md"` (bugfix workflow)

Also check for any reviewer feedback files at the same directory as the guide (`feedback-\*.md`).
If any feedback files exist, incorporate those instructions into the implementation — they represent
reviewer requests that were not fully addressed in the guide itself.

**When the guide names a precedent implementation** (phrases like "modeled on X", "following X
precedent", "similar to ExistingClass"): read that reference file before writing any new interface
or class. Only then implement, matching the structural shape of the reference. Do not design a new
interface without first reading the reference — interface shape mismatches require full rewrites.

---

## Step — Verified-RED before implementation (feature workflow ONLY — `define/guide.md` path)

**Skip this entire step if you read `reproduce/guide.md` (bugfix workflow) — go straight to "Write
a brief implementation summary" below.** The bugfix workflow already proves red at the bug-symptom
level in `reproduce.md` Step 2 (the reproducing test/validation command is run and confirmed to
currently fail, before any guide is written) — repeating that proof here would duplicate work `fix`
and `verify` already build on. This step exists ONLY to close the equivalent gap on the feature
path, which has no such proof today.

If you read `define/guide.md`, before writing any implementation code:

1. **Identify the test(s) the guide's acceptance criteria imply**, at the unit/integration level —
   NOT an `@MultiDbTest` acceptance test. Authoring the acceptance test is `verify`'s job, done later
   in isolated context specifically so it isn't graded by the same session that wrote the feature
   (see `payload/commands/verify.md`); duplicating that here would blur the split and buy nothing.
   Pick the smallest test (or small group of tests) that would fail today because the described
   behavior doesn't exist yet, and would pass once it does.
2. **Write that test first.** Run it. Confirm it fails, and — this is the part that actually
   matters — confirm it fails **for the right reason**: missing feature/behavior, not an unrelated
   compile error, a typo in the test itself, or a wrong import. Capture the actual failure output
   (the assertion/error text, not just "it failed").
3. **Only then write the implementation** that makes the test pass.
4. **Rerun the test to confirm it now passes (GREEN).** If it doesn't, keep iterating — do not move
   on with a still-red test.
5. **Write `$DAGRUN_ARTIFACTS/red-evidence.md`** containing:
   - Which test file and method/case this covers.
   - The captured RED failure output (step 2), with a one-line note on why it failed for the right
     reason.
   - Confirmation of the GREEN rerun (step 4) after implementation, with the passing output.

**Be honest with yourself about what this proves.** `red-evidence.md`'s presence and content prove
a plausible RED→GREEN narrative existed — they do not cryptographically prove the ordering actually
happened session-side. That is an accepted, known ceiling; do not try to engineer around it (e.g. by
inventing timestamps or hashes) — just do the actual RED→GREEN work honestly and record it
accurately.

---

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

## Red flags — talk yourself out of these, don't act on them

| Red flag phrase (in your own reasoning)                           | What to do instead                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| "This should work, I don't need to run the test first"            | Run it anyway. A test you didn't watch fail cannot prove it was ever testing the right thing.                                                 |
| "I'll write the test after — same effect, saves a step"           | Order matters, not just presence. Write-then-implement can silently write a test shaped to already pass.                                      |
| "This is obviously correct, RED is a formality here"              | The RED step exists precisely for the cases that feel obvious — that's when a wrong-reason pass hides.                                        |
| "The guide didn't ask for a test here, I'll skip red-evidence.md" | The RED step is scoped to the guide's acceptance criteria, not to an explicit guide instruction — infer the test from the criteria and do it. |
| "One more file while I'm in here — small scope creep"             | If it's not in the guide's deliverable list, defer it or flag it in summary.md; don't fold it in silently.                                    |
| "Close enough, I'll leave a stub / TODO for the rest"             | An incomplete deliverable is a failed one, not a known omission — finish it or explicitly flag it, don't stub it.                             |

## Reflections (optional, do this last)

After all artifacts are written, write any high-signal tips
to $DAGRUN_ARTIFACTS/reflections.md — hidden couplings, build quirks, patterns worth
flagging for future runs. The SessionEnd hook captures this automatically.
Absence is fine — only write if you discovered something non-obvious.
