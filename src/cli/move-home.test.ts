/**
 * move-home.test.ts — scripts/move-home.mjs, the one-time move of the dagrunner
 * home to ~/.local/share/camunda/dagrunner. Black-box: the real script is spawned
 * against mkdtemp fixtures (explicit --from/--to, or a fake HOME for the defaults).
 * Nothing here ever touches a real home. Fixture path strings are built from the
 * exact --from passed to the script (the script never realpaths).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { listRuns } from "../runtime/run-engine.js";
import { buildStatusJson } from "./status-json.js";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/move-home.mjs", import.meta.url),
);

type Run = { status: number | null; stdout: string; stderr: string };

function runScript(args: string[], fakeHome?: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["DAGRUNNER_HOME"];
  if (fakeHome !== undefined) env["HOME"] = fakeHome;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every path under `root` -> file content (or "<dir>"); used to prove "nothing changed". */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (lstatSync(p).isDirectory()) {
        out[rel] = "<dir>";
        walk(p);
      } else out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

const j = (v: unknown): string => JSON.stringify(v, null, 2);

type Fx = { base: string; from: string; to: string };

function state(from: string, id: string, status: string): string {
  return j({
    runId: id,
    workflow: "bugfix",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    status,
    worktreePath: `${from}/worktrees/${id}`,
    branch: "b",
    sourcePlanPath: `${from}/inbox/${id}.md`,
    nodes: {
      implement: {
        status: "done",
        artifacts: [`${from}/runs/${id}/implement/summary.md`],
        iteration: 1,
        cost: 0.1,
        gateHistory: [],
      },
    },
    // boundary cases: neither of these is the home prefix, so neither may change
    lookalike: `${from}-other/runs/x`,
    glued: `/mnt${from}/runs/x`,
  });
}

/** A realistic old home. `from` and `to` share a parent so a rename is possible. */
function buildFixture(): Fx {
  const base = mkdtempSync(join(tmpdir(), "dr-mh-"));
  const from = join(base, "share", "dagrunner");
  const to = join(base, "share", "camunda", "dagrunner");
  const w = (rel: string, content: string): void => {
    mkdirSync(join(from, rel, ".."), { recursive: true });
    writeFileSync(join(from, rel), content, "utf8");
  };
  w("config.json", j({ DEVHARNESS_SRC: "/some/src", note: `${from}/store` }));
  for (const [id, status] of [
    ["r-done", "done"],
    ["r-paused", "paused"],
  ] as const) {
    w(`runs/${id}/state.json`, state(from, id, status));
    w(
      `runs/${id}/implement/summary.md`,
      `see ${from}/runs/${id}/implement/x\n`,
    );
    w(
      `runs/${id}/implement/transcript.log`,
      `wrote ${from}/runs/${id}/implement/summary.md\n`,
    );
    w(`runs/${id}/driver.log`, `home ${from}/\n`);
    w(
      `runs/${id}/review/gate.json`,
      j({ files: [{ path: `${from}/runs/${id}/review/findings.json` }] }),
    );
    w(`runs/${id}/report.html`, `<a href="file://${from}/runs/${id}">run</a>`);
    w(`runs/${id}/gate-context.md`, `${from}/runs/${id}\n`);
  }
  w(
    "runs/r-done/pr/pr-meta.json",
    j({ body: `${from}/runs/r-done/pr/body.md` }),
  );
  w(
    "runs/r-done/seed-data/seeded.json",
    j({ spec: `${from}/runs/r-done/seed-data/spec.json` }),
  );
  w(
    "runs/r-done/pr-triage/pr-triage-state.json",
    j({ artifacts: `${from}/runs/r-done/pr-triage` }),
  );
  w(
    "runs/r-done/pr-triage/triage-state.json",
    j({ dir: `${from}/runs/r-done/pr-triage` }),
  );
  w(
    "runs/r-done/pr-triage/known-comments.json",
    j([`${from}/runs/r-done/pr-triage/c1`]),
  );
  // not on the list: a nested config.json and a reflection log are never rewritten
  w("runs/r-done/config.json", j({ nested: `${from}/runs/r-done` }));
  w("store/reflection-log.jsonl", `{"cwd":"${from}/runs/r-done"}\n`);
  w("inbox/r-done.md", "# plan\n");
  w("ui-mockup-recovered/index.html", `<p>${from}/ui</p>`);
  mkdirSync(join(from, "worktrees"), { recursive: true });
  return { base, from, to };
}

