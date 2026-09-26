# /verify — Provision the Change for Manual Testing (then STOP)

You are running the **verify node** of a dagrunner pipeline (bugfix and feature workflows share this
prompt). Eddie chose to run you at the fix gate because trying the change by hand is worth it for
this case. Your job: build the **actual candidate** from the worktree, **deploy it on a local
disposable target**, seed any demo data the scenario needs, prove the environment is reachable, write
Eddie **manual verification instructions**, and **STOP — leaving the environment running**.

**You render no verdict.** Do not curl the endpoint "to see if it works" as a pass/fail, do not
classify DEMONSTRATED/NOT_DEMONSTRATED (those outcomes no longer exist), and do **not** tear the
environment down. Eddie tests by hand, tells his planning companion his verdict, and dagrunner
removes everything (from your recorded inventory) when that verdict is decided at the pre-PR gate.
You are a one-shot, non-resumable session and must never wait for him.

**What this node is NOT.** It is not a second copy of CI. Do not author, extend or run an
`@MultiDbTest` acceptance test. It also does not replace the unit/integration/regression checks
`implement`/`fix` already ran (do not delete, weaken or skip them; do not claim they ran if you did
not run them).

Env vars you have:

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout (do not modify)
- `$DAGRUN_ARTIFACTS` — write `verify-report.json` and `demo.md` here (nowhere else)
- `$DAGRUN_RUN_ID`, `$DAGRUN_WORKTREE` (your cwd), `$DAGRUN_RUN_DIR` (read upstream artifacts here)

> **Do not print or discover the literal value of any `$DAGRUN_*` variable** (`echo`, `printenv`,
> `env`, `node -e ...`) — the sandbox blocks it. Use the variable inline inside a real command
> (`cat "$DAGRUN_RUN_DIR/..."`, heredoc writes to `"$DAGRUN_ARTIFACTS/..."`).

## Known constraints (pre-verified — do not re-investigate)

- **Maven:** `./mvnw <goal>` directly; no `JAVA_HOME=...` prefix. If it says "No version is set for
  command java": `grep '^java ' "$DEVHARNESS_SRC/.tool-versions" >> "$DAGRUN_WORKTREE/.tool-versions"`.
- **This session is one-shot and non-resumable.** `ScheduleWakeup` is disallowed. If a command
  auto-backgrounds, poll it to completion in this same turn with `TaskOutput(task_id, block: true,
timeout: <bounded>)`. A denied/errored `Monitor`/`TaskOutput` setup is NOT "something is watching".
  Stop polling a build after ~20 minutes with no progress and classify `BLOCKED_RUNTIME` (after cleaning up — see Step 5).
- **Permissions are not yours to widen.** Use only what the seeded settings already allow (`docker *`
  is allow-listed). If a tool you need (e.g. `c8ctl`) is denied, that is a blocked capability, not a
  prompt to work around — do not install tools, pull unrelated images or edit settings.

## Step 1 — Read what Eddie should try

```bash
cat "$DAGRUN_RUN_DIR/define/guide.md" 2>/dev/null || cat "$DAGRUN_RUN_DIR/reproduce/guide.md"
cat "$DAGRUN_RUN_DIR/fix/summary.md"
cat "$DAGRUN_RUN_DIR/fix/next-node-decision.json"
```

From the guide take the expected behavior / acceptance criteria and, for a bug, the failing
scenario. `fix/summary.md` should carry a `## Verify recommendation` (what worth showing, and why);
`next-node-decision.json` may carry a `focus` from Eddie — if present it overrides your own choice
of what to show. Decide the **smallest scenario** Eddie should try by hand; do not build a
broad test matrix.

## Step 2 — Choose the runtime capability (least intrusive that works)

This is capability _selection_, not a mandatory sequence. Probe read-only first and record what you
find; do not assume anything below exists:

```bash
docker info > /dev/null 2>&1 && echo docker_reachable=0 || echo docker_reachable=1
command -v c8ctl >/dev/null 2>&1 && echo c8ctl=present || echo c8ctl=absent
ls "$DAGRUN_WORKTREE"/c8run "$DAGRUN_WORKTREE"/docker-compose* "$DAGRUN_WORKTREE"/*/docker-compose* 2>/dev/null
```

**Default for anything with a runtime surface (web app, REST endpoint, config property, engine
behavior): a real process on a bound loopback port**, using only pre-approved executables
(`./mvnw`, `docker`). Preference order:

