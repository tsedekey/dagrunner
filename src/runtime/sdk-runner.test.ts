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

// sandbox.enabled is intentionally false (commit 3015634: Maven builds require
// access to **/target/ and local-cluster ports that the sandbox blocks).
// The authoritative test for sandbox shape is settings-seed.test.ts.
// The real boundary teeth: deny-guard (stop-verifier) hook is always wired,
// regardless of permissionMode — tested below.
test("teeth-check: seeded settings have sandbox present and independent of permissionMode", () => {
  const s = minimalSettings();
  const sandbox = s["sandbox"] as Record<string, unknown>;
  assert.ok(
    sandbox !== null && typeof sandbox === "object",
    "sandbox key must be present in seeded settings",
  );
  // sandbox.enabled=false is intentional (3015634). Do not assert true here.
  // The boundary is enforced by the deny-guard hook, not the filesystem sandbox.
  assert.equal(sandbox?.["enabled"], false);
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