const args = (fx: Fx, ...extra: string[]): string[] => [
  "--from",
  fx.from,
  "--to",
  fx.to,
  ...extra,
];

test("success: ONE rename, prefix rewritten in the listed JSON only, worktrees/ paths and history untouched", () => {
  const fx = buildFixture();
  writeFileSync(join(fx.from, ".DS_Store"), "x");
  const before = snapshot(fx.from);
  const r = runScript(args(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);

  assert.equal(
    existsSync(fx.from),
    false,
    "source home must be gone (renamed)",
  );
  assert.equal(
    existsSync(join(fx.to, "worktrees")),
    false,
    "empty worktrees/ removed",
  );
  assert.equal(
    existsSync(join(fx.to, ".DS_Store")),
    false,
    "stray .DS_Store removed",
  );

  const after = snapshot(fx.to);
  const rewritten = (rel: string): string =>
    before[rel]!.replaceAll(`${fx.from}/runs`, `${fx.to}/runs`);

  // state.json: runs/ + inbox/ paths change, worktrees/ path stays as written, lookalikes stay
  const st = JSON.parse(after["runs/r-done/state.json"]!) as Record<
    string,
    unknown
  > & {
    worktreePath: string;
    sourcePlanPath: string;
    nodes: { implement: { artifacts: string[] } };
  };
  assert.equal(st.worktreePath, `${fx.from}/worktrees/r-done`);
  assert.equal(st.sourcePlanPath, `${fx.to}/inbox/r-done.md`);
  assert.deepEqual(st.nodes.implement.artifacts, [
    `${fx.to}/runs/r-done/implement/summary.md`,
  ]);
  assert.equal(st["lookalike"], `${fx.from}-other/runs/x`);
  assert.equal(st["glued"], `/mnt${fx.from}/runs/x`);

  // formatting survives (text-level rewrite): other listed files differ ONLY by the prefix
  for (const rel of [
    "runs/r-done/review/gate.json",
    "runs/r-done/pr/pr-meta.json",
    "runs/r-done/seed-data/seeded.json",
    "runs/r-done/pr-triage/pr-triage-state.json",
    "runs/r-done/pr-triage/triage-state.json",
    "runs/r-done/pr-triage/known-comments.json",
  ]) {
    assert.equal(after[rel], rewritten(rel), rel);
    assert.ok(after[rel]!.includes(fx.to), rel);
    assert.ok(!after[rel]!.includes(fx.from), rel);
  }
  assert.ok(
    JSON.parse(after["config.json"]!).note === `${fx.to}/store`,
    "top-level config.json rewritten",
  );

  // history and everything off-list is byte-for-byte untouched
  for (const rel of [
    "runs/r-done/implement/transcript.log",
    "runs/r-done/driver.log",
    "runs/r-done/report.html",
    "runs/r-done/gate-context.md",
    "runs/r-done/implement/summary.md",
    "runs/r-done/config.json",
    "store/reflection-log.jsonl",
    "inbox/r-done.md",
    "ui-mockup-recovered/index.html",
  ]) {
    assert.equal(after[rel], before[rel], rel);
  }

  // summary: moved line, per-basename counts, skipped, history note, the three follow-ups
  assert.match(r.stdout, new RegExp(`Moved: ${fx.from} -> ${fx.to}`));
  for (const n of [
    "state.json",
    "gate.json",
    "pr-meta.json",
    "seeded.json",
    "known-comments.json",
  ]) {
    assert.ok(r.stdout.includes(n), `${n} in summary: ${r.stdout}`);
  }
  assert.match(r.stdout, /Skipped: none/);
  assert.match(r.stdout, /Not touched \(history/);
  assert.match(r.stdout, /picker roots|artifact picker/);
  assert.match(r.stdout, /skill references/);
  assert.match(r.stdout, /dagrun list/);
  assert.match(r.stdout, /Done in \d+ ms/);
  // r-paused is unfinished: the re-seed caveat is surfaced
  assert.match(r.stdout, /r-paused \(paused\)/);
  assert.doesNotMatch(r.stdout, /r-done \(done\)/);
});

test("dry-run: prints what would move/rewrite (counts + example) and changes nothing", () => {
  const fx = buildFixture();
  const before = snapshot(fx.from);
  const r = runScript(args(fx, "--dry-run"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(fx.from), before);
  assert.equal(existsSync(fx.to), false);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /Would move/);
  assert.match(r.stdout, /Would rewrite/);
  assert.match(r.stdout, /state\.json\s+2 file\(s\),\s+\d+ replacement\(s\)/);
  assert.match(r.stdout, /e\.g\. /);
  assert.match(r.stdout, /Would leave 2 occurrence\(s\) under .*\/worktrees\//);
});

test("refuses when the destination exists and is not empty (nothing changed)", () => {
  const fx = buildFixture();
  mkdirSync(fx.to, { recursive: true });
  writeFileSync(join(fx.to, "config.json"), "{}");
  const before = snapshot(fx.from);
  const r = runScript(args(fx));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /already exists and is not empty/);
  assert.deepEqual(snapshot(fx.from), before);
  assert.deepEqual(readdirSync(fx.to), ["config.json"]);
});

test("refuses when worktrees/ is not empty and names the cleanup command that WORKS while the home is un-moved", () => {
  const fx = buildFixture();
  mkdirSync(join(fx.from, "worktrees", "r-old"), { recursive: true });
  const before = snapshot(fx.from);
  const r = runScript(args(fx));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worktrees/);
  // the plain `dagrun cleanup --all` refuses ("home moved") until the move -> the only usable form pins the old home
  assert.ok(r.stderr.includes(`DAGRUNNER_HOME=${fx.from} dagrun cleanup --all`), r.stderr);
  assert.match(r.stderr, /plain .*refuses until the home is moved/);
  assert.match(r.stderr, /r-old/);
  assert.deepEqual(snapshot(fx.from), before);
  assert.equal(existsSync(fx.to), false);
});

test("a worktrees/ holding only a Finder .DS_Store is empty for this purpose", () => {
  const fx = buildFixture();
  writeFileSync(join(fx.from, "worktrees", ".DS_Store"), "x");
  const r = runScript(args(fx));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(fx.to, "worktrees")), false);
});

