/**
 * sdk-runner.test.ts — unit tests for pure exported helpers.
 *
 * Scope: selectPermissionMode (pure, deterministic).
 *        Teeth-check: seeded settings always enforce sandbox + deny-guard
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
// the seeded settings.json that enforces sandbox + deny-guard is written by
// buildSeededSettings, which is independent of permissionMode. These tests
// prove the boundary is structurally intact regardless of the night flag.
// ---------------------------------------------------------------------------

const minimalSettings = () =>
  buildSeededSettings({
    runDir: "/tmp/dagrunner-test-run",
    homeDir: "/tmp",
    tmpDir: "/tmp",
    passthrough: { env: {}, mcpServers: undefined },
  }) as Record<string, unknown>;

test("teeth-check: seeded settings always have sandbox.enabled=true", () => {
  const s = minimalSettings();
  const sandbox = s["sandbox"] as Record<string, unknown>;
  assert.equal(
    sandbox?.["enabled"],
    true,
    "sandbox.enabled must always be true — night-mode must not remove it",
  );
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
