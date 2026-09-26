/**
 * verify-cleanup.ts — deterministic teardown of a verify node's provisioned
 * environment, run AFTER the human's verdict (never by the node itself).
 *
 * The verify node leaves containers/network/image running for manual testing and
 * records them durably in `verify-report.json` (`target.ownedResources`). This
 * module is the only thing that removes them. It is safe by construction:
 *  - it removes ONLY resources that are named in the report AND carry the
 *    `dagrun-<run-id>-` prefix for THIS run (engine's run id, not the report's
 *    self-report); anything else is refused and reported, never touched;
 *  - it VERIFIES removal with `docker ps -a / network ls / image ls / volume ls`
 *    rather than trusting the rm exit codes;
 *  - it re-checks `git status --porcelain -uall` against the recorded
 *    `dirtyFiles` (the worktree must be untouched by the testing);
 *  - it writes `teardown.json` next to the report (the report itself is never
 *    rewritten) and is idempotent — re-running on a clean env is a success.
 * docker is reached only through an injectable `exec` (child_process execFile in
 * production), so tests never need a real docker.
 *
 * Reads schemaVersion 3 (typed ownedResources) and the legacy schemaVersion 2
 * (free-text strings, e.g. "dagrun-<run>-camunda (image, removed after demo)")
 * so runs produced before the hand-off change stay cleanable.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  gitDirtyPaths,
  normalizeDirty,
  ownershipPrefix,
  RESOURCE_KINDS,
  type ResourceKind,
} from "./verify-evidence.js";

export type DockerExec = (args: string[]) => {
  status: number;
  stdout: string;
  stderr: string;
};

/** Production docker seam: execFile-style spawn, no shell, no docker library. */
export const realDockerExec: DockerExec = (args) => {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error !== undefined)
    return { status: 127, stdout: "", stderr: r.error.message };
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export type OwnedResource = { kind: ResourceKind | "unknown"; name: string };

export type TeardownFile = {
  status: "clean" | "leftovers";
  leftovers: string[];
  at: string;
  trigger: string;
  removed: string[];
  worktree: { status: "match" | "drift" | "unchecked"; detail?: string };
};

export type VerifyEnv = {
  /** The artifact dir holding the report: `verify/` or `verify-attempts/attempt-N/`. */
  dir: string;
  current: boolean;
  schemaVersion: number;
  outcome: string;
  capability: string;
  resources: OwnedResource[];
  /** Entries that could not be parsed at all (reported as leftovers, never guessed). */
  malformed: string[];
  dirtyFiles: string[];
  host: string;
  port: number | null;
  demoFile: string;
  teardown: TeardownFile | null;
  /** Provisioned resources exist and no successful teardown is recorded. */
  pending: boolean;
};

const REPORT = "verify-report.json";
const TEARDOWN = "teardown.json";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/;

function parseResources(raw: unknown): {
  resources: OwnedResource[];
  malformed: string[];
} {
  const resources: OwnedResource[] = [];
  const malformed: string[] = [];
  if (!Array.isArray(raw)) return { resources, malformed };
  for (const r of raw) {
    if (typeof r === "string") {
      // v2 free text: the first whitespace token is the name; the kind is unknown.
      const name = r.trim().split(/\s+/)[0] ?? "";
      if (name === "") malformed.push(JSON.stringify(r));
      else resources.push({ kind: "unknown", name });
    } else if (
      typeof r === "object" &&
      r !== null &&
      (RESOURCE_KINDS as readonly unknown[]).includes(
        (r as Record<string, unknown>)["kind"],
      ) &&
      typeof (r as Record<string, unknown>)["name"] === "string" &&
      ((r as Record<string, unknown>)["name"] as string).trim() !== ""
    ) {
      const o = r as { kind: ResourceKind; name: string };
      resources.push({ kind: o.kind, name: o.name.trim() });
    } else {
      malformed.push(JSON.stringify(r));
    }
  }
  return { resources, malformed };
}

function readTeardown(dir: string): TeardownFile | null {
  try {
    return JSON.parse(
      readFileSync(join(dir, TEARDOWN), "utf8"),
    ) as TeardownFile;
  } catch {
    return null;
  }
}