test("refuses when the source home does not exist", () => {
  const base = mkdtempSync(join(tmpdir(), "dr-mh-"));
  const r = runScript([
    "--from",
    join(base, "nope"),
    "--to",
    join(base, "camunda", "dagrunner"),
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
  assert.equal(existsSync(join(base, "camunda")), false);
});

test("refuses while active.lock names a LIVE pid (nothing changed)", () => {
  const fx = buildFixture();
  writeFileSync(
    join(fx.from, "active.lock"),
    j({
      runId: "r-paused",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const before = snapshot(fx.from);
  const r = runScript(args(fx));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /r-paused is live/);
  assert.ok(r.stderr.includes(`DAGRUNNER_HOME=${fx.from} dagrun abort r-paused`), r.stderr);
  assert.match(r.stderr, new RegExp(`pid ${process.pid}`));
  assert.deepEqual(snapshot(fx.from), before);
  assert.equal(existsSync(fx.to), false);
});

test("a STALE lock (dead pid) is not a blocker but is reported", () => {
  const fx = buildFixture();
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  writeFileSync(
    join(fx.from, "active.lock"),
    j({ runId: "r-paused", pid: dead, startedAt: "2026-01-01T00:00:00.000Z" }),
  );
  const r = runScript(args(fx));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stale lock \(not a blocker\)/);
  assert.match(r.stdout, /r-paused/);
  assert.ok(
    existsSync(join(fx.to, "active.lock")),
    "the stale lock moves with the home",
  );
});

test("a corrupt active.lock is refused (liveness cannot be told)", () => {
  const fx = buildFixture();
  writeFileSync(join(fx.from, "active.lock"), "{not json");
  const r = runScript(args(fx));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /corrupt or unreadable/);
  assert.equal(existsSync(fx.to), false);
});

test("refuses when destination is on another device (rename impossible); nothing is created", () => {
  const fx = buildFixture();
  const otherDev = "/dev";
  if (
    !existsSync(otherDev) ||
    lstatSync(otherDev).dev === lstatSync(fx.from).dev
  )
    return; // no second device here
  const to = join(otherDev, `dr-mh-${process.pid}`, "dagrunner");
  const r = runScript(["--from", fx.from, "--to", to]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /different devices/);
  assert.equal(existsSync(join(otherDev, `dr-mh-${process.pid}`)), false);
  assert.ok(existsSync(fx.from));
});

test("refuses a destination inside the source", () => {
  const fx = buildFixture();
  const r = runScript([
    "--from",
    fx.from,
    "--to",
    join(fx.from, "sub", "dagrunner"),
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside it/);
});

test("an unparseable JSON file is skipped and reported; every other file is still rewritten", () => {
  const fx = buildFixture();
  const bad = `{ "worktreePath": "${fx.from}/runs/r-paused", broken`;
  writeFileSync(join(fx.from, "runs", "r-paused", "state.json"), bad);
  const r = runScript(args(fx));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SKIPPED 1 file\(s\)/);
  assert.match(r.stdout, /runs\/r-paused\/state\.json: does not parse as JSON/);
  assert.equal(
    readFileSync(join(fx.to, "runs", "r-paused", "state.json"), "utf8"),
    bad,
  );
  const good = JSON.parse(
    readFileSync(join(fx.to, "runs", "r-done", "state.json"), "utf8"),
  ) as { sourcePlanPath: string };
  assert.equal(good.sourcePlanPath, `${fx.to}/inbox/r-done.md`);
});

test("idempotent: a second run refuses at 'source does not exist' and changes nothing", () => {
  const fx = buildFixture();
  assert.equal(runScript(args(fx)).status, 0);
  const moved = snapshot(fx.to);
  const again = runScript(args(fx));
  assert.equal(again.status, 1);
  assert.match(again.stderr, /source home does not exist/);
  assert.deepEqual(snapshot(fx.to), moved);
});

test("an existing EMPTY destination dir is fine (rename onto an empty dir)", () => {
  const fx = buildFixture();
  mkdirSync(fx.to, { recursive: true });
  const r = runScript(args(fx));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(fx.to, "runs", "r-done", "state.json")));
});

