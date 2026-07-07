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

import { selectPermissionMode, buildBaseQueryOptions } from "./sdk-runner.js";
import { buildSeededSettings } from "../config/settings-seed.js";

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