/** Read one artifact dir's report; null when there is no readable report. */
export function readVerifyEnv(dir: string, current: boolean): VerifyEnv | null {
  const file = join(dir, REPORT);
  if (!existsSync(file)) return null;
  let rep: Record<string, unknown>;
  try {
    rep = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const target = (rep["target"] ?? {}) as Record<string, unknown>;
  const cand = (rep["candidate"] ?? {}) as Record<string, unknown>;
  const { resources, malformed } = parseResources(target["ownedResources"]);
  const teardown = readTeardown(dir);
  const schemaVersion =
    typeof rep["schemaVersion"] === "number" ? rep["schemaVersion"] : 0;
  // A v2 report predates the hand-off: the node cleaned up itself and said so. Only a
  // v2 report that admitted leftovers still needs a teardown.
  const v2Clean =
    schemaVersion === 2 &&
    ((rep["cleanup"] ?? {}) as Record<string, unknown>)["status"] === "clean";
  const hasWork = resources.length > 0 || malformed.length > 0;
  const tornDown = teardown?.status === "clean";
  return {
    dir,
    current,
    schemaVersion,
    outcome: String(rep["outcome"] ?? ""),
    capability: String(rep["capability"] ?? ""),
    resources,
    malformed,
    dirtyFiles: Array.isArray(cand["dirtyFiles"])
      ? (cand["dirtyFiles"] as string[])
      : [],
    host: String(target["host"] ?? ""),
    port: typeof target["port"] === "number" ? target["port"] : null,
    demoFile: String(rep["demoFile"] ?? "demo.md"),
    teardown,
    pending: hasWork && !tornDown && !(v2Clean && teardown === null),
  };
}

/** Every verify artifact dir of a run that holds a report: current first, then archived attempts. */
export function findVerifyEnvs(runDir: string): VerifyEnv[] {
  const out: VerifyEnv[] = [];
  const cur = readVerifyEnv(join(runDir, "verify"), true);
  if (cur !== null) out.push(cur);
  const attempts = join(runDir, "verify-attempts");
  if (existsSync(attempts)) {
    for (const d of readdirSync(attempts)
      .filter((f) => /^attempt-\d+$/.test(f))
      .sort()) {
      const e = readVerifyEnv(join(attempts, d), false);
      if (e !== null) out.push(e);
    }
  }
  return out;
}

export const pendingVerifyEnvs = (runDir: string): VerifyEnv[] =>
  findVerifyEnvs(runDir).filter((e) => e.pending);

// ---------------------------------------------------------------------------

type Listing = { ok: boolean; names: string[] };

function list(exec: DockerExec, args: string[]): Listing {
  const r = exec(args);
  if (r.status !== 0) return { ok: false, names: [] };
  return {
    ok: true,
    names: r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  };
}

/** Names of `kind` still present in docker (exact match on the recorded name). */
function present(
  exec: DockerExec,
  kind: Exclude<ResourceKind, "tempdir"> | "unknown",
  name: string,
): { ok: boolean; found: string[] } {
  const kinds: Array<Exclude<ResourceKind, "tempdir">> =
    kind === "unknown" ? ["container", "network", "image", "volume"] : [kind];
  let ok = true;
  const found: string[] = [];
  for (const k of kinds) {
    let l: Listing;
    if (k === "container")
      l = list(exec, [
        "ps",
        "-a",
        "--filter",
        `name=${name}`,
        "--format",
        "{{.Names}}",
      ]);
    else if (k === "network")
      l = list(exec, [
        "network",
        "ls",
        "--filter",
        `name=${name}`,
        "--format",
        "{{.Name}}",
      ]);
    else if (k === "volume")
      l = list(exec, [
        "volume",
        "ls",
        "--filter",
        `name=${name}`,
        "--format",
        "{{.Name}}",
      ]);
    else
      l = list(exec, [
        "image",
        "ls",
        "--filter",
        `reference=${name}`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
    if (!l.ok) ok = false;
    for (const n of l.names) {
      const matches =
        k === "image" ? n === name || (!name.includes(":") && n.startsWith(name + ":")) : n === name;
      if (matches) found.push(`${k}:${n}`);
    }
  }
  return { ok, found };
}

function removeOne(exec: DockerExec, r: OwnedResource): void {
  const kinds: string[] =
    r.kind === "unknown"
      ? ["container", "network", "volume", "image"]
      : [r.kind];
  for (const k of kinds) {
    if (k === "container") exec(["rm", "-f", "-v", r.name]);
    else if (k === "network") exec(["network", "rm", r.name]);
    else if (k === "volume") exec(["volume", "rm", "-f", r.name]);
    else if (k === "image") exec(["image", "rm", "-f", r.name]);
  }
}

/** Order matters: containers first (they pin networks/images/volumes). */
const ORDER: Record<string, number> = {
  container: 0,
  unknown: 0,
  network: 1,
  volume: 2,
  image: 3,
  tempdir: 4,
};

export type TeardownReport = {
  dir: string;
  file: TeardownFile;
  /** true only when every resource is gone AND the worktree matches (or was not checked). */
  ok: boolean;
};

/** Tear down one verify env dir. Never throws for docker problems: they become leftovers. */
export function teardownEnv(args: {
  env: VerifyEnv;
  runId: string;
  worktreePath: string;
  trigger: string;
  exec?: DockerExec;
  now?: () => string;
}): TeardownReport {
  const { env, runId, worktreePath, trigger } = args;
  const exec = args.exec ?? realDockerExec;
  const prefix = ownershipPrefix(runId);
  const leftovers: string[] = env.malformed.map(
    (m) => `unparseable ownedResources entry ${m} — refused`,
  );
  const removed: string[] = [];
  const owned: OwnedResource[] = [];

  for (const r of env.resources) {
    const isDir = r.kind === "tempdir";
    const leaf = isDir ? basename(r.name) : r.name;
    if (!leaf.startsWith(prefix)) {
      leftovers.push(
        `${r.kind}:${r.name} — REFUSED: does not carry ownership prefix "${prefix}"`,
      );
    } else if (isDir) {
      const abs = resolve(r.name);
      const wt = resolve(worktreePath);
      if (
        !isAbsolute(r.name) ||
        abs === wt ||
        abs.startsWith(wt + sep) ||
        dirname(abs) === abs
      ) {
        leftovers.push(
          `tempdir:${r.name} — REFUSED: must be an absolute path outside the worktree`,
        );
      } else owned.push(r);
    } else if (!SAFE_NAME.test(r.name)) {
      leftovers.push(
        `${r.kind}:${r.name} — REFUSED: not a plain docker resource name`,
      );
    } else owned.push(r);
  }
  owned.sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));

  for (const r of owned) {
    if (r.kind === "tempdir") {
      rmSync(r.name, { recursive: true, force: true });
      if (existsSync(r.name)) leftovers.push(`tempdir:${r.name}`);
      else removed.push(`tempdir:${r.name}`);
      continue;
    }
    removeOne(exec, r);
    const p = present(exec, r.kind, r.name);
    if (!p.ok)
      leftovers.push(
        `${r.kind}:${r.name} — could not verify removal (docker unreachable or query failed)`,
      );
    else if (p.found.length > 0) leftovers.push(...p.found);
    else removed.push(`${r.kind}:${r.name}`);
  }

  // The manual testing must not have changed the worktree: same check the node
  // was held to at provision time. Archived attempts predate later fix edits, so
  // drift is only meaningful for the current verify dir.
  let worktree: TeardownFile["worktree"] = { status: "unchecked" };
  if (env.current) {
    const live = gitDirtyPaths(worktreePath);
    if (live === null)
      worktree = {
        status: "unchecked",
        detail: "worktree is not a git checkout",
      };
    else {
      const want = normalizeDirty(env.dirtyFiles);
      if (JSON.stringify(want) === JSON.stringify(live))
        worktree = { status: "match" };
      else {
        const unreported = live.filter((p) => !want.includes(p));
        const gone = want.filter((p) => !live.includes(p));
        worktree = {
          status: "drift",
          detail: `git status --porcelain -uall no longer equals the recorded dirtyFiles (new: ${JSON.stringify(unreported)}, no longer dirty: ${JSON.stringify(gone)})`,
        };
      }
    }
  }

  const file: TeardownFile = {
    status: leftovers.length === 0 ? "clean" : "leftovers",
    leftovers,
    at: (args.now ?? (() => new Date().toISOString()))(),
    trigger,
    removed,
    worktree,
  };
  writeFileSync(join(env.dir, TEARDOWN), JSON.stringify(file, null, 2), "utf8");
  return {
    dir: env.dir,
    file,
    ok: file.status === "clean" && worktree.status !== "drift",
  };
}

/**
 * Tear down every pending env of a run (current + archived attempts). When
 * `all` is set, envs already recorded clean are re-verified too (the explicit
 * `dagrun verify cleanup` path — idempotent, and it re-checks the worktree).
 */
export function teardownRun(args: {
  runDir: string;
  runId: string;
  worktreePath: string;
  trigger: string;
  exec?: DockerExec;
  all?: boolean;
}): { reports: TeardownReport[]; ok: boolean } {
  const envs = findVerifyEnvs(args.runDir).filter(
    (e) =>
      (e.resources.length > 0 || e.malformed.length > 0) &&
      (args.all === true || e.pending),
  );
  const reports = envs.map((env) =>
    teardownEnv({
      env,
      runId: args.runId,
      worktreePath: args.worktreePath,
      trigger: args.trigger,
      ...(args.exec !== undefined ? { exec: args.exec } : {}),
    }),
  );
  return { reports, ok: reports.every((r) => r.ok) };
}

export function formatTeardown(reports: TeardownReport[]): string {
  if (reports.length === 0)
    return "no provisioned verify environment to tear down\n";
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(
      `verify teardown ${r.file.status.toUpperCase()} (${r.dir}): removed ${r.file.removed.length}, leftovers ${r.file.leftovers.length}; worktree ${r.file.worktree.status}`,
    );
    for (const l of r.file.leftovers) lines.push(`  LEFTOVER ${l}`);
    if (r.file.worktree.status === "drift")
      lines.push(`  WORKTREE DRIFT ${r.file.worktree.detail ?? ""}`);
  }
  return lines.join("\n") + "\n";
}
