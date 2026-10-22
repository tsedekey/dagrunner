// Live smoke: review node on Copilot, throwaway repo/worktree, temporary runtime override ONLY.
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bugfixWorkflow } from "/Users/eddie.tsedeke/dev/dagrunner/src/workflow/bugfix-workflow.ts";
import { makeDefaultExecutorFactory } from "/Users/eddie.tsedeke/dev/dagrunner/src/runtime/runtime-router.ts";
import { seedWorktreeSkills } from "/Users/eddie.tsedeke/dev/dagrunner/src/runtime/run-engine.ts";
import { validateFindings } from "/Users/eddie.tsedeke/dev/dagrunner/src/core/findings-schema.ts";
import { buildSeededSettings, readSourcePassthrough, readWorkProfileMcpServers } from "/Users/eddie.tsedeke/dev/dagrunner/src/config/settings-seed.ts";
import { loadWorkflow } from "/Users/eddie.tsedeke/dev/dagrunner/src/workflow/workflow.ts";

const REPO = "/Users/eddie.tsedeke/dev/dagrunner";
const sh = (c: string, cwd: string) => execSync(c, { cwd, stdio: "pipe", encoding: "utf8" });

const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "claude-smoke-")));
// Claude Code only honours a project's .claude/settings.json (permissions.additionalDirectories) in a TRUSTED
// workspace; a git worktree of a trusted repo inherits trust (as the engine's real worktrees do). toy-src is a
// trusted scratch repo of this project's smoke tests. Temp worktree + branch + ref are removed afterwards.
const devsrc = "/Users/eddie.tsedeke/tmp/toy-src";
const branch = `smoke-claude-${Date.now()}`;
const wt = join(root, "wt");
sh(`git update-ref refs/remotes/origin/main main`, devsrc);
sh(`git worktree add "${wt}" -b ${branch} main`, devsrc);
process.on("exit", () => {
  try { sh(`git worktree remove --force "${wt}"`, devsrc); sh(`git branch -D ${branch}`, devsrc); sh(`git update-ref -d refs/remotes/origin/main`, devsrc); } catch (e) { console.log("cleanup failed", String(e)); }
});
mkdirSync(join(wt, "src"), { recursive: true });
writeFileSync(join(wt, "src/config.ts"), "export const PAGE_LIMIT = 100;\nexport function clamp(n: number): number {\n  return Math.min(n, PAGE_LIMIT);\n}\n");
sh(`git add -A && git -c user.email=t@t -c user.name=t commit -q -m "smoke base"`, wt);
sh(`git update-ref refs/remotes/origin/main HEAD`, wt);
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

// seed like the engine does (startRun): agents, skills, hooks, settings.json
const dc = join(wt, ".claude");
mkdirSync(join(dc, "agents"), { recursive: true });
mkdirSync(join(dc, "hooks"), { recursive: true });
cpSync(join(REPO, "payload", "agents"), join(dc, "agents"), { recursive: true });
cpSync(join(REPO, ".claude", "hooks"), join(dc, "hooks"), { recursive: true });
if (process.env.BASELINE === "1") {
  mkdirSync(join(dc, "commands"), { recursive: true });
  writeFileSync(join(dc, "commands", "review.md"), readFileSync("/private/tmp/claude-501/-Users-eddie-tsedeke-dev-dagrunner/56d51652-9d79-463a-9f1a-d250a16e2033/scratchpad/old-review.md", "utf8"));
  console.log("BASELINE: old commands/review.md, no skill");
} else seedWorktreeSkills(REPO, dc);
const claudeConfigDir = join(homedir(), ".claude");
const runDir = join(root, "run");
mkdirSync(join(runDir, "plan"), { recursive: true });
mkdirSync(join(runDir, "define"), { recursive: true });
writeFileSync(join(runDir, "plan/plan.md"), "# Plan\nAdd a paginate() helper and a loadAll() helper in src/pager.ts.\n");
writeFileSync(join(runDir, "define/guide.md"), "# Guide\n## Acceptance criteria\n- paginate returns exactly `size` items per page\n- tests in src/pager.test.ts are required\n");
writeFileSync(join(dc, "settings.json"), JSON.stringify(buildSeededSettings({
  runDir, homeDir: homedir(), tmpDir: tmpdir(), passthrough: readSourcePassthrough(devsrc),
  claudeConfigDir, workProfileMcpServers: readWorkProfileMcpServers(claudeConfigDir, wt),
  devharnessSrc: devsrc, dagrunnerHome: join(root, "home"),
}), null, 2));
const artifactsDir = join(runDir, "review");
mkdirSync(artifactsDir, { recursive: true });

// NO override: the committed bugfix workflow, review resolves to claude
const wf = loadWorkflow(bugfixWorkflow);
const node = wf.nodes.find((n) => n.id === "review")!;
console.log("review node runtime:", node.runtime, "| model tier:", node.model);

const factory = makeDefaultExecutorFactory(wf);
const exec = factory({ DEVHARNESS_SRC: devsrc, claudeConfigDir } as never, "smoke-claude-1", runDir, wt, join(root, "store"));
const t0 = Date.now();
const res = await exec("review", node, { runDir, artifactsDir, worktreePath: wt });
console.log("\n=== RESULT ===", JSON.stringify(res), `(${Math.round((Date.now() - t0) / 1000)}s)`);
console.log("root:", root);
if (existsSync(join(artifactsDir, "findings.json"))) {
  const f = JSON.parse(readFileSync(join(artifactsDir, "findings.json"), "utf8"));
  console.log("\n=== findings.json ===\n" + JSON.stringify(f, null, 2));
  console.log("schema problems:", JSON.stringify(validateFindings(f)));
}
console.log("\n=== burn.json (claude shape) ===\n" + readFileSync(join(artifactsDir, "burn.json"), "utf8").slice(0, 1500));
const tr = readFileSync(join(artifactsDir, "transcript.log"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const tools: Record<string, number> = {};
for (const e of tr) if (e.type === "assistant") for (const b of e.message?.content ?? []) if (b.type === "tool_use") tools[b.name] = (tools[b.name] ?? 0) + 1;
console.log("\n=== claude tool_use counts ===", JSON.stringify(tools));
console.log("subagent dispatches (Agent/Task):", (tools["Agent"] ?? 0) + (tools["Task"] ?? 0));
console.log("permission_denied events:", tr.filter((e: any) => e.subtype === "permission_denied" || JSON.stringify(e).includes("permission_denied")).length);
console.log("artifacts dir:", readdirSync(artifactsDir).join(", "));
console.log("git status in worktree:\n" + sh("git status --short", wt));
