## Known environment constraints (read before starting)

These facts are pre-verified — do not re-investigate them:

- **Maven:** use `./mvnw <goal>` directly. The bare `./mvnw *` pattern is allow-listed.
  Do NOT prefix with `JAVA_HOME=...` or any other env variable — that pattern is not
  allow-listed and will be blocked. If Maven fails with a permission error, the cause is
  the env prefix, not the command itself.
- **Format hook:** the PostToolUse formatter covers frontend files only (TypeScript, JS, CSS).
  Java and Kotlin files do not need a manual format call after editing.
- **`.tool-versions` / Java version:** the worktree (`<worktree>`) is a separate directory tree
  from the main repo. `asdf` traverses upward from the worktree and never reaches
  `$DEVHARNESS_SRC`, so Java is not resolvable by default. If Maven fails with "No version is
  set for command java", copy the `java` line from `$DEVHARNESS_SRC/.tool-versions` into the worktree's
  `.tool-versions`:
  ```bash
  grep '^java ' "$DEVHARNESS_SRC/.tool-versions" >> "<worktree>/.tool-versions"
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

> **Run environment.** The block directly below gives the **literal absolute** `artifactsDir`,
> `runDir`, `worktree` and `runId` for this session. Wherever this document writes `<artifactsDir>`,
> `<runDir>`, `<worktree>` or `<runId>`, substitute those literal values — type the real path, never a
> shell variable: the sandbox rejects Bash commands that contain a variable expansion
> (`simple_expansion`), which cost earlier runs dozens of denied calls.
>
> - **Read** upstream artifacts at `<runDir>/<node>/<file>` with the Read tool (or `cat` of the literal path).
> - **Write** your artifacts to `<artifactsDir>/<file>` with the Write tool using that exact absolute
>   path. `runDir` is read-only.
> - Never print or discover environment variables (`echo`, `printenv`, `env`).

Run environment (engine-provided):

$ARGUMENTS

Read the plan via `cat`. The approved plan is the contract for this run — it was written and
approved upstream, and no separate implementation guide is generated from it:

```bash
cat "<runDir>/plan/plan.md"
```

Identify from it: the goal, the change surface (which files/modules), the acceptance criteria or
the reported symptom, any test or validation command it names, and any deliverables it requires.

**When the plan names a precedent implementation** (phrases like "modeled on X", "following X
precedent", "similar to ExistingClass"): read that reference file before writing any new interface
or class. Only then implement, matching the structural shape of the reference. Do not design a new
interface without first reading the reference — interface shape mismatches require full rewrites.

---

## Step — Prove RED before implementation (mandatory, both bugfix and feature runs)

You write **no implementation code** until a test has been watched to fail for the right reason.
The plan tells you which case you are in: a plan that reports a defect (symptom, root cause,
regression test) is the **bugfix** case; a plan that describes new behaviour (acceptance criteria,
change surface) is the **feature** case.

1. **Pick the test that proves the change is needed**, at the unit/integration level — NOT an
   `@MultiDbTest` acceptance test; this step proves red at the unit/integration level only.
   - **Bugfix:** run the reproducing test or validation command the plan names. If the plan names
     none, write the smallest test that demonstrates the reported symptom and watch it fail.
   - **Feature:** write the smallest test (or small group of tests) the plan's acceptance criteria
     imply — one that would fail today because the described behavior doesn't exist yet, and would
     pass once it does.
2. **Run it and confirm it fails for the right reason** — the reported symptom, or the missing
   feature/behavior — not an unrelated compile error, a typo in the test itself, a wrong import, a
   missing fixture or an unavailable environment. Capture the actual failure output (the
   assertion/error text, not just "it failed").
3. **RED proven?** If yes, continue. If it cannot be proven, stop here — see "When RED cannot be
   proven" below.
4. **Only then write the implementation** that makes the test pass.
5. **Rerun the test to confirm it now passes (GREEN).** If it doesn't, keep iterating — do not move
   on with a still-red test.
6. **Write `<artifactsDir>/red-evidence.md`** containing:
   - Which test file and method/case this covers.
   - The captured RED failure output (step 2), with a one-line note on why it failed for the right
     reason.
   - Confirmation of the GREEN rerun (step 5) after implementation, with the passing output.
7. **Write `<artifactsDir>/red.json`** (valid JSON, exactly these keys):

   ```json
   {"red":"confirmed","test":"<file#case>","command":"<exact command you ran>"}
   ```

**Be honest with yourself about what this proves.** `red-evidence.md`'s presence and content prove
a plausible RED→GREEN narrative existed — they do not cryptographically prove the ordering actually
happened session-side. That is an accepted, known ceiling; do not try to engineer around it (e.g. by
inventing timestamps or hashes) — just do the actual RED→GREEN work honestly and record it
accurately.

### When RED cannot be proven — the run fails loudly (no escalation, no "continue and flag")

RED cannot be proven when: the bug is already fixed (the reproducing test passes), the test cannot
be found or run, it is flaky (different results on reruns), the environment is unavailable (build
broken, service/DB missing), or the plan's reproduction does not demonstrate the reported symptom
and the root cause plainly differs from the plan. In any of those cases:

- Write **no implementation code**. Stage **nothing** — no `git add`, no `deliverables.txt`. Leave
  any probe test you wrote unstaged and say so in `red-evidence.md`.
- **Still write all three files** — the engine checks that they exist before it reads `red.json`,
  and a missing one hides the real reason behind a generic "missing artifact" error:
  - `<artifactsDir>/summary.md` — two or three sentences: RED could not be proven, nothing was
    implemented.
  - `<artifactsDir>/red-evidence.md` — what you tried (exact commands), what you observed (output
    excerpts), and why that is not a proven RED.
  - `<artifactsDir>/red.json`:

    ```json
    {"red":"not-reproduced","reason":"<what was tried and observed>"}
    ```
- Then stop. Skip the deliverables check and staging below. The engine fails this node on
  `red.json` and no later node runs; the driver reports your `reason` to the human, who goes back to
  the planning session. Do not weaken the test, change the plan's expectation, or implement anyway
  to avoid this outcome.

### When RED is proven but the plan's assumptions differ — continue, and say so

If RED is proven but what you observed differs from the plan — the root cause is not the one the
plan states, or the change surface is broader than the plan expects (multiple modules, a
cross-cutting concern) — implement as the evidence supports and add a `## Concerns / plan
challenges` section to `summary.md`: for each concern, what you observed, what the plan says, and
what a reviewer should check. Keep it short. The heading is machine-read (it pauses `--night` runs
at the next gate), so use it exactly, and omit the section entirely when nothing differs.

---

Write a brief implementation summary to <artifactsDir>/summary.md describing:

1. What was implemented
2. Files changed (can be hypothetical for smoke test purposes)

Keep this description under 100 words (the "Deliverables check" table below and any "Concerns /
plan challenges" section come on top of it). Write to <artifactsDir>/summary.md.

Optionally, if you discover non-obvious facts about the Camunda code area while implementing
(hidden coupling, module quirks, surprising invariants), write them to <artifactsDir>/reflections.md.
Only write reflections.md if there is something genuinely useful for future runs. Absence is fine.

## Pre-stage deliverables check (mandatory)

Before running `git add`, re-read the plan and build a checklist of every required
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
now. An item that appears in the plan but is absent from the worktree is an incomplete
implementation, not a known omission.

## Final step — Stage implementation

After the deliverables check passes, stage **exactly** the confirmed deliverables — never
`git add -A` / `git add .`. The worktree can contain unrelated dirty files (pre-existing
`package.json`/lockfile drift, `node_modules` symlinks from a build) that are not yours to commit.

1. Write every confirmed deliverable path (the same rows as the "Deliverables check" table, plus
   any file you deliberately changed that the plan's change surface names), one repo-relative
   path per line, to `<artifactsDir>/deliverables.txt`. The `pr` node reads this file.
2. Stage only those paths, then verify nothing else is in the index:

```bash
cd "<worktree>"
cat > "<artifactsDir>/deliverables.txt" << 'PATHS'
path/to/NewClass.java
qa/acceptance-tests/...IT.java
PATHS

