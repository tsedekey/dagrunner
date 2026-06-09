/**
 * feature-workflow.ts — v1 thin-slice workflow definition.
 *
 * classify → expand-guide [review gate] → implement
 *
 * This is the ONLY workflow in v1. Additional workflows are config additions
 * on the proven engine.
 */

import type { Workflow } from "./types.js";

// ---------------------------------------------------------------------------
// classify.json JSON schema (used as SDK outputFormat schema)
// ---------------------------------------------------------------------------

export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    touches_public_api: { type: "boolean" },
    touches_runtime: { type: "boolean" },
    perf_sensitive: { type: "boolean" },
    touches_schema_or_proto: { type: "boolean" },
    needs_runtime: { type: "boolean" },
    risk: { type: "string", enum: ["low", "med", "high"] },
  },
  required: [
    "touches_public_api",
    "touches_runtime",
    "perf_sensitive",
    "touches_schema_or_proto",
    "needs_runtime",
    "risk",
  ],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// featureWorkflow
// ---------------------------------------------------------------------------

export const featureWorkflow: Workflow = {
  name: "feature",
  nodes: [
    {
      id: "classify",
      model: "haiku",
      command: "/classify",
      outputSchema: { ...CLASSIFY_SCHEMA },
      produces: ["classify.json"],
    },
    {
      id: "expand-guide",
      dependsOn: ["classify"],
      command: "/expand-guide",
      produces: ["guide.md"],
      gate: { maxIterations: 10, onReject: "revise-self" },
    },
    {
      id: "implement",
      dependsOn: ["expand-guide"],
      command: "/implement",
      produces: ["summary.md"],
    },
  ],
};
