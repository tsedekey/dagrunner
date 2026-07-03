# Change: Gate Dialogue UX — spawn interactive Claude Code session

## Problem

The current gate UX asks the user to type a one-line rejection comment into the terminal (`[r]eject <comment>`). This is too clunky for meaningful feedback: real concerns require back-and-forth discussion to be articulated clearly. The agent that will revise its work needs nuanced, well-grounded feedback — not a rushed one-liner.

## Goal

Replace the terminal rejection prompt with a full Claude Code dialogue session. When the user rejects a gate (or needs to think it through), dagrunner spawns `claude` interactively. The human and a fresh Claude agent review the artifact together, discuss concerns over as many turns as needed, and produce a consensus summary. That summary becomes the feedback the author-agent receives for revision.

## Design

### Session model (DECISIONS.md note required)

The architecture spec (Theme 5) says to resume the node's own session for gate dialogue. Empirically tested: `claude --resume <sdk-sessionId>` returns "No conversation found" — the Agent SDK and the interactive Claude Code CLI do NOT share a session store. Fresh session is the only viable approach. Log this in DECISIONS.md.

### The handshake — two files

**`gate-context.md`** (written by dagrunner before spawning):
- Full artifact content (not just 40 lines)
- Node ID, run ID, iteration count / maxIterations
- Path of the gate-decision file the dialogue must write

**`gate-decision.md`** (written by `/gate-conclude` inside the CLI session):
```
decision: approve
```
or:
```
decision: reject

<multi-paragraph consensus feedback — specific, actionable, grounded in the artifact>
```

Dagrunner reads `gate-decision.md` after the `claude` process exits. If absent (user closed without deciding): print "No gate decision recorded — run `dagrun resume <id>` to review again" and exit cleanly. No lock held.

### Stale decision guard

Always delete any existing `gate-decision.md` before spawning. Multi-iteration gates reuse the same artifact dir — a prior rejection's decision file must not contaminate the current review.

### Two new slash commands

Both are seeded into the worktree's `.claude/commands/` via the existing `cpSync` in `startRun`/`resumeRun`/`rerunNode` — no new seeding logic needed.

**`payload/commands/gate-review.md`** — the opening command:
- Reads `$DAGRUN_GATE_CONTEXT_FILE` (set in env before spawning)
- Shows a clear summary of the artifact and what iteration this is
- Explains the decision options: approve or reject with specific feedback
- Asks the human what they think — no forced structure, let the conversation flow

**`payload/commands/gate-conclude.md`** — the closing command:
- Summarises the conversation to date into a decision statement
- Writes `$DAGRUN_GATE_DECISION_FILE` with the decision and feedback body
- Tells the user: "Gate decision recorded. Type `/exit` to return to dagrun."

### The spawn

```typescript
// Before spawning: delete stale decision, write fresh context, print guidance.
// spawnSync blocks dagrunner until the user exits the CLI.
const result = spawnSync('claude', [], {
  stdio: 'inherit',
  cwd: worktreePath,
  env: {
    ...process.env,
    DAGRUN_GATE_NODE_ID: gateNodeId,
    DAGRUN_GATE_CONTEXT_FILE: contextFilePath,
    DAGRUN_GATE_DECISION_FILE: decisionFilePath,
  },
});
```

After spawn returns: read `gate-decision.md`. Parse with `parseGateDecision()` (pure, unit-tested). Route: approve → `resumeRun({...opts, approve: true})`; reject → `resumeRun({...opts, rejectComment: body})`; absent → exit 0 (gate still open).

### `parseGateDecision` — pure exported function

```typescript
export function parseGateDecision(
  content: string,
): { decision: 'approve' | 'reject'; body: string } | null
```

Returns `null` when content is missing, malformed, or `decision:` line is not `approve`/`reject`. Dagrunner treats `null` the same as absent file (no decision recorded).

Unit-testable. Mirror pattern of `hasConcerns` and `formatVerifyRecommendation`.

### User guidance printed before spawn

```
dagrun: gate — node "expand" (iteration 1/10)
dagrun: opening Claude Code for review dialogue...
  → In the session: run /gate-review to start the review
  → When done:       run /gate-conclude to record your decision
  → To exit:         type /exit (not Ctrl-C)
```

### Night mode / non-interactive guard

`spawnSync('claude')` only executes on the interactive branch — i.e. no `--approve`, no `--reject`, no `nightMode`. The night-mode auto-approve loop and the non-interactive flags are unaffected; they bypass the gate block entirely and never reach the spawn.

### `maxIterations` — clarification note

`maxIterations` bounds **agent revision cycles** (reject → agent rewrites → re-gate), not human dialogue turns. The CLI session has no turn limit. `maxIterations` stays as specified. Surface this in the plan so the reviewer can object if their intent was different.

## Files changed

| File | Change |
|------|--------|
| `src/runtime/run-engine.ts` | Replace the `readOneLine()` interactive gate block with context-write + spawnSync + decision-parse. Add `parseGateDecision` pure function. |
| `payload/commands/gate-review.md` | New slash command (opening). |
| `payload/commands/gate-conclude.md` | New slash command (closing). |
| `DECISIONS.md` | Log: SDK sessionIds not resumable via `claude --resume`; fresh-session fallback chosen. |
| `src/runtime/run-engine.test.ts` | Unit tests for `parseGateDecision` (happy paths + malformed inputs). |
| `.claude/skills/architecture-spec/SKILL.md` | Update Theme 5 resume UX line to reflect spawn-new-session design. |

## What is NOT changed

- `--approve` / `--reject` CLI flags (non-interactive path unchanged)
- Night-mode auto-approve loop
- `maxIterations` gate config field
- Verify-election prompt (still terminal `readOneLine()` — separate interaction, not a gate)
- `readOneLine()` helper (still used by verify-election)

## Acceptance criteria

1. `parseGateDecision` unit tests pass.
2. All existing unit tests pass (`npm test`).
3. Manual smoke: `dagrun resume <id>` at a gate with no flags opens a Claude Code TUI; `/gate-review` shows the artifact context; `/gate-conclude` writes `gate-decision.md`; typing `/exit` returns to dagrun which picks up the approve/reject and continues.
4. `dagrun resume <id> --approve` still works (no CLI regression).
5. `dagrun resume <id> --reject "comment"` still works.
