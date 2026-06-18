/**
 * feature-workflow.test.ts — schema-contract tests for CLASSIFY_SCHEMA,
 * FINDINGS_SCHEMA, and featureWorkflow validity.
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

import {
  CLASSIFY_SCHEMA,
  FINDINGS_SCHEMA,
  featureWorkflow,
} from "./feature-workflow.js";
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
// CLASSIFY_SCHEMA well-formedness
// ---------------------------------------------------------------------------

test("CLASSIFY_SCHEMA: required fields are a subset of defined properties", () => {
  const props = Object.keys(CLASSIFY_SCHEMA.properties);
  for (const req of CLASSIFY_SCHEMA.required) {
    assert.ok(props.includes(req), `required field "${req}" not in properties`);
  }
});

test("CLASSIFY_SCHEMA: additionalProperties:false is present", () => {
  assert.equal(CLASSIFY_SCHEMA.additionalProperties, false);
});

test("CLASSIFY_SCHEMA: all property types are 'boolean'", () => {
  for (const [name, prop] of Object.entries(CLASSIFY_SCHEMA.properties)) {
    assert.equal(
      (prop as Record<string, unknown>)["type"],
      "boolean",
      `property "${name}" must have type "boolean"`,
    );
  }
});

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

test("FINDINGS_SCHEMA: manual_test_recommendation is a required top-level field", () => {
  assert.ok(
    FINDINGS_SCHEMA.required.includes("manual_test_recommendation"),
    "manual_test_recommendation must be in top-level required",
  );
  const rec = FINDINGS_SCHEMA.properties.manual_test_recommendation as Record<
    string,
    unknown
  >;
  assert.equal(rec["type"], "object");
  const recRequired = rec["required"] as string[];
  assert.ok(recRequired.includes("recommended"), "recommended required");
  assert.ok(recRequired.includes("surface"), "surface required");
  assert.ok(recRequired.includes("rationale"), "rationale required");
});

test("FINDINGS_SCHEMA: manual_test_recommendation surface enum is ui|api|none", () => {
  const rec = FINDINGS_SCHEMA.properties.manual_test_recommendation as Record<
    string,
    unknown
  >;
  const props = rec["properties"] as Record<string, Record<string, unknown>>;
  const surfaceEnum = props["surface"]?.["enum"] as unknown[];
  assert.deepEqual(
    [...surfaceEnum].sort(),
    ["api", "none", "ui"],
    "surface enum must be exactly ui|api|none",
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
// CLASSIFY_SCHEMA: conforming and non-conforming fixtures
// ---------------------------------------------------------------------------

const VALID_CLASSIFY = {
  touches_public_api: true,
  touches_runtime: false,
  perf_sensitive: true,
  touches_schema_or_proto: false,
};

test("CLASSIFY_SCHEMA: valid fixture conforms", () => {
  assertValid(
    VALID_CLASSIFY,
    CLASSIFY_SCHEMA as unknown as Schema,
    "CLASSIFY_SCHEMA valid",
  );
});

test("CLASSIFY_SCHEMA: missing required field fails validation (teeth)", () => {
  const missing = {
    touches_public_api: true,
    touches_runtime: false,
    // perf_sensitive missing
    touches_schema_or_proto: false,
  };
  assertInvalid(
    missing,
    CLASSIFY_SCHEMA as unknown as Schema,
    "CLASSIFY_SCHEMA missing field",
  );
});

test("CLASSIFY_SCHEMA: additional property fails validation (teeth)", () => {
  const extra = { ...VALID_CLASSIFY, extra_field: true };
  assertInvalid(
    extra,
    CLASSIFY_SCHEMA as unknown as Schema,
    "CLASSIFY_SCHEMA extra field",
  );
});

test("CLASSIFY_SCHEMA: wrong type for field fails validation (teeth)", () => {
  const wrongType = { ...VALID_CLASSIFY, touches_public_api: "yes" };
  assertInvalid(
    wrongType,
    CLASSIFY_SCHEMA as unknown as Schema,
    "CLASSIFY_SCHEMA wrong type",
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
  manual_test_recommendation: {
    recommended: false,
    surface: "none",
    rationale: "change is internal — no observable UI or API surface",
  },
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

test("FINDINGS_SCHEMA: missing manual_test_recommendation fails (teeth)", () => {
  const { manual_test_recommendation: _, ...missing } = VALID_FINDINGS;
  assertInvalid(
    missing,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA missing manual_test_recommendation",
  );
});

test("FINDINGS_SCHEMA: invalid manual_test_recommendation surface enum fails (teeth)", () => {
  const bad = {
    ...VALID_FINDINGS,
    manual_test_recommendation: {
      recommended: false,
      surface: "logs", // not in enum
      rationale: "test",
    },
  };
  assertInvalid(
    bad,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA bad surface enum",
  );
});

test("FINDINGS_SCHEMA: manual_test_recommendation with api surface conforms", () => {
  const good = {
    ...VALID_FINDINGS,
    triage: { ...VALID_FINDINGS.triage, touches_public_api: true },
    manual_test_recommendation: {
      recommended: true,
      surface: "api",
      rationale: "adds a new public REST endpoint",
    },
  };
  assertValid(
    good,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA api surface",
  );
});

test("FINDINGS_SCHEMA: manual_test_recommendation with ui surface conforms", () => {
  const good = {
    ...VALID_FINDINGS,
    triage: { ...VALID_FINDINGS.triage, touches_ui: true },
    manual_test_recommendation: {
      recommended: true,
      surface: "ui",
      rationale: "modifies a user-facing component",
    },
  };
  assertValid(
    good,
    FINDINGS_SCHEMA as unknown as Schema,
    "FINDINGS_SCHEMA ui surface",
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
