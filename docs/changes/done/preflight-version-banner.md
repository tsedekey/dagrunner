---
title: "Preflight version banner + mandatory version bump policy — dagrunner self-change plan"
related: "none"
created: 2026-07-01
status: approved
---

# Preflight version banner + mandatory version bump policy

## Context (read first)

`dagrun` has no version display anywhere today — confirmed by grep: no `--version` flag, no
`version` field printed in `src/cli/cli.ts` or `src/cli/preflight.ts`, and `package.json` has sat at
`0.1.0` since inception. The master doc (`docs/dagrunner-master-architecture.md` §7) references a
`src/config/versions.ts` with `EXPECTED_CLAUDE_CLI_VERSION` — **this file does not exist in the
repo**; the doc is stale on this point. Treat code as truth: there is no existing version-pin
module to extend, and this plan does not build the CLI-version-pin feature described there — that
is a separate, out-of-scope concern. Note the doc/code mismatch in DECISIONS.md when you hit it.

Eddie wants two things:
1. Every `dagrun` run (interactively via `dagrun preflight`, and automatically inside `dagrun
   start`) to print the dagrunner package version **and** the exact build date/time, so he can
   confirm which build he's running before a workflow starts mutating anything.
2. Going forward, every change to dagrunner bumps the version — this is a process rule for the
   build harness (`dr-build`), not a one-off code change.

## Root cause / rationale

There is currently no way to tell, at a glance, which build of `dagrun` is installed at
`~/.local/bin/dagrun` vs. the source tree — `dagrun` is a compiled binary (`dist/cli/cli.js`) and
staleness between a rebuild and the running binary is exactly the kind of silent-drift bug this
project's "fail loud" ethos exists to prevent. A version + build-timestamp banner makes that drift
visible instead of assumed.

## The change (directional)

| File / module / function | Type | Change (directional) | Why |
| --- | --- | --- | --- |
| `scripts/write-build-meta.mjs` | CREATE | Node-builtins-only script: reads `package.json` version, writes `dist/build-meta.json` = `{ version, buildTime: <ISO now> }` | Stamps the *actual compile instant*, not the source checkout time — matches the fixed-binary-drift concern |
| `package.json` (`scripts.build`) | MODIFY | `"build": "tsc -p tsconfig.json && node scripts/write-build-meta.mjs"` | Build-meta must regenerate every build, never go stale |
| `src/config/version.ts` | CREATE | `getVersionInfo(): { version: string; buildTime: string; isDev: boolean }`. Reads `package.json` version by walking up from `import.meta.url`. If running from `dist/` (path contains `${sep}dist${sep}`), reads `dist/build-meta.json` and fails loud if it's missing (a built binary with no build-meta is a broken build). If running from `src/` (dev via `tsx`), returns `isDev: true` with `buildTime: "unbuilt (dev)"` — no build-meta expected in dev | Single source of truth for version display; fail-loud only applies to the compiled artifact, not dev iteration |
| `src/cli/preflight.ts` (`formatAgentContext`) | MODIFY | Add a `dagrun version` line as the very first line of the `⚙️  Configuration` block: `  dagrun version    0.1.0  (built 2026-07-01 14:32:05 UTC)` (or `(dev, unbuilt)` in dev mode) | This is the block the user already reads for run config; version belongs next to it, not a separate section |
| `src/cli/cli.ts` (`cmdStart`) | MODIFY | After `runPreflight` passes (before `dagrun: starting run ...`), print the same one-line version banner (`dagrun v0.1.0 — built 2026-07-01 14:32:05 UTC`) so it's visible even when the user skips the standalone `dagrun preflight` step | User explicitly wants this visible "before starting a workflow run", and today `cmdStart` prints nothing at all on a passing preflight |
| `.claude/agents/dr-build.md` (Commit style / Done criteria) | MODIFY | Add: before committing, bump `package.json` version (`npm version patch --no-git-tag-version` unless the plan specifies otherwise) and include the updated `package.json` in the commit. Every dr-build-executed change ships a version bump | This is the durable enforcement point — dr-build is what actually runs every future self-change and commit, per established delegation workflow |
| `CLAUDE.md` (root) | MODIFY | One line under engineering discipline: "Every change bumps `package.json`'s version — enforced by `dr-build`." | Keep root CLAUDE.md's always-on context honest about the policy without duplicating the mechanism |

