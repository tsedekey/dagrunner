// Live smoke: review node on Copilot, throwaway repo/worktree, temporary runtime override ONLY.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bugfixWorkflow } from "/Users/eddie.tsedeke/dev/dagrunner/src/workflow/bugfix-workflow.ts";
import { makeDefaultExecutorFactory } from "/Users/eddie.tsedeke/dev/dagrunner/src/runtime/runtime-router.ts";
import { seedWorktreeSkills } from "/Users/eddie.tsedeke/dev/dagrunner/src/runtime/run-engine.ts";
import { validateFindings } from "/Users/eddie.tsedeke/dev/dagrunner/src/core/findings-schema.ts";
import { loadWorkflow } from "/Users/eddie.tsedeke/dev/dagrunner/src/workflow/workflow.ts";

const REPO = "/Users/eddie.tsedeke/dev/dagrunner";
const sh = (c: string, cwd: string) => execSync(c, { cwd, stdio: "pipe", encoding: "utf8" });

const root = mkdtempSync(join(tmpdir(), "copilot-smoke-"));
const origin = join(root, "origin.git");
const wt = join(root, "wt");
sh(`git init -q --bare "${origin}"`, root);
sh(`git clone -q "${origin}" "${wt}"`, root);
sh(`git config user.email t@t && git config user.name t && git checkout -q -b main`, wt);
mkdirSync(join(wt, "src"), { recursive: true });
writeFileSync(join(wt, "src/config.ts"), "export const PAGE_LIMIT = 100;\nexport function clamp(n: number): number {\n  return Math.min(n, PAGE_LIMIT);\n}\n");
sh(`git add -A && git commit -q -m base && git push -q origin main`, wt);
sh(`git fetch -q origin`, wt);
// the change under review: public API + an off-by-one + no tests
writeFileSync(join(wt, "src/pager.ts"), `import { clamp } from "./config";

export interface Page<T> { items: T[]; hasMore: boolean }

/** Returns one page of items. page is zero-based. */
export function paginate<T>(items: T[], page: number, size: number): Page<T> {
  const start = page * clamp(size);
  const end = start + clamp(size) + 1; // inclusive end
  return { items: items.slice(start, end), hasMore: end < items.length };
}

export async function loadAll<T>(fetchPage: (p: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) {
    const batch = await fetchPage(p);
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}
`);
sh(`git add -A`, wt);

// seed like the engine does
const dc = join(wt, ".claude");
mkdirSync(join(dc, "agents"), { recursive: true });
cpSync(join(REPO, "payload", "agents"), join(dc, "agents"), { recursive: true });
seedWorktreeSkills(REPO, dc);

const runDir = join(root, "run");
mkdirSync(join(runDir, "plan"), { recursive: true });
mkdirSync(join(runDir, "define"), { recursive: true });
writeFileSync(join(runDir, "plan/plan.md"), "# Plan\nAdd a paginate() helper and a loadAll() helper in src/pager.ts.\n");
writeFileSync(join(runDir, "define/guide.md"), "# Guide\n## Acceptance criteria\n- paginate returns exactly `size` items per page\n- tests in src/pager.test.ts are required\n");
const artifactsDir = join(runDir, "review");
mkdirSync(artifactsDir, { recursive: true });

// TEMPORARY override: review -> copilot (NOT committed in the workflows)
const wf = loadWorkflow({ ...bugfixWorkflow, nodes: bugfixWorkflow.nodes.map((n) => (n.id === "review" ? { ...n, runtime: "copilot" as const } : n)) });
const node = wf.nodes.find((n) => n.id === "review")!;
console.log("review node runtime:", node.runtime, "| model tier:", node.model);

const factory = makeDefaultExecutorFactory(wf);
const exec = factory({ DEVHARNESS_SRC: REPO } as never, "smoke-run-1", runDir, wt, join(root, "store"));
const t0 = Date.now();
const res = await exec("review", node, { runDir, artifactsDir, worktreePath: wt });
console.log("\n=== RESULT ===", JSON.stringify(res), `(${Math.round((Date.now() - t0) / 1000)}s)`);
console.log("root:", root);
if (existsSync(join(artifactsDir, "findings.json"))) {
  const f = JSON.parse(readFileSync(join(artifactsDir, "findings.json"), "utf8"));
  console.log("\n=== findings.json ===\n" + JSON.stringify(f, null, 2));
  console.log("schema problems:", JSON.stringify(validateFindings(f)));
}
console.log("\n=== burn.json ===\n" + readFileSync(join(artifactsDir, "burn.json"), "utf8"));
const tr = readFileSync(join(artifactsDir, "transcript.log"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const perms = tr.filter((e: any) => e.type === "dagrun.permission");
const count = (arr: any[], k: (e: any) => string) => arr.reduce((a: any, e) => ((a[k(e)] = (a[k(e)] ?? 0) + 1), a), {});
console.log("\n=== permission decisions ===", JSON.stringify(count(perms, (e) => `${e.kind}:${e.decision}`)));
console.log("rejected detail:", JSON.stringify(perms.filter((e: any) => e.decision === "reject").map((e: any) => `${e.kind} ${String(e.detail).slice(0, 100)}`), null, 1));
const evTypes = count(tr, (e) => e.type ?? "?");
console.log("event types:", JSON.stringify(evTypes));
const subs = tr.filter((e: any) => /subagent/.test(e.type ?? ""));
console.log("subagent events:", subs.length, JSON.stringify(subs.slice(0, 12).map((e: any) => ({ t: e.type, n: e.data?.agentName ?? e.data?.name ?? e.data?.agentDisplayName }))));
console.log("artifacts dir:", readdirSync(artifactsDir).join(", "));
console.log("git status in worktree (must be unchanged except staged pager.ts):\n" + sh("git status --short", wt));
