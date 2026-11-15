#!/usr/bin/env node
/**
 * move-home.mjs — ONE-TIME move of the dagrunner home from the old default
 * (~/.local/share/dagrunner) to the new one (~/.local/share/camunda/dagrunner).
 * dagrunner v0.1.85 refuses to run until this has been done (DECISIONS.md §
 * home-under-camunda).
 *
 *   node scripts/move-home.mjs [--dry-run] [--from <dir>] [--to <dir>]
 *
 * What it does, in order — every refusal check runs BEFORE anything is touched:
 *   1. Refuse (exit 1, nothing changed) when: `from` is missing; `to` exists and is
 *      non-empty; `from/worktrees` holds anything (remove legacy worktrees first with
 *      `DAGRUNNER_HOME=<from> dagrun cleanup --all` — the plain command refuses while
 *      the home is un-moved); `from/active.lock` names a LIVE pid (or is corrupt);
 *      `from` and `to` are on different devices (a rename is the only move used).
 *   2. ONE rename of the whole `from` directory to `to` (never copy-then-delete),
 *      then remove the now-empty worktrees/ and a stray .DS_Store.
 *   3. Rewrite the old absolute prefix `<from>/` to `<to>/` inside a fixed list of
 *      machine-written JSON files (state.json, gate.json, ...) — text-level, so the
 *      formatting survives; paths under `<from>/worktrees/` stay as written. Each file
 *      must parse before and after, and is written tmp + rename. A file that does not
 *      parse is skipped and REPORTED, never fatal.
 * Logs, transcripts, markdown, reflections, gate-context.md, report.html and driver.log
 * are history and are never touched (regenerate report.html with `dagrun report`).
 *
 * Node built-ins only, no dependencies. Liveness mirrors src/core/lock.ts: the single
 * global `<home>/active.lock` pid is the only liveness mechanism (isPidAlive below is a
 * copy of lock.ts's, because a plain .mjs cannot import the TypeScript source).
 * The prefix is matched literally — no realpath — because state.json stores the
 * unresolved path the runtime computed.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** JSON files rewritten wherever they appear under the home. */
const REWRITE_BASENAMES = [
  "state.json",
  "gate.json",
  "pr-meta.json",
  "seeded.json",
  "pr-triage-state.json",
  "triage-state.json",
  "known-comments.json",
];
/** Rewritten only at the top of the home. */
const TOP_LEVEL_REWRITE = "config.json";
const TERMINAL_RUN_STATUSES = new Set(["done", "aborted"]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Same semantics as isPidAlive in src/core/lock.ts (EPERM = alive but not ours). */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The JSON-string-escaped form of a path (identical for ordinary paths). */
const jsonEsc = (s) => JSON.stringify(s).slice(1, -1);
const say = (s = "") => process.stdout.write(s + "\n");
/**
 * The only form of a dagrun command that works while the home is still un-moved:
 * the plain command refuses ("the home moved") and points back at this script, which
 * would loop. DAGRUNNER_HOME=<old home> is honoured unchanged by every command.
 */
const shq = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`);
const dagrunWithOldHome = (from, cmd) => `DAGRUNNER_HOME=${shq(from)} dagrun ${cmd}`;

function entriesOf(dir) {
  return readdirSync(dir).filter((n) => n !== ".DS_Store");
}

/** st_dev of the nearest existing ancestor-or-self of `p`. */
function deviceOfNearestExisting(p) {
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return statSync(cur).dev;
}

// ---------------------------------------------------------------------------
// 1. Refusal checks — read-only
// ---------------------------------------------------------------------------

function checkPreconditions(from, to) {
  const refusals = [];
  const notes = [];

  if (!existsSync(from)) {
    // Nothing else can be evaluated; this is also the idempotent re-run outcome.
    refusals.push(
      `the source home does not exist: ${from} (already moved? a second run changes nothing)`,
    );
    return { refusals, notes };
  }
  if (!statSync(from).isDirectory()) {
    refusals.push(`the source home is not a directory: ${from}`);
    return { refusals, notes };
  }
  if (from === to || to.startsWith(from + sep)) {
    refusals.push(
      `the destination ${to} is the source home or inside it: ${from}`,
    );
    return { refusals, notes };
  }

  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) {
      refusals.push(`the destination exists and is not a directory: ${to}`);
    } else {
      const names = readdirSync(to);
      if (names.length > 0) {
        refusals.push(
          `the destination already exists and is not empty: ${to} (contains: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}). ` +
            `If this is only what \`dagrun init\` created, move it aside or remove it, then re-run`,
        );
      }
    }
  }

  const worktrees = join(from, "worktrees");
  if (existsSync(worktrees)) {
    let names;
    try {
      names = entriesOf(worktrees);
    } catch (e) {
      names = [`(unreadable: ${e.message})`];
    }
    if (names.length > 0) {
      refusals.push(
        `${worktrees} still holds ${names.length} entr${names.length === 1 ? "y" : "ies"} (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}): ` +
          `remove the legacy worktrees first with \`${dagrunWithOldHome(from, "cleanup --all")}\` ` +
          `(the plain \`dagrun cleanup --all\` refuses until the home is moved)`,
      );
    }
  }

  const lockFile = join(from, "active.lock");
  if (existsSync(lockFile)) {
    let lock = null;
    try {
      const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
      if (parsed !== null && typeof parsed === "object") lock = parsed;
    } catch {
      /* corrupt */
    }
    if (lock === null) {
      refusals.push(
        `${lockFile} is corrupt or unreadable, so liveness cannot be told: inspect it and remove it manually`,
      );
    } else if (isPidAlive(lock.pid)) {
      refusals.push(
        `run ${lock.runId} is live: ${lockFile} names pid ${lock.pid} (since ${lock.startedAt}), which is running. Wait for it or \`${dagrunWithOldHome(from, `abort ${lock.runId}`)}\` (the plain command refuses until the home is moved), then re-run`,
      );
    } else {
      notes.push(
        `stale lock (not a blocker): ${lockFile} names run ${lock.runId}, pid ${lock.pid} is not running. It moves with the home; \`dagrun preflight\` will report it.`,
      );
    }
  }

  try {
    const a = statSync(from).dev;
    const b = deviceOfNearestExisting(to);
    if (a !== b) {
      refusals.push(
        `${from} and ${to} are on different devices; a rename cannot be used and this script never copies. Move them onto one filesystem first`,
      );
    }
  } catch (e) {
    refusals.push(`cannot compare devices of ${from} and ${to}: ${e.message}`);
  }

  return { refusals, notes };
}

