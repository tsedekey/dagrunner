/**
 * findings-schema.ts — the single source of truth for the `review` node's
 * findings.json shape (previously prose-only in payload/skills/review/SKILL.md).
 *
 * Used as the Copilot runner's `responseSchema` (strict JSON schema: every
 * property required, no additional properties) and by `validateFindings` to
 * prove a produced findings.json is schema-valid. Keep in sync with the
 * "Step 4 — Write findings.json" section of the review skill.
 */

const str = { type: "string" } as const;
const bool = { type: "boolean" } as const;

export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "run_id",
    "timestamp",
    "triage",
    "reviewers_run",
    "reviewers_skipped",
    "adversarial_verifier_run",
    "findings",
  ],
  properties: {
    run_id: str,
    timestamp: str,
    triage: {
      type: "object",
      additionalProperties: false,
      required: [
        "touches_public_api",
        "touches_runtime",
        "touches_schema_or_proto",
        "performance_sensitive",
        "touches_ui",
      ],
      properties: {
        touches_public_api: bool,
        touches_runtime: bool,
        touches_schema_or_proto: bool,
        performance_sensitive: bool,
        touches_ui: bool,
      },
    },
    reviewers_run: { type: "array", items: str },
    reviewers_skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason"],
        properties: { name: str, reason: str },
      },
    },
    adversarial_verifier_run: bool,
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "reviewer_dimension",
          "severity",
          "confidence",
          "file",
          "line",
          "claim",
          "grounded",
        ],
        properties: {
          reviewer_dimension: {
            type: "string",
            enum: [
              "correctness",
              "test-adequacy",
              "api-stability",
              "distributed-systems",
              "performance",
              "migration-safety",
            ],
          },
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          confidence: { type: "string", enum: ["high", "med", "low"] },
          file: str,
          line: { type: "integer" },
          claim: str,
          grounded: bool,
        },
      },
    },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Minimal structural validator for the findings shape. Returns a list of
 * problems (empty = valid). Hand-rolled (no schema library); checks exactly
 * what FINDINGS_SCHEMA declares: required keys, types, enums, no extras.
 */
export function validateFindings(doc: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(doc)) return ["findings.json is not an object"];
  const exact = (path: string, o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) if (!(k in o)) errs.push(`${path}.${k} missing`);
    for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${path}.${k} unexpected`);
  };
  exact("$", doc, ["run_id", "timestamp", "triage", "reviewers_run", "reviewers_skipped", "adversarial_verifier_run", "findings"]);
  if (typeof doc["run_id"] !== "string") errs.push("$.run_id not a string");
  if (typeof doc["timestamp"] !== "string") errs.push("$.timestamp not a string");
  if (typeof doc["adversarial_verifier_run"] !== "boolean") errs.push("$.adversarial_verifier_run not a boolean");

  const triage = doc["triage"];
  if (!isObj(triage)) errs.push("$.triage not an object");
  else {
    const keys = ["touches_public_api", "touches_runtime", "touches_schema_or_proto", "performance_sensitive", "touches_ui"];
    exact("$.triage", triage, keys);
    for (const k of keys) if (typeof triage[k] !== "boolean") errs.push(`$.triage.${k} not a boolean`);
  }

  const run = doc["reviewers_run"];
  if (!Array.isArray(run) || !run.every((x) => typeof x === "string")) errs.push("$.reviewers_run not a string array");

  const skipped = doc["reviewers_skipped"];
  if (!Array.isArray(skipped)) errs.push("$.reviewers_skipped not an array");
  else
    skipped.forEach((s, i) => {
      if (!isObj(s)) return void errs.push(`$.reviewers_skipped[${i}] not an object`);
      exact(`$.reviewers_skipped[${i}]`, s, ["name", "reason"]);
      if (typeof s["name"] !== "string" || typeof s["reason"] !== "string") errs.push(`$.reviewers_skipped[${i}] name/reason not strings`);
    });

  const dims = ["correctness", "test-adequacy", "api-stability", "distributed-systems", "performance", "migration-safety"];
  const findings = doc["findings"];
  if (!Array.isArray(findings)) errs.push("$.findings not an array");
  else
    findings.forEach((f, i) => {
      const p = `$.findings[${i}]`;
      if (!isObj(f)) return void errs.push(`${p} not an object`);
      exact(p, f, ["reviewer_dimension", "severity", "confidence", "file", "line", "claim", "grounded"]);
      if (!dims.includes(String(f["reviewer_dimension"]))) errs.push(`${p}.reviewer_dimension invalid`);
      if (!["blocker", "major", "minor", "nit"].includes(String(f["severity"]))) errs.push(`${p}.severity invalid`);
      if (!["high", "med", "low"].includes(String(f["confidence"]))) errs.push(`${p}.confidence invalid`);
      if (typeof f["file"] !== "string") errs.push(`${p}.file not a string`);
      if (!Number.isInteger(f["line"])) errs.push(`${p}.line not an integer`);
      if (typeof f["claim"] !== "string") errs.push(`${p}.claim not a string`);
      if (typeof f["grounded"] !== "boolean") errs.push(`${p}.grounded not a boolean`);
    });
  return errs;
}
