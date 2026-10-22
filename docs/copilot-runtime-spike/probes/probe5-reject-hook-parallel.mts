// Probe 5: (a) does reject actually block mutating tools under the REAL read-only policy?
//          (b) does a PreToolUse hook returning deny block a tool call?
//          (c) two clients in parallel, distinct env.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadOnlyPermissionHandler } from "/Users/eddie.tsedeke/dev/dagrunner/src/runtime/copilot-runner.ts";
const { CopilotClient } = await import("/Users/eddie.tsedeke/dev/dagrunner/node_modules/@github/copilot-sdk/dist/index.js");
const MODEL = "claude-haiku-5.5";

async function session(client: any, work: string, art: string, extra: any, log: any[]) {
  return client.createSession({
    model: MODEL, workingDirectory: work,
    onPermissionRequest: makeReadOnlyPermissionHandler({ artifactsDir: art, worktreePath: work, onDecision: (d) => log.push(d) }),
    ...extra,
  });
}

// (a)
{
  const work = mkdtempSync(join(tmpdir(), "p5a-")); const art = join(work, "..", "p5a-art-" + Date.now()); mkdirSync(art);
  writeFileSync(join(work, "keep.txt"), "original\n");
  const log: any[] = []; const tools: string[] = [];
  const client = new CopilotClient(); await client.start();
  const s = await session(client, work, art, { hooks: { onPreToolUse: async (i: any) => { tools.push(i.toolName); } } }, log);
  const r = await s.sendAndWait("Do all of these, in order, and report what happened for each: (1) create a file named evil1.txt containing 'x' in the current directory using your file edit/create tool; (2) run the shell command: echo hi > evil2.txt ; (3) run the shell command: touch evil3.txt ; (4) overwrite keep.txt with the text 'changed'; (5) run the shell command: ls", 180_000);
  console.log("=== (a) reject path ===");
  console.log("reply:", JSON.stringify(r?.data?.content?.slice(0, 600)));
  console.log("tools attempted:", JSON.stringify(tools));
  console.log("decisions:", JSON.stringify(log.map((d) => `${d.kind}:${d.decision}:${String(d.detail).slice(0, 50)}`)));
  console.log("files now:", JSON.stringify(readdirSync(work)));
  console.log("evil files exist:", ["evil1.txt", "evil2.txt", "evil3.txt"].map((f) => existsSync(join(work, f))), "| keep.txt unchanged:", require_("node:fs").readFileSync(join(work, "keep.txt"), "utf8") === "original\n");
  await s.disconnect(); await client.stop();
}
function require_(m: string) { return (globalThis as any).process.getBuiltinModule(m); }

// (b)
{
  const work = mkdtempSync(join(tmpdir(), "p5b-")); const art = join(work, "..", "p5b-art-" + Date.now()); mkdirSync(art);
  writeFileSync(join(work, "secret.txt"), "TOKEN-9917\n");
  const log: any[] = []; const seen: string[] = [];
  const client = new CopilotClient(); await client.start();
  const s = await session(client, work, art, { hooks: { onPreToolUse: async (i: any) => { seen.push(i.toolName); return { permissionDecision: "deny", permissionDecisionReason: "blocked by dagrunner hook" }; } } }, log);
  const r = await s.sendAndWait("Read secret.txt in the current directory and tell me its exact contents. Use a tool to read it.", 180_000);
  console.log("=== (b) hook deny ===");
  console.log("reply:", JSON.stringify(r?.data?.content?.slice(0, 400)));
  console.log("hook saw tools:", JSON.stringify(seen), "| reply leaks token:", /9917/.test(r?.data?.content ?? ""));
  await s.disconnect(); await client.stop();
}

// (c)
{
  const t0 = Date.now();
  const run = async (n: number) => {
    process.env.DAGRUN_PROBE_N = String(n); // set before this client's start
    const work = mkdtempSync(join(tmpdir(), `p5c${n}-`)); const art = join(work, "..", `p5c${n}-art-` + Date.now()); mkdirSync(art);
    const client = new CopilotClient(); await client.start();
    const s = await session(client, work, art, {}, []);
    const r = await s.sendAndWait("Reply with exactly the word DONE" + n, 120_000);
    await s.disconnect(); await client.stop();
    return r?.data?.content;
  };
  const out = await Promise.all([run(1), run(2), run(3)]);
  console.log("=== (c) 3 parallel clients ===", JSON.stringify(out), `${Math.round((Date.now() - t0) / 1000)}s`);
}
