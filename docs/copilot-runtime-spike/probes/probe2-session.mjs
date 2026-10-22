// Probe 2: structured output, resume, hooks, usage — one Claude model, throwaway cwd, read-only permissions.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SDK =
  "/private/tmp/claude-501/-Users-eddie-tsedeke-dev-camunda-camunda/0d49e8bf-ecc3-43e3-852d-07daee537376/scratchpad/copilot-sdk-spike/node_modules/@github/copilot-sdk/dist/index.js";
const { CopilotClient } = await import(SDK);

const MODEL = process.env.SPIKE_MODEL ?? "claude-haiku-5.5";
const work = mkdtempSync(join(tmpdir(), "copilot-spike-"));
writeFileSync(join(work, "notes.txt"), "The magic number is 4217.\n");
console.log("workdir:", work, "model:", MODEL);

const seen = { events: {}, permissions: [], hooks: [], usage: [] };

const onPermissionRequest = async (req) => {
  seen.permissions.push(req.kind);
  return req.kind === "read" ? { kind: "approve-once" } : { kind: "reject" };
};

const baseConfig = {
  model: MODEL,
  workingDirectory: work,
  onPermissionRequest,
  hooks: {
    onPreToolUse: async (i) => { seen.hooks.push(`preTool:${i.toolName ?? "?"}`); },
    onPostToolUse: async (i) => { seen.hooks.push(`postTool:${i.toolName ?? "?"}`); },
    onSessionStart: async () => { seen.hooks.push("sessionStart"); },
    onSessionEnd: async () => { seen.hooks.push("sessionEnd"); },
    onAgentStop: async () => { seen.hooks.push("agentStop"); },
  },
  onEvent: (e) => {
    seen.events[e.type] = (seen.events[e.type] ?? 0) + 1;
    if (e.type === "assistant.usage") {
      const d = e.data;
      seen.usage.push({ model: d.model, in: d.inputTokens, out: d.outputTokens, cacheRead: d.cacheReadTokens, cost: d.cost, copilotUsage: d.copilotUsage });
    }
  },
};

const client = new CopilotClient();
let sessionId;
try {
  await client.start();

  // Turn 1: structured output.
  const s1 = await client.createSession(baseConfig);
  sessionId = s1.sessionId;
  console.log("sessionId:", sessionId);
  const r1 = await s1.sendAndWait(
    {
      prompt: "Read notes.txt in the working directory and report the magic number.",
      responseSchema: { type: "object", properties: { magic: { type: "integer" } }, required: ["magic"], additionalProperties: false },
    },
    120_000,
  );
  console.log("TURN1 content:", JSON.stringify(r1?.data?.content));
  await s1.disconnect();

  // Turn 2: resume, must answer from memory without re-reading.
  const toolEventsBefore = seen.hooks.filter((h) => h.startsWith("preTool")).length;
  const s2 = await client.resumeSession(sessionId, baseConfig);
  const r2 = await s2.sendAndWait("What was the magic number you found earlier? Reply with just the digits. Do NOT use any tool.", 120_000);
  console.log("TURN2 content:", JSON.stringify(r2?.data?.content));
  console.log("TURN2 tool calls after resume:", seen.hooks.filter((h) => h.startsWith("preTool")).length - toolEventsBefore);
  await s2.disconnect();
} catch (e) {
  console.log("ERROR:", e?.stack ?? e);
} finally {
  await client.stop();
}
console.log("permissions asked:", JSON.stringify(seen.permissions));
console.log("hooks fired:", JSON.stringify(seen.hooks));
console.log("usage events:", JSON.stringify(seen.usage, null, 1));
console.log("event types:", JSON.stringify(seen.events));
