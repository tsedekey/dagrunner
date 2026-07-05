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

import { selectPermissionMode } from "./sdk-runner.js";
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
