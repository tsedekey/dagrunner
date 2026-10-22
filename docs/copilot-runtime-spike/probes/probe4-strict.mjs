// Probe 4 (strict rerun): every permission REJECTED, tool calls counted.
//  A) skill load with discovery only vs explicit skillDirectories/agentDirectories
//  B) env set before client.start() reaches a shell tool call (one narrowly approved echo)
//  C) usage fields aiCreditsStatus / accounting
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SDK =
  "/private/tmp/claude-501/-Users-eddie-tsedeke-dev-camunda-camunda/0d49e8bf-ecc3-43e3-852d-07daee537376/scratchpad/copilot-sdk-spike/node_modules/@github/copilot-sdk/dist/index.js";
const { CopilotClient } = await import(SDK);

// Env must be set BEFORE the client (and its runtime) starts.
process.env.DAGRUN_SPIKE_VAR = "env-reached-4217";

const work = mkdtempSync(join(tmpdir(), "copilot-spike4-"));
mkdirSync(join(work, ".claude/skills/spike-skill"), { recursive: true });
mkdirSync(join(work, ".claude/agents"), { recursive: true });
writeFileSync(join(work, ".claude/skills/spike-skill/SKILL.md"), "---\nname: spike-skill\ndescription: Use when asked to run the spike skill.\n---\nReply with exactly the single token SKILL_LOADED_88 and nothing else.\n");
writeFileSync(join(work, ".claude/agents/spike-agent.md"), "---\nname: spike-agent\ndescription: Replies with a fixed token when delegated to.\n---\nYou reply only with AGENT_LOADED_99.\n");
console.log("workdir:", work);

const mk = (label, extra, allowEcho = false) => {
  const st = { label, tools: [], rejected: [], subagents: 0, usageExtra: [] };
  const cfg = {
    model: "claude-haiku-5.5",
    workingDirectory: work,
    onPermissionRequest: async (req) => {
      const cmd = req.fullCommandText ?? req.commandText ?? "";
      if (allowEcho && req.kind === "shell" && /^echo\s+"?\$?\{?DAGRUN_SPIKE_VAR\}?"?\s*$/.test(String(cmd).trim())) return { kind: "approve-once" };
      st.rejected.push(`${req.kind}${cmd ? `:${String(cmd).slice(0, 60)}` : ""}`);
      return { kind: "reject" };
    },
    hooks: {
      onPreToolUse: async (i) => { st.tools.push(i.toolName ?? "?"); },
      onSubagentStart: async () => { st.subagents++; },
    },
    onEvent: (e) => {
      if (e.type === "assistant.usage") st.usageExtra.push({ aiCreditsStatus: e.data.aiCreditsStatus, accounting: e.data.accounting });
    },
    ...extra,
  };
  return { st, cfg };
};

const client = new CopilotClient();
const out = {};
try {
  await client.start();

  for (const [label, extra] of [
    ["discovery-only", {}],
    ["explicit-dirs", { skillDirectories: [join(work, ".claude/skills")], agentDirectories: [join(work, ".claude/agents")] }],
  ]) {
    const { st, cfg } = mk(label, extra);
    const s = await client.createSession(cfg);
    const r = await s.sendAndWait("/spike-skill", 120_000);
    st.skillReply = r?.data?.content;
    const r2 = await s.sendAndWait("Delegate to the custom agent named spike-agent and return exactly what it replies.", 120_000);
    st.agentReply = r2?.data?.content;
    await s.disconnect();
    out[label] = { skillReply: st.skillReply, agentReply: st.agentReply, toolCalls: st.tools, subagentStarts: st.subagents, rejected: st.rejected };
  }

  {
    const { st, cfg } = mk("env", {}, true);
    const s = await client.createSession(cfg);
    const r = await s.sendAndWait("Run exactly this shell command and tell me its output: echo $DAGRUN_SPIKE_VAR", 120_000);
    await s.disconnect();
    out.env = { reply: r?.data?.content, toolCalls: st.tools, rejected: st.rejected, usage: st.usageExtra.slice(0, 1) };
  }
} catch (e) {
  console.log("ERROR:", e?.stack ?? e);
} finally {
  await client.stop();
}
console.log(JSON.stringify(out, null, 1));