while IFS= read -r p; do [ -n "$p" ] && git add -- "$p"; done < "<artifactsDir>/deliverables.txt"

# Safety net: refuse if anything staged is not a declared deliverable
unexpected=$(git diff --cached --name-only --no-renames | grep -vxF -f "<artifactsDir>/deliverables.txt")
if [ -n "$unexpected" ]; then
  echo "ERROR: staged paths not in deliverables.txt — refusing to proceed:" >&2
  echo "$unexpected" >&2
  exit 1
fi
git status --short
```

If the safety net fires, do not continue: `git restore --staged -- <path>` each unexpected path
(or add it to `deliverables.txt` only if it is genuinely part of the fix), then re-run it. Files
left dirty in the worktree that are not deliverables stay unstaged — mention them in summary.md.

If the working tree is already clean, note it in summary.md and skip.

## Red flags — talk yourself out of these, don't act on them

| Red flag phrase (in your own reasoning)                           | What to do instead                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| "This should work, I don't need to run the test first"            | Run it anyway. A test you didn't watch fail cannot prove it was ever testing the right thing.                                                 |
| "I'll write the test after — same effect, saves a step"           | Order matters, not just presence. Write-then-implement can silently write a test shaped to already pass.                                      |
| "This is obviously correct, RED is a formality here"              | The RED step exists precisely for the cases that feel obvious — that's when a wrong-reason pass hides.                                        |
| "The plan didn't ask for a test here, I'll skip red-evidence.md"  | The RED step applies to every run — infer the test from the plan's symptom or acceptance criteria and do it.                                  |
| "I can't get RED, but the fix is obvious — I'll implement anyway" | No. Unproven RED fails the run: write red.json `not-reproduced` with the reason, plus summary.md and red-evidence.md, and stop.               |
| "One more file while I'm in here — small scope creep"             | If it's not in the plan's deliverable list, defer it or flag it in summary.md; don't fold it in silently.                                     |
| "Close enough, I'll leave a stub / TODO for the rest"             | An incomplete deliverable is a failed one, not a known omission — finish it or explicitly flag it, don't stub it.                             |

## Reflections (optional, do this last)

After all artifacts are written, write any high-signal tips
to <artifactsDir>/reflections.md — hidden couplings, build quirks, patterns worth
flagging for future runs. The SessionEnd hook captures this automatically.
Absence is fine — only write if you discovered something non-obvious.