1. **`docker`** — build the distribution from the worktree, wrap it in an image, `docker run` it:

   ```bash
   ./mvnw install -pl dist -am -Dquickly -T1C            # -> dist/target/camunda-zeebe*.tar.gz
   docker build --build-arg BASE=public --build-arg DISTBALL=<that tar.gz> \
     -f camunda.Dockerfile -t dagrun-$DAGRUN_RUN_ID-camunda .
   docker run -d --name dagrun-$DAGRUN_RUN_ID-camunda -p 127.0.0.1:<free-port>:8080 \
     dagrun-$DAGRUN_RUN_ID-camunda
   ```

   (Pattern from `docs/zeebe/building_docker_images.md`; adjust to what the repo actually has —
   probe, do not assume. Give the container the minimum config the scenario needs, e.g. an opt-out
   property via `-e`.) Image digest = `artifactIdentity`. Leave the container RUNNING.
2. **compose / c8run** — only if the repo already ships a ready compose file or a built `c8run`
   binary (packaging c8run needs Go + credentials: not available here — do not try).
3. **c8ctl** — for seeding/observing an already-running cluster, only if `c8ctl` is present.
   (`/seed-data` + `seeding-spec.json` belong to the on-demand `/manual-smoke` sibling and a
   human-started cluster; this node neither produces nor consumes them. Seed minimal demo data
   yourself with `curl`/`c8ctl` against your own container when the scenario needs any.)

**Forbidden — these are known dead ends, do not attempt them:** hand-writing a scratch Spring Boot
app / `main` class / harness; assembling a classpath with `dependency:build-classpath`; raw
`java`/`javac` (not pre-approved); adding any source file or editing any `pom.xml` in the worktree;
compiling inside a stock image (JRE only, no `javac`).

**Source-only hand-off is a deliberate exception, not a fallback.** Use `capability: "source"`
only when the change has genuinely no user-observable runtime surface (pure refactor / library logic) — no environment is provisioned and there is nothing to tear down later, and then
state why in `sourceRationale` in the report (the engine rejects `source` without it). "Docker build
was slow/hard" is not a rationale; re-running an existing test is never a substitute for a change that has a runtime surface. If the docker path fails for a real reason,
classify `BLOCKED_RUNTIME` with that reason rather than substituting a weaker hand-off.

## Step 3 — Pin the candidate (provenance)

The artifact you provision MUST be built from this worktree. A stock released image can only be a
**baseline** — it can never stand in for an unbuilt source change.

```bash
git -C "$DAGRUN_WORKTREE" rev-parse HEAD
git -C "$DAGRUN_WORKTREE" status --porcelain -uall
```

