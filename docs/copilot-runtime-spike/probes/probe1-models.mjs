// Probe 1: does the SDK start, is the Copilot login picked up, which Claude models are offered?
// No model calls are made here.
const SDK =
  "/private/tmp/claude-501/-Users-eddie-tsedeke-dev-camunda-camunda/0d49e8bf-ecc3-43e3-852d-07daee537376/scratchpad/copilot-sdk-spike/node_modules/@github/copilot-sdk/dist/index.js";
const { CopilotClient } = await import(SDK);

const client = new CopilotClient();
try {
  await client.start();
  console.log("status:", JSON.stringify(await client.getStatus()));
  const auth = await client.getAuthStatus();
  // Print only non-secret fields.
  console.log("auth:", JSON.stringify({ isAuthenticated: auth.isAuthenticated, authType: auth.authType, host: auth.host, login: auth.login ? "<present>" : undefined }));
  const models = await client.listModels();
  console.log(`models: ${models.length}`);
  for (const m of models) {
    console.log(
      [m.id.padEnd(28), `x${m.billing?.multiplier ?? "?"}`.padEnd(7), `effort=${(m.supportedReasoningEfforts ?? []).join("/") || "-"}`, `policy=${m.policy?.state ?? "-"}`].join(" "),
    );
  }
} finally {
  await client.stop();
}
