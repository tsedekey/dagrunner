// Probe 3: does a Copilot SDK session honour a Claude-style .claude/ directory in its cwd?
// Checks .claude/commands (slash command), .claude/skills, and .claude/agents.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SDK =
  "/private/tmp/claude-501/-Users-eddie-tsedeke-dev-camunda-camunda/0d49e8bf-ecc3-43e3-852d-07daee537376/scratchpad/copilot-sdk-spike/node_modules/@github/copilot-sdk/dist/index.js";
const { CopilotClient } = await import(SDK);

const work = mkdtempSync(join(tmpdir(), "copilot-spike3-"));
mkdirSync(join(work, ".claude/commands"), { recursive: true });
mkdirSync(join(work, ".claude/skills/spike-skill"), { recursive: true });
mkdirSync(join(work, ".claude/agents"), { recursive: true });
writeFileSync(join(work, ".claude/commands/spike-cmd.md"), "---\ndescription: spike command\n---\nReply with exactly the single token COMMAND_LOADED_77 and nothing else.\n");
writeFileSync(join(work, ".claude/skills/spike-skill/SKILL.md"), "---\nname: spike-skill\ndescription: Use when asked to run the spike skill.\n---\nReply with exactly the single token SKILL_LOADED_88 and nothing else.\n");
writeFileSync(join(work, ".claude/agents/spike-agent.md"), "---\nname: spike-agent\ndescription: spike agent\n---\nYou reply only with AGENT_LOADED_99.\n");
console.log("workdir:", work);

const events = [];
const client = new CopilotClient();
try {
  await client.start();
  const s = await client.createSession({
    model: "claude-haiku-5.5",
    workingDirectory: work,
    onPermissionRequest: async (r) => (r.kind === "read" ? { kind: "approve-once" } : { kind: "reject" }),
    onEvent: (e) => { if (/skill|command|agent/i.test(e.type)) events.push(e.type); },
  });
  for (const prompt of [
    "/spike-cmd",
    "/spike-skill",
    "List the exact names of every slash command, skill and custom agent you have available that contain the word 'spike'. If none, say NONE.",
  ]) {
    const r = await s.sendAndWait(prompt, 120_000);
    console.log(`> ${prompt.slice(0, 40)}\n  ${JSON.stringify(r?.data?.content)?.slice(0, 300)}`);
  }
  await s.disconnect();
} catch (e) {
  console.log("ERROR:", e?.stack ?? e);
} finally {
  await client.stop();
}
console.log("related events:", JSON.stringify(events));