test("defaults: with no flags it moves $HOME/.local/share/dagrunner to $HOME/.local/share/camunda/dagrunner", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "dr-mh-home-"));
  const from = join(fakeHome, ".local", "share", "dagrunner");
  mkdirSync(join(from, "runs", "r1"), { recursive: true });
  writeFileSync(
    join(from, "runs", "r1", "state.json"),
    state(from, "r1", "done"),
  );
  const r = runScript([], fakeHome);
  assert.equal(r.status, 0, r.stderr);
  const to = join(fakeHome, ".local", "share", "camunda", "dagrunner");
  assert.equal(existsSync(from), false);
  assert.ok(
    (
      JSON.parse(
        readFileSync(join(to, "runs", "r1", "state.json"), "utf8"),
      ) as { sourcePlanPath: string }
    ).sourcePlanPath.startsWith(to),
  );
});

test("post-move: the readers behind `dagrun list` / `dagrun status --json` work against the new home", () => {
  const fx = buildFixture();
  assert.equal(runScript(args(fx)).status, 0);
  const runs = listRuns(fx.to);
  assert.deepEqual(runs.map((r) => r.runId).sort(), ["r-done", "r-paused"]);
  const s = buildStatusJson(fx.to, "r-done");
  assert.equal(s.status, "done");
  assert.deepEqual(
    s.nodes["implement"]?.artifacts.map((a) => a.path),
    [`${fx.to}/runs/r-done/implement/summary.md`],
  );
});
