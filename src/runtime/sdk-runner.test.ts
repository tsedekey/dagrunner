/**
 * sdk-runner.test.ts — unit tests for pure exported helpers.
 *
 * Scope: selectPermissionMode (pure, deterministic).
 *        Teeth-check: seeded settings always enforce the deny-guard hook
 *        regardless of permissionMode — night-mode bypasses prompts only,
 *        never the boundary.
 *
 * Run with:
 *   node --test --import tsx src/runtime/sdk-runner.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectPermissionMode,
  buildBaseQueryOptions,
  applyNodeOptions,
  buildNodePrompt,
  buildRunEnvironmentBlock,
} from "./sdk-runner.js";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionCtx } from "./mock-executor.js";
import { buildSeededSettings } from "../config/settings-seed.js";
import type { Node } from "../core/types.js";

// ---------------------------------------------------------------------------
// selectPermissionMode — pure branch, deterministic
// ---------------------------------------------------------------------------

test("selectPermissionMode: night mode → bypassPermissions", () => {
  assert.equal(selectPermissionMode(true), "bypassPermissions");
});

test("selectPermissionMode: attended (false) → acceptEdits", () => {
  assert.equal(selectPermissionMode(false), "acceptEdits");
});

test("selectPermissionMode: attended (undefined) → acceptEdits", () => {
  assert.equal(selectPermissionMode(undefined), "acceptEdits");
});

// ---------------------------------------------------------------------------
// Teeth-check — bypass flips prompts only, never the boundary
//
// Night-mode sets permissionMode: bypassPermissions in the SDK call, but
// the seeded settings.json that enforces the deny-guard hook is written by
// buildSeededSettings, which is independent of permissionMode. This test
// proves the boundary is structurally intact regardless of the night flag.
// (There is no filesystem sandbox to also check — sandbox.enabled has been
// removed from buildSeededSettings entirely; see DECISIONS.md
// § verify-autonomy-remove-election and the commit that removed it. The
// Bash allow/deny list + this hook are the only enforced boundary.)
// ---------------------------------------------------------------------------

const minimalSettings = () =>
  buildSeededSettings({
    runDir: "/tmp/dagrunner-test-run",
    homeDir: "/tmp",
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
  }) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// buildBaseQueryOptions — pure branch, deterministic
//
// Teeth-check: every node session unconditionally disallows ScheduleWakeup.
// Real-run evidence (run 54177-1, verify node): the SDK auto-backgrounds a
// long-running Bash command and the model reached for ScheduleWakeup to
// "resume later" — a durable wakeup meant for an EXTERNAL scheduler dagrunner
// never wires up, since every node session is a single one-shot query() call
// (see CLAUDE.md's "one-shot sessions" gotcha and DECISIONS.md §
// verify-scheduleawakeup-incompatibility). This must hold for every node, not
// just verify — any node's Bash call could in principle auto-background.
// ---------------------------------------------------------------------------

test("buildBaseQueryOptions: ScheduleWakeup is always disallowed (attended)", () => {
  const options = buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false);
  assert.ok(
    options.disallowedTools?.includes("ScheduleWakeup"),
    `ScheduleWakeup must be disallowed; got: ${JSON.stringify(options.disallowedTools)}`,
  );
});

test("buildBaseQueryOptions: ScheduleWakeup is always disallowed (night mode)", () => {
  const options = buildBaseQueryOptions("/tmp/dagrunner-test-worktree", true);
  assert.ok(
    options.disallowedTools?.includes("ScheduleWakeup"),
    `ScheduleWakeup must be disallowed; got: ${JSON.stringify(options.disallowedTools)}`,
  );
});

test("buildBaseQueryOptions: cwd/permissionMode/settingSources/systemPrompt still set", () => {
  const options = buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false);
  assert.equal(options.cwd, "/tmp/dagrunner-test-worktree");
  assert.equal(options.permissionMode, "acceptEdits");
  assert.deepEqual(options.settingSources, ["project"]);
  assert.deepEqual(options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
  });
});

// ---------------------------------------------------------------------------
// applyNodeOptions — pure branch, deterministic
//
// Mirrors buildBaseQueryOptions's extraction pattern: the node→options
// mapping (model/allowedTools/maxBudget/outputSchema/effort) lives in a pure
// function so it's unit-testable without mocking the SDK's query(). Proves
// node.effort passes through to options.effort when set, and — the
// exactOptionalPropertyTypes-safe half of the contract — is never assigned
// as `key: undefined` when omitted (checked via `in`, not `=== undefined`,
// since the latter would also pass a wrongly-assigned `effort: undefined`).
// ---------------------------------------------------------------------------

const baseNode = (overrides: Partial<Node> = {}): Node => ({
  id: "step-a",
  command: "/step-a",
  ...overrides,
});

test("applyNodeOptions: node.effort set → options.effort passes through", () => {
  const options = applyNodeOptions(
    buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false),
    baseNode({ effort: "medium" }),
  );
  assert.equal(options.effort, "medium");
});

test("applyNodeOptions: node.effort omitted → options.effort key is absent entirely", () => {
  const options = applyNodeOptions(
    buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false),
    baseNode(),
  );
  assert.ok(
    !("effort" in options),
    `effort key must be entirely absent when node.effort is undefined; got: ${JSON.stringify(options)}`,
  );
});

test("applyNodeOptions: allowedTools/maxBudget/outputSchema still pass through unchanged", () => {
  const options = applyNodeOptions(
    buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false),
    baseNode({
      allowedTools: ["Bash"],
      maxBudget: 5,
      outputSchema: { type: "object" },
    }),
  );
  assert.deepEqual(options.allowedTools, ["Bash"]);
  assert.equal(options.maxBudgetUsd, 5);
  assert.deepEqual(options.outputFormat, {
    type: "json_schema",
    schema: { type: "object" },
  });
});

test("applyNodeOptions: model tiers still map to pinned model ids", () => {
  const sonnet = applyNodeOptions(
    buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false),
    baseNode({ model: "sonnet" }),
  );
  assert.equal(sonnet.model, "claude-sonnet-5");

  const opus = applyNodeOptions(
    buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false),
    baseNode({ model: "opus" }),
  );
  assert.equal(opus.model, "claude-opus-5-5");

  const haiku = applyNodeOptions(
    buildBaseQueryOptions("/tmp/dagrunner-test-worktree", false),
    baseNode({ model: "haiku" }),
  );
  assert.equal(haiku.model, "claude-haiku-5-5");
});

test("teeth-check: seeded settings always wire the deny-guard (stop-verifier) hook", () => {
  const s = minimalSettings();
  const hooks = s["hooks"] as Record<string, unknown>;
  const stopGroups = hooks?.["Stop"] as Array<{
    hooks: Array<{ command: string }>;
  }>;
  const stopCommands = (stopGroups ?? []).flatMap((g) =>
    (g.hooks ?? []).map((h) => h.command),
  );
  assert.ok(
    stopCommands.some((c) => c.includes("stop-verifier")),
    `deny-guard (stop-verifier) hook must be present in Stop hooks; got: ${JSON.stringify(stopCommands)}`,
  );
});

// ---------------------------------------------------------------------------
// Run-environment block — the engine hands nodes their literal paths
// ---------------------------------------------------------------------------

function promptFixture(): { ctx: ExecutionCtx; wt: string } {
  const root = mkdtempSync(join(tmpdir(), "dr-prompt-"));
  const runDir = join(root, "runs", "r1");
  const artifactsDir = join(runDir, "fix");
  const wt = join(root, "worktrees", "r1");
  mkdirSync(artifactsDir, { recursive: true });
  return { ctx: { runDir, artifactsDir, worktreePath: wt }, wt };
}

test("buildNodePrompt: first run = slash command + single space + block with the literal paths", () => {
  const { ctx, wt } = promptFixture();
  const prompt = buildNodePrompt(baseNode({ command: "/fix" }), ctx, wt);
  // single space after the command so the command name still parses
  assert.ok(prompt.startsWith("/fix <run-environment>\n"), prompt);
  assert.ok(prompt.includes(ctx.artifactsDir));
  assert.ok(prompt.includes(ctx.runDir));
  assert.ok(prompt.includes(wt));
  assert.ok(prompt.endsWith("</run-environment>"));
});

test("buildNodePrompt: feedback resume keeps <reviewer-feedback> first and appends the block", () => {
  const { ctx, wt } = promptFixture();
  writeFileSync(join(ctx.artifactsDir, "feedback-1.md"), "please add a test\n");
  const prompt = buildNodePrompt(
    baseNode({ command: "/fix", produces: ["summary.md"] }),
    { ...ctx, sessionId: "sess-1" },
    wt,
  );
  assert.ok(prompt.startsWith("<reviewer-feedback>\nplease add a test\n</reviewer-feedback>"), prompt);
  assert.ok(prompt.includes(join(ctx.artifactsDir, "summary.md")), "default revision instruction unchanged");
  assert.ok(prompt.includes(`artifactsDir (`) && prompt.includes(ctx.artifactsDir));
  assert.ok(prompt.endsWith("</run-environment>"));
});

test("buildNodePrompt: resumed session without a feedback file still carries the block", () => {
  const { ctx, wt } = promptFixture();
  const prompt = buildNodePrompt(baseNode({ command: "/fix" }), { ...ctx, sessionId: "sess-1" }, wt);
  assert.ok(prompt.startsWith("/fix <run-environment>"));
  assert.ok(prompt.includes(ctx.runDir));
});

test("buildRunEnvironmentBlock: paths only — no env values, no secrets", () => {
  const { ctx, wt } = promptFixture();
  process.env["ANTHROPIC_API_KEY"] = "sk-test-secret";
  try {
    const block = buildRunEnvironmentBlock(ctx, wt);
    assert.ok(!block.includes("sk-test-secret"));
    assert.equal(block.split("\n").length, 7);
    assert.ok(block.includes("- runId: r1"));
  } finally {
    delete process.env["ANTHROPIC_API_KEY"];
  }
});

test("payload/commands no longer tell nodes a literal path is unobtainable or to avoid the Write tool", () => {
  const dir = join(new URL("../../payload/commands/", import.meta.url).pathname);
  const banned = [
    /no reliable way to\s+obtain one/i,
    /not the Write\s+tool/i,
    /never via the Write tool/i,
    /not the Read tool, which needs/i,
    /Do not try to print or discover the literal value/i,
    /a literal path you don't have/i,
  ];
  const nodeCommands = ["define", "reproduce", "implement", "review", "fix", "pr"];
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const re of banned) {
      assert.ok(!re.test(text), `${name} still contains ${re}`);
    }
    if (nodeCommands.includes(name.replace(/\.md$/, ""))) {
      // $ARGUMENTS makes the engine-provided block land in the prompt deterministically
      // (Claude Code substitutes it; without the placeholder it only appends trailing text).
      assert.ok(text.includes("$ARGUMENTS"), `${name} must interpolate $ARGUMENTS (the run-environment block)`);
      // Bash commands containing a variable expansion are rejected by the sandbox
      // ("Contains simple_expansion", 21 of 46 denials in run 51496-1) — snippets must
      // use the literal-path placeholders, not these variables.
      assert.ok(
        !/\$\{?DAGRUN_(ARTIFACTS|RUN_DIR|WORKTREE|RUN_ID)\b/.test(text),
        `${name} still uses a $DAGRUN_* path variable in its snippets`,
      );
    }
  }
});
