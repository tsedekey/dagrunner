import { test } from "node:test";
import assert from "node:assert/strict";
import { FINDINGS_SCHEMA, validateFindings } from "./findings-schema.js";

const good = () => ({
  run_id: "r1",
  timestamp: "2026-10-22T00:00:00Z",
  triage: { touches_public_api: false, touches_runtime: false, touches_schema_or_proto: false, performance_sensitive: false, touches_ui: false },
  reviewers_run: ["reviewer-correctness"],
  reviewers_skipped: [],
  adversarial_verifier_run: false,
  findings: [{ reviewer_dimension: "correctness", severity: "major", confidence: "high", file: "a.ts", line: 3, claim: "x", grounded: true }],
});

test("validateFindings: accepts a well-formed doc and an empty findings array", () => {
  assert.deepEqual(validateFindings(good()), []);
  assert.deepEqual(validateFindings({ ...good(), findings: [] }), []);
});

test("validateFindings: rejects missing, extra and mistyped fields", () => {
  const d = good() as Record<string, unknown>;
  delete d["triage"];
  assert.ok(validateFindings(d).some((e) => e.includes("triage")));
  assert.ok(validateFindings({ ...good(), extra: 1 }).some((e) => e.includes("extra")));
  const bad = good();
  (bad.findings[0] as Record<string, unknown>)["severity"] = "huge";
  (bad.findings[0] as Record<string, unknown>)["line"] = 1.5;
  const errs = validateFindings(bad);
  assert.ok(errs.some((e) => e.includes("severity")) && errs.some((e) => e.includes("line")));
  assert.ok(validateFindings("x").length > 0);
});

test("FINDINGS_SCHEMA is strict-mode shaped: every object lists all properties as required, no extras", () => {
  const walk = (s: unknown, path: string): void => {
    if (typeof s !== "object" || s === null) return;
    const o = s as Record<string, unknown>;
    if (o["type"] === "object") {
      const props = Object.keys((o["properties"] ?? {}) as object).sort();
      assert.deepEqual([...((o["required"] as string[]) ?? [])].sort(), props, path);
      assert.equal(o["additionalProperties"], false, path);
      for (const [k, v] of Object.entries(o["properties"] as object)) walk(v, `${path}.${k}`);
    }
    if (o["type"] === "array") walk(o["items"], `${path}[]`);
  };
  walk(FINDINGS_SCHEMA, "$");
});