// ---------------------------------------------------------------------------
// 3. Prefix rewrite
// ---------------------------------------------------------------------------

/** All files to consider under `root`: basename list anywhere + top-level config.json. */
function* candidateFiles(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(p);
      else if (
        st.isFile() &&
        (REWRITE_BASENAMES.includes(name) ||
          (dir === root && name === TOP_LEVEL_REWRITE))
      ) {
        yield p;
      }
    }
  }
}

/**
 * Scan (and, unless `dry`, rewrite) the candidate files under `root`.
 * `from`/`to` are the absolute old/new homes whose prefix strings appear in the files.
 */
function rewritePrefix({ root, from, to, dry }) {
  // `<from>/` not glued to a longer path on its left, and not followed by `worktrees`
  // (those worktrees are gone; the old string is the honest history).
  const lead = "(?<![\\w.~-])" + escapeRe(jsonEsc(from)) + "/";
  const replaceRe = new RegExp(lead + "(?!worktrees(?![\\w.-]))", "g");
  const keepRe = new RegExp(lead + "(?=worktrees(?![\\w.-]))", "g");
  const toPrefix = jsonEsc(to) + "/";

  const perBasename = {}; // basename -> { files, replacements }
  const skipped = []; // { file, reason }
  const unfinished = []; // { runId, status }
  let kept = 0;
  const examples = [];

  for (const file of candidateFiles(root)) {
    const rel = relative(root, file);
    const name = basename(file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      skipped.push({ file: rel, reason: `unreadable: ${e.message}` });
      continue;
    }
    let original;
    try {
      original = JSON.parse(text);
    } catch (e) {
      skipped.push({
        file: rel,
        reason: `does not parse as JSON (${e.message})`,
      });
      continue;
    }
    if (
      name === "state.json" &&
      dirname(dirname(file)) === join(root, "runs") &&
      original !== null &&
      typeof original === "object" &&
      typeof original.status === "string" &&
      !TERMINAL_RUN_STATUSES.has(original.status)
    ) {
      unfinished.push({
        runId: basename(dirname(file)),
        status: original.status,
      });
    }

    kept += (text.match(keepRe) ?? []).length;
    const count = (text.match(replaceRe) ?? []).length;
    if (count === 0) continue;
    const next = text.replace(replaceRe, () => toPrefix);
    try {
      JSON.parse(next);
    } catch (e) {
      skipped.push({
        file: rel,
        reason: `would not parse after the rewrite (${e.message}); left untouched`,
      });
      continue;
    }

    if (!dry) {
      const tmp = join(dirname(file), `.${name}.move-home-${process.pid}.tmp`);
      try {
        writeFileSync(tmp, next, {
          encoding: "utf8",
          mode: lstatSync(file).mode & 0o7777,
        });
        renameSync(tmp, file);
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          /* no tmp to clean */
        }
        skipped.push({
          file: rel,
          reason: `write failed: ${e.message}; left untouched`,
        });
        continue;
      }
    }

    const key = dirname(file) === root ? `${name} (top level)` : name;
    const slot = (perBasename[key] ??= { files: 0, replacements: 0 });
    slot.files += 1;
    slot.replacements += count;
    if (examples.length < 3 && !examples.some((e) => e.name === key)) {
      // Shown with the long prefixes elided so the interesting part of the line survives.
      const line = text.split("\n").find((l) => l.match(replaceRe)) ?? "";
      examples.push({
        name: key,
        file: rel,
        before: line
          .replace(replaceRe, () => "<from>/")
          .trim()
          .slice(0, 150),
        after: line
          .replace(replaceRe, () => "<to>/")
          .trim()
          .slice(0, 150),
      });
    }
  }
  return { perBasename, skipped, unfinished, kept, examples };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportRewrite(r, { dry, from, to }) {
  const verb = dry ? "Would rewrite" : "Rewrote";
  const names = Object.keys(r.perBasename).sort();
  say(`${verb} the old prefix ${from}/ -> ${to}/ in:`);
  if (names.length === 0) say("  (no file needed it)");
  for (const n of names) {
    const s = r.perBasename[n];
    say(
      `  ${n.padEnd(34)} ${String(s.files).padStart(4)} file(s), ${String(s.replacements).padStart(5)} replacement(s)`,
    );
  }
  for (const e of r.examples) {
    say(`  e.g. ${e.file}`);
    say(`    - ${e.before}`);
    say(`    + ${e.after}`);
  }
  say(
    `${dry ? "Would leave" : "Left"} ${r.kept} occurrence(s) under ${from}/worktrees/ as written (those worktrees are gone; the old string is the honest history).`,
  );
  if (r.skipped.length > 0) {
    say(
      `${dry ? "Would skip" : "SKIPPED"} ${r.skipped.length} file(s) (reported, not fatal; fix by hand):`,
    );
    for (const s of r.skipped) say(`  ${s.file}: ${s.reason}`);
  } else {
    say("Skipped: none.");
  }
  say(
    "Not touched (history, not rewritten): logs, transcripts, markdown, reflections, gate-context.md, report.html, driver.log. Regenerate report.html with `dagrun report`.",
  );
  if (r.unfinished.length > 0) {
    say("");
    say(
      `NOTE: ${r.unfinished.length} run(s) are not finished: ${r.unfinished.map((u) => `${u.runId} (${u.status})`).join(", ")}.`,
    );
    say(
      "  Their worktrees were seeded with the OLD home (.claude/settings.json additionalDirectories, hooks/deny-guard.sh). " +
        "`dagrun resume` / gate approve do NOT re-seed those; `dagrun rerun <run> <node>` does. Finish or abort such runs before relying on them, or rerun a node to re-seed.",
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dry: false, from: undefined, to: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dry = true;
    else if (a === "--from" || a === "--to") {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--"))
        throw new Error(`${a} needs a directory`);
      out[a === "--from" ? "from" : "to"] = v;
    } else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  return out;
}

const USAGE =
  "usage: node scripts/move-home.mjs [--dry-run] [--from <dir>] [--to <dir>]";

function main(argv) {
  const t0 = Date.now();
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`move-home: ${e.message}\n${USAGE}\n`);
    return 1;
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  const from = resolve(
    args.from ?? join(homedir(), ".local", "share", "dagrunner"),
  );
  const to = resolve(
    args.to ?? join(homedir(), ".local", "share", "camunda", "dagrunner"),
  );

  const { refusals, notes } = checkPreconditions(from, to);
  if (refusals.length > 0) {
    process.stderr.write(
      `move-home: REFUSED${args.dry ? " (dry run)" : ""} - nothing was changed.\n`,
    );
    for (const r of refusals) process.stderr.write(`  - ${r}\n`);
    return 1;
  }

  say(`move-home${args.dry ? " (DRY RUN - nothing will be changed)" : ""}`);
  say(`  from: ${from}`);
  say(`  to:   ${to}`);
  for (const n of notes) say(`  ${n}`);

  if (args.dry) {
    say(
      `Would move: one rename of ${from} -> ${to} (same device), then remove the empty worktrees/ and a stray .DS_Store.`,
    );
    reportRewrite(rewritePrefix({ root: from, from, to, dry: true }), {
      dry: true,
      from,
      to,
    });
    say(
      `\nDry run done in ${Date.now() - t0} ms. Run without --dry-run to apply.`,
    );
    return 0;
  }

  // The only mutations: mkdir of the parent, then ONE rename. Either can fail with the
  // source still intact; nothing has been copied or deleted before that point.
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (e) {
    process.stderr.write(
      `move-home: FAILED - ${e.message}\n  The source home is untouched.\n`,
    );
    return 1;
  }
  say(`Moved: ${from} -> ${to}`);

  for (const stray of [
    join(to, "worktrees", ".DS_Store"),
    join(to, ".DS_Store"),
  ]) {
    try {
      if (existsSync(stray)) unlinkSync(stray);
    } catch (e) {
      say(`  warning: could not remove ${stray}: ${e.message}`);
    }
  }
  try {
    if (existsSync(join(to, "worktrees"))) rmdirSync(join(to, "worktrees"));
  } catch (e) {
    say(`  warning: could not remove the empty worktrees/ dir: ${e.message}`);
  }

  reportRewrite(rewritePrefix({ root: to, from, to, dry: false }), {
    dry: false,
    from,
    to,
  });

  say(`\nDone in ${Date.now() - t0} ms. Next:`);
  say(
    "  1. Update the tmux artifact picker roots (outside this repo) to search ~/.local/share/camunda only.",
  );
  say(
    "  2. Update skill references that still name ~/.local/share/dagrunner (e.g. under ~/.claude/skills).",
  );
  say("  3. Check it: dagrun list");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