`dirtyFiles` may be given either as those raw porcelain lines or as bare paths — the engine
normalizes both sides. It ignores anything under `node_modules` (dependency output written by
unrelated processes such as an IDE's background install); every other tracked or untracked file is
still compared exactly.

The fix may be uncommitted (`pr` commits later); the candidate is HEAD **plus** those dirty files.
Build from the working tree, then record: the built artifact path, its identity (image digest or
`sha256sum` of the jar/distribution), tool versions, and the build command. **Do not modify tracked
files, commit, or run `git add`** — the report's `dirtyFiles` must still equal the porcelain list
when you finish, or the node fails.

## Step 4 — Provision, prove readiness, write the manual steps, STOP

1. **Local disposable target only.** Bind to loopback (`127.0.0.1`), use fresh state, and prefix
   EVERY container/network/image tag/volume/temp dir you create with `dagrun-$DAGRUN_RUN_ID-` (use
   the run id via inline shell expansion). The teardown refuses anything without that exact prefix.
   Ignore ambient endpoints: never use any `ZEEBE_*`/`CAMUNDA_*` address or credential already in the
   environment, and never touch a resource you did not create.
2. Build and deploy per Step 2 (`docker run -d`, published on `127.0.0.1:<free-port>`). Seed the
   minimal demo data the scenario needs (with `curl`/`c8ctl` against your own container) so Eddie can
   try it immediately. Give the container the minimum config the scenario needs.
3. **Readiness probe** (the only thing you check): one bounded probe that the environment is up and
   reachable, e.g. a health/readiness endpoint or a login page returning 2xx — poll up to a few
   minutes. Record the exact command and its output as `readiness`. If it never becomes ready, that
   is `BLOCKED_RUNTIME` (Step 5) — an environment that is not reachable is not `PROVISIONED`. This
   probe is not a judgment of the change; do not run the failing/fixed scenario yourself.
4. **Record everything you created** in `target.ownedResources` as typed entries
   `{"kind": "container|network|image|volume|tempdir", "name": "dagrun-<run>-..."}` — write it AS
   you create each resource, so a later cleanup needs no other memory. Also record `target.port`
   (the host port).
5. Write `demo.md` (below) and `verify-report.json`, then **stop**. Do not remove anything.
6. Bounded: hard stop at ~30 minutes of wall-clock, ≤ 2 self-corrections of your own setup errors.

## Step 5 — On failure: clean up your own partial resources (only case you tear down)

If you cannot reach `PROVISIONED` (build/startup failed, readiness never came up, capability
denied), no human will ever test the leftovers: stop and remove everything you created
(`dagrun-$DAGRUN_RUN_ID-*` containers, networks, image tags, volumes, temp dirs), verify with
`docker ps -a --filter name=dagrun-...`, and write `BLOCKED_RUNTIME` with a `reason` and an honest
`cleanup: {"status": "clean|leftovers", "leftovers": [...]}` (still list anything you created in
`target.ownedResources` if leftovers remain). This is never a pass.

## Step 6 — Write the evidence

### `$DAGRUN_ARTIFACTS/demo.md` (for Eddie — he follows this by hand)

- **How to reach it**: host (`127.0.0.1`), the host port, base URLs / UI paths. No credentials that
  are secret; the demo user is fine if it is a throwaway default of the disposable container.
- **What was set up**: build command, image, config/env you set, any seeded data (ids/names).
- **Manual steps**: exact commands or clicks, in order, with the **expected result** for each
  (what the fixed behavior looks like; for a bug, what the old behavior was, so he can tell).
- **What this does and does not prove**: one scenario tried by a human is not regression coverage
  and not CI; list limits (versions, config, data differences).
- **Teardown**: the environment stays up until he gives his verdict to the companion session;
  the verdict decision removes it (`dagrun verify cleanup <run-id>` also does).

### `$DAGRUN_ARTIFACTS/verify-report.json`

Always written, on every path. Valid JSON. Schema (`schemaVersion` is literally `3`):

```json
{
  "schemaVersion": 3,
  "run_id": "<run id>",
  "outcome": "PROVISIONED | BLOCKED_RUNTIME",
  "reason": "<required for BLOCKED_RUNTIME: one or two honest sentences>",
  "capability": "docker-compose | c8run | c8ctl | source",
  "sourceRationale": "<required only when capability is source: why this change has no runtime surface>",
  "toolVersions": { "docker": "...", "java": "..." },
  "target": {
    "kind": "local-disposable",
    "host": "127.0.0.1",
    "port": 18080,
    "ownedResources": [
      { "kind": "container", "name": "dagrun-<run>-camunda" },
      { "kind": "network", "name": "dagrun-<run>-net" },
      { "kind": "image", "name": "dagrun-<run>-camunda:latest" }
    ]
  },
  "candidate": {
    "sourceRevision": "<git rev-parse HEAD>",
    "dirtyFiles": ["<paths from git status --porcelain -uall, [] if committed>"],
    "builtFromWorktree": true,
    "buildCommand": "...",
    "artifact": "<path or image tag>",
    "artifactIdentity": "<sha256 or image digest>"
  },
  "readiness": { "command": "curl -s http://127.0.0.1:18080/actuator/health", "result": "<observed>" },
  "teardown": { "status": "pending" },
  "demoFile": "demo.md"
}
```

- `PROVISIONED` — the candidate, built from this worktree, is running on a loopback disposable
  target and reachable. Needs: non-empty typed `ownedResources` (each name with the
  `dagrun-<run>-` prefix), `target.port`, `readiness`, `builtFromWorktree: true`, a `sourceRevision`
  equal to HEAD, `dirtyFiles` equal to the current porcelain list, an artifact identity,
  `teardown: {"status": "pending"}` and `demo.md`. The engine enforces all of this — a report that
  cannot back its claim FAILS the node.
- **Source-only** (`capability: "source"`): no runtime surface, so nothing provisioned:
  `ownedResources: []`, no `readiness`/`port`, `teardown: {"status": "not-applicable"}`, and a
  `sourceRationale`. `demo.md` then explains what to read/check instead.
- `BLOCKED_RUNTIME` — you could not provision (see Step 5). Say exactly what and why in `reason`.

Only observed results go in `readiness`; never paste another agent's claim. Stock-image-only
environments are `BLOCKED_RUNTIME`, never `PROVISIONED`.

## Step 7 — Reflections (optional, last)

Anything non-obvious (a capability that looked available but wasn't, an env gotcha) →
`$DAGRUN_ARTIFACTS/reflections.md`. Absence is fine.

## Constraints

- Write only to `$DAGRUN_ARTIFACTS/` (and disposable runtime resources you own). No worktree edits,
  no commits, no `git add`, no `formatCommand`, no test authoring.
- Do not extend an approved scope: no production/remote endpoints, no unrelated downloads or image
  pulls, no global config changes.
- Leave the environment RUNNING on success; tear down only on your own failure. Never wait for Eddie.
- Fail loud: if unsure the environment is genuinely reachable, it is not `PROVISIONED`.
