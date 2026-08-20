/**
 * feature-workflow.test.ts — schema-contract tests for FINDINGS_SCHEMA
 * and featureWorkflow validity.
 *
 * Strategy: hand-rolled minimal JSON Schema validator covering the subset
 * these schemas use (type/properties/required/enum/items/additionalProperties).
 * No ajv — zero new dependencies.
 *
 * Teeth: break a schema field or feed a non-conforming fixture → test goes red.
 *
 * Run with:
 *   node --test --import tsx src/workflow/feature-workflow.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { FINDINGS_SCHEMA, featureWorkflow } from "./feature-workflow.js";
import { loadWorkflow } from "./workflow.js";

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (subset: type/properties/required/enum/items)
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

function validate(value: unknown, schema: Schema, path = ""): string[] {
  const errors: string[] = [];
  const label = path || "(root)";

  if ("type" in schema) {
    const t = schema["type"];
    if (t === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(
          `${label}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`,
        );
        return errors;
      }
    } else if (t === "string" && typeof value !== "string") {
      errors.push(`${label}: expected string, got ${typeof value}`);
      return errors;
    } else if (t === "boolean" && typeof value !== "boolean") {
      errors.push(`${label}: expected boolean, got ${typeof value}`);
      return errors;
    } else if (t === "number" && typeof value !== "number") {
      errors.push(`${label}: expected number, got ${typeof value}`);
      return errors;
    } else if (t === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${label}: expected array, got ${typeof value}`);
        return errors;
      }
    }
  }

  if ("enum" in schema && Array.isArray(schema["enum"])) {
    if (!(schema["enum"] as unknown[]).includes(value)) {
      errors.push(
        `${label}: expected one of [${(schema["enum"] as unknown[]).map(String).join(", ")}], got "${String(value)}"`,
      );
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if ("required" in schema && Array.isArray(schema["required"])) {
      for (const field of schema["required"] as string[]) {
        if (!(field in obj)) {
          errors.push(`${label}.${field}: required field missing`);
        }
      }
    }

    if (
      schema["additionalProperties"] === false &&
      "properties" in schema &&
      typeof schema["properties"] === "object" &&
      schema["properties"] !== null
    ) {
      const defined = new Set(
        Object.keys(schema["properties"] as Record<string, unknown>),
      );
      for (const key of Object.keys(obj)) {
        if (!defined.has(key)) {
          errors.push(`${label}.${key}: additional property not allowed`);
        }
      }
    }

    if (
      "properties" in schema &&
      typeof schema["properties"] === "object" &&
      schema["properties"] !== null
    ) {
      const props = schema["properties"] as Record<string, Schema>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          const childPath = path ? `${path}.${key}` : key;
          errors.push(...validate(obj[key], propSchema, childPath));
        }
      }
    }
  }

  if (Array.isArray(value) && "items" in schema) {
    const itemSchema = schema["items"] as Schema;
    for (let i = 0; i < value.length; i++) {
      errors.push(...validate(value[i], itemSchema, `${label}[${i}]`));
    }
  }

  return errors;
}

function assertValid(value: unknown, schema: Schema, label = ""): void {
  const errors = validate(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `${label ? label + ": " : ""}Schema validation failed:\n${errors.join("\n")}`,
    );
  }
}

function assertInvalid(value: unknown, schema: Schema, label = ""): void {
  const errors = validate(value, schema);
  if (errors.length === 0) {
    throw new Error(
      `${label ? label + ": " : ""}Expected schema validation to fail but it passed`,
    );
  }
}

// ---------------------------------------------------------------------------
// FINDINGS_SCHEMA well-formedness
// ---------------------------------------------------------------------------

test("FINDINGS_SCHEMA: required fields are a subset of defined properties", () => {
  const props = Object.keys(FINDINGS_SCHEMA.properties);
  for (const req of FINDINGS_SCHEMA.required) {
    assert.ok(props.includes(req), `required field "${req}" not in properties`);
  }
});

test("FINDINGS_SCHEMA: additionalProperties:false is present", () => {
  assert.equal(FINDINGS_SCHEMA.additionalProperties, false);
});

test("FINDINGS_SCHEMA: triage sub-object required fields are in its properties", () => {
  const triage = FINDINGS_SCHEMA.properties.triage as Record<string, unknown>;
  const props = Object.keys(triage["properties"] as Record<string, unknown>);
  for (const req of triage["required"] as string[]) {
    assert.ok(
      props.includes(req),
      `triage required field "${req}" not in properties`,
    );
  }
});

test("FINDINGS_SCHEMA: triage includes touches_ui as required boolean", () => {
  const triage = FINDINGS_SCHEMA.properties.triage as Record<string, unknown>;
  const required = triage["required"] as string[];
  assert.ok(
    required.includes("touches_ui"),
    "touches_ui must be in triage.required",
  );
  const props = triage["properties"] as Record<string, Record<string, unknown>>;
  assert.equal(
    props["touches_ui"]?.["type"],
    "boolean",
    "touches_ui must be boolean",
  );
});

test("FINDINGS_SCHEMA: manual_test_recommendation is gone (verify-autonomy change — no longer fed to any election)", () => {
  const required: readonly string[] = FINDINGS_SCHEMA.required;
  assert.ok(
    !required.includes("manual_test_recommendation"),
    "manual_test_recommendation must not be in top-level required",
  );
  assert.ok(
    !("manual_test_recommendation" in FINDINGS_SCHEMA.properties),
    "manual_test_recommendation must not be a defined property",
  );
});

test("FINDINGS_SCHEMA: findings items severity enum is non-empty", () => {
  const findingsItems = (
    FINDINGS_SCHEMA.properties.findings as Record<string, unknown>
  )["items"] as Record<string, unknown>;
  const severityEnum = (findingsItems["properties"] as Record<string, unknown>)[
    "severity"
  ] as Record<string, unknown>;
  assert.ok(
    Array.isArray(severityEnum["enum"]) &&
      (severityEnum["enum"] as unknown[]).length > 0,
    "severity enum must be non-empty",
  );
});

// ---------------------------------------------------------------------------
// FINDINGS_SCHEMA: conforming and non-conforming fixtures
// ---------------------------------------------------------------------------

const VALID_FINDINGS = {
  run_id: "test-run-123",
  timestamp: "2026-06-17T10:00:00.000Z",
  triage: {
    touches_public_api: false,
    touches_runtime: true,
    touches_schema_or_proto: false,
    performance_sensitive: false,
    touches_ui: false,
  },
  reviewers_run: ["correctness", "test-adequacy"],
  reviewers_skipped: [{ name: "performance", reason: "not perf-sensitive" }],
  adversarial_verifier_run: true,
  findings: [
    {
      reviewer_dimension: "correctness",
      severity: "major",
      confidence: "high",
      file: "src/foo.ts",
      line: 42,
      claim: "null dereference possible",
      grounded: true,
    },
  ],
};

test("FINDINGS_SCHEMA: valid fixture conforms", () => {
  assertValid(
    VALID_FINDINGS,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA valid",
  );
});

test("FINDINGS_SCHEMA: missing top-level required field fails (teeth)", () => {
  const { run_id: _, ...missing } = VALID_FINDINGS;
  assertInvalid(
    missing,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA missing run_id",
  );
});

test("FINDINGS_SCHEMA: invalid severity enum value fails (teeth)", () => {
  const bad = {
    ...VALID_FINDINGS,
    findings: [
      { ...VALID_FINDINGS.findings[0], severity: "critical" }, // not in enum
    ],
  };
  assertInvalid(
    bad,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA bad severity",
  );
});

test("FINDINGS_SCHEMA: additional property in findings item fails (teeth)", () => {
  const bad = {
    ...VALID_FINDINGS,
    findings: [{ ...VALID_FINDINGS.findings[0], extra_field: "unexpected" }],
  };
  assertInvalid(
    bad,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA extra finding field",
  );
});

test("FINDINGS_SCHEMA: missing required field in triage sub-object fails (teeth)", () => {
  const bad = {
    ...VALID_FINDINGS,
    triage: {
      touches_public_api: false,
      touches_runtime: true,
      // touches_schema_or_proto missing
      performance_sensitive: false,
    },
  };
  assertInvalid(
    bad,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA missing triage field",
  );
});

test("FINDINGS_SCHEMA: missing touches_ui in triage fails (teeth)", () => {
  const bad = {
    ...VALID_FINDINGS,
    triage: {
      touches_public_api: false,
      touches_runtime: true,
      touches_schema_or_proto: false,
      performance_sensitive: false,
      // touches_ui missing
    },
  };
  assertInvalid(
    bad,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA missing touches_ui",
  );
});

test("FINDINGS_SCHEMA: a stray manual_test_recommendation field now fails (additionalProperties:false, teeth)", () => {
  const bad = {
    ...VALID_FINDINGS,
    manual_test_recommendation: {
      recommended: false,
      surface: "none",
      rationale: "stale field from before the verify-autonomy change",
    },
  };
  assertInvalid(
    bad,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA stray manual_test_recommendation",
  );
});

// ---------------------------------------------------------------------------
// featureWorkflow passes loadWorkflow
// ---------------------------------------------------------------------------

test("featureWorkflow: passes loadWorkflow validation", () => {
  const result = loadWorkflow(featureWorkflow);
  assert.equal(result.name, featureWorkflow.name);
  assert.equal(result.nodes.length, featureWorkflow.nodes.length);
});

test("featureWorkflow: all node ids are unique", () => {
  const ids = featureWorkflow.nodes.map((n) => n.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "Node IDs must be unique");
});

// ---------------------------------------------------------------------------
// implement/fix effort — pinned to "medium" (see DECISIONS.md
// § effort-tuning-implement-fix)
// ---------------------------------------------------------------------------

test("featureWorkflow: implement and fix pin effort to 'medium'", () => {
  for (const nodeId of ["implement", "fix"] as const) {
    const node = featureWorkflow.nodes.find((n) => n.id === nodeId);
    assert.ok(node !== undefined, `${nodeId} node must exist`);
    assert.equal(
      node.effort,
      "medium",
      `${nodeId} must pin effort to "medium"`,
    );
  }
});

test("featureWorkflow: all dependsOn references point to known nodes", () => {
  const knownIds = new Set(featureWorkflow.nodes.map((n) => n.id));
  for (const node of featureWorkflow.nodes) {
    for (const dep of node.dependsOn ?? []) {
      assert.ok(
        knownIds.has(dep),
        `Node "${node.id}" depends on unknown node "${dep}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// verify node — autonomous, required, outcomeGate-gated (verify-autonomy change)
// ---------------------------------------------------------------------------

test("featureWorkflow: verify depends on fix, is required (non-optional), has no human gate", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined, "verify node must exist");
  assert.ok(node.dependsOn?.includes("fix"), "verify must depend on fix");
  assert.notEqual(
    node.optional,
    true,
    "verify must be required — a non-PASS outcome must block pr",
  );
  assert.equal(
    node.gate,
    undefined,
    "verify must have no human gate — it runs autonomously",
  );
});

test("featureWorkflow: verify uses sonnet (raised from haiku for authoring reasoning)", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined);
  assert.equal(node.model, "sonnet");
});

test("featureWorkflow: verify declares outcomeGate on verify-report.json's outcome field, passValues include DEFERRED_TO_CI", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined);
  // DEFERRED_TO_CI (added by the verify-defer-to-ci change, see DECISIONS.md
  // § verify-defer-to-ci-and-drop-diff-scoped-rerun) is a non-blocking outcome:
  // a confirmed pre-existing, diff-unrelated build break in Step 4 must not
  // hard-fail the node and block pr the way a genuine FAIL_BUILD does.
  assert.deepEqual(node.outcomeGate, {
    file: "verify-report.json",
    field: "outcome",
    passValues: ["PASS", "DEFERRED_TO_CI"],
  });
});

// Run 56962-1 forensic fix (bug 1): verify.md documents legitimate
// short-circuit paths (Docker unreachable at Step 0; unrecoverable stall
// with no usable report, ERROR_INFRA) where it explicitly instructs "Do NOT
// write a verify-plan.md — no authoring work happened." A hard produces
// requirement on verify-plan.md trips the DAG's produces-contract check even
// on these correct, prompt-following paths. verify-report.json remains
// load-bearing (already gated via outcomeGate above); only the unconditional
// verify-plan.md requirement is dropped.
test("featureWorkflow: verify's produces contract does not hard-require verify-plan.md (conditional per verify.md's short-circuit paths)", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "verify");
  assert.ok(node !== undefined);
  assert.deepEqual(node.produces, ["verify-report.json"]);
});

test("featureWorkflow: pr depends on both fix and verify", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "pr");
  assert.ok(node !== undefined);
  assert.ok(node.dependsOn?.includes("fix"));
  assert.ok(node.dependsOn?.includes("verify"));
});

// ---------------------------------------------------------------------------
// digest node — terminal-adjacent, parallel with pr (see DECISIONS.md
// § digest-node)
// ---------------------------------------------------------------------------

test("featureWorkflow: digest depends on both fix and verify (same deps as pr, runs in parallel)", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "digest");
  assert.ok(node !== undefined, "digest node must exist");
  assert.ok(node.dependsOn?.includes("fix"), "digest must depend on fix");
  assert.ok(node.dependsOn?.includes("verify"), "digest must depend on verify");
});

test("featureWorkflow: digest uses sonnet, produces knowledge-map.md, and has no gate", () => {
  const node = featureWorkflow.nodes.find((n) => n.id === "digest");
  assert.ok(node !== undefined);
  assert.equal(node.model, "sonnet");
  assert.deepEqual(node.produces, ["knowledge-map.md"]);
  assert.equal(
    node.gate,
    undefined,
    "digest must have no human gate — informational/read-only, same pattern as review",
  );
});