**Things to get right**

- `getVersionInfo()` must not throw in dev mode just because `dist/build-meta.json` doesn't exist —
  only fail loud when running from a compiled `dist/` path with a missing/unparsable build-meta
  file (that's a broken release build, not a dev-loop annoyance).
- Walking up from `import.meta.url` to find `package.json` must work identically whether the module
  lives at `src/config/version.ts` (via `tsx`) or `dist/config/version.js` (via compiled `node`) —
  both are exactly two directories below the project root; don't hardcode a `src/` or `dist/`
  assumption into the walk-up itself, only into the build-meta branch.
- Timestamp formatting: render `buildTime` as `YYYY-MM-DD HH:MM:SS UTC`, not a raw ISO string with
  a `T`/`Z` — this is for a human glancing at a terminal before a run starts.
- This plan does NOT implement the `EXPECTED_CLAUDE_CLI_VERSION` / CLI-version-pin feature the
  master doc describes in §7 — that module doesn't exist yet and is out of scope here. Don't
  conflate dagrunner's own package version with the Claude CLI toolchain pin.
- `dist/build-meta.json` needs no new `.gitignore` entry — `dist/` is already fully ignored.

## Validation (prove it — evidence, not assertion)

- `version.test.ts` (new, Tier A): fixture-injects a fake module URL / temp `dist` layout to prove
  (a) dev-mode path returns `isDev: true` without touching `dist/build-meta.json`; (b) compiled-path
  mode reads a fixture `build-meta.json` correctly; (c) compiled-path mode with a missing
  `build-meta.json` throws/fails loud with a clear message.
- `preflight.test.ts` extension: `formatAgentContext` output includes the version line; update the
  `preflight.golden.txt` snapshot deliberately (`UPDATE_SNAPSHOTS=1`) and diff it in the report so
  the reviewer can see exactly what changed.
- Manual proof: run `npm run build`, inspect `dist/build-meta.json` has a fresh timestamp; run
  `dagrun preflight` from the built binary and confirm the printed build time matches; then run via
  `npm run dagrun` (tsx/dev) and confirm it prints `(dev, unbuilt)` instead of a stale timestamp.
- `verify-baseline` green.

## Done criteria (delta-specific)

- `dagrun preflight` and a passing `dagrun start` both print `dagrun` version + build date/time
  before any node runs.
- `npm run build` regenerates `dist/build-meta.json` on every build with a fresh timestamp.
- `dr-build.md` and root `CLAUDE.md` updated so every future self-change bumps the version — verify
  by confirming this very plan's own commit bumps `package.json` to `0.1.1` (or next appropriate
  bump) as dr-build's first applied instance of the new policy.
- master doc's stale `src/config/versions.ts` / `EXPECTED_CLAUDE_CLI_VERSION` reference either
  corrected to reflect that it doesn't exist yet, or left with an explicit "not yet implemented"
  note — do not let it keep reading as if it's built.

## Out of scope

- Implementing the Claude CLI toolchain version pin (`EXPECTED_CLAUDE_CLI_VERSION`,
  `DAGRUN_SKIP_CLI_VERSION_CHECK`) described in master doc §7 — separate, pre-existing gap, not
  part of this request.
- Semantic-version-level choice (major/minor/patch) automation beyond a default `patch` bump —
  if a future change is a breaking/minor change, that's a judgment call for the dr-build session at
  the time, logged in DECISIONS.md, not something this plan needs to automate.
- A `dagrun --version` top-level flag — not requested; the display is scoped to preflight output.
