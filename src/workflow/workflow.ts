/**
 * loadWorkflow — load-time validator for dagrunner workflow definitions.
 *
 * Validates at load, returns the workflow unchanged if valid, throws on any
 * error. Error messages always name the offending node and the exact problem.
 *
 * Checks (in order):
 *   1. No duplicate node IDs
 *   2. All dependsOn references point to known node IDs
 *   3. All model values are in {'haiku','sonnet'} or undefined
 *   4. All gate.onReject of form `rerun:<id>` reference known node IDs
 *   5. No cycles (Kahn's algorithm)
 *
 * Also exports validateClassifyOutput for runtime shape-checking of
 * classify.json artifacts.
 *
 * No external dependencies — hand-rolled validation only.
 */

import type { ClassifyOutput, Workflow } from "../core/types.js";

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

export function loadWorkflow(def: Workflow): Workflow {
  const knownIds = new Set<string>();

  // 1. Duplicate IDs
  for (const node of def.nodes) {
    if (knownIds.has(node.id)) {
      throw new Error(
        `loadWorkflow: duplicate node id "${node.id}" — node ids must be unique`,
      );
    }
    knownIds.add(node.id);
  }

  // 2. dependsOn references unknown node IDs
  for (const node of def.nodes) {
    if (node.dependsOn !== undefined) {
      for (const dep of node.dependsOn) {
        if (!knownIds.has(dep)) {
          throw new Error(
            `loadWorkflow: node "${node.id}" dependsOn unknown node "${dep}"`,
          );
        }
      }
    }
  }

  // 3. Model strings must be 'haiku' | 'sonnet' | undefined
  //    Read through `unknown` so TS doesn't narrow `node.model` to `never`
  //    (the declared type already excludes bad values; this check defends
  //    against runtime data that bypasses the type system).
  const validModels: ReadonlySet<string> = new Set(["haiku", "sonnet"]);
  for (const node of def.nodes) {
    const m: unknown = node.model;
    if (m !== undefined && (typeof m !== "string" || !validModels.has(m))) {
      throw new Error(
        `loadWorkflow: node "${node.id}" has invalid model value "${String(m)}" — must be 'haiku' | 'sonnet' or omitted`,
      );
    }
  }

  // 4. gate.onReject `rerun:<id>` must reference a known node
  for (const node of def.nodes) {
    const onReject: unknown = node.gate?.onReject;
    if (typeof onReject === "string" && onReject.startsWith("rerun:")) {
      const target = onReject.slice("rerun:".length);
      if (!knownIds.has(target)) {
        throw new Error(
          `loadWorkflow: node "${node.id}" gate.onReject references unknown node "${target}"`,
        );
      }
    }
  }

  // 5. Cycle detection via Kahn's algorithm
  //    Build adjacency list (dep → dependents) and in-degree map.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of def.nodes) {
    if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    if (!dependents.has(node.id)) dependents.set(node.id, []);
  }

  for (const node of def.nodes) {
    if (node.dependsOn !== undefined) {
      for (const dep of node.dependsOn) {
        const list = dependents.get(dep);
        if (list !== undefined) {
          list.push(node.id);
        }
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      }
    }
  }

  // Collect roots (in-degree 0)
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    processed++;
    const children = dependents.get(current) ?? [];
    for (const child of children) {
      const newDeg = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  if (processed !== def.nodes.length) {
    // Nodes remaining with in-degree > 0 are part of a cycle.
    const cycleNodes: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg > 0) cycleNodes.push(id);
    }
    throw new Error(
      `loadWorkflow: cycle detected — nodes involved: ${cycleNodes.map((n) => `"${n}"`).join(", ")}`,
    );
  }

  return def;
}

// ---------------------------------------------------------------------------
// validateClassifyOutput
// ---------------------------------------------------------------------------

/**
 * Runtime shape-guard for classify.json artifacts.
 * Throws a descriptive error if data does not match ClassifyOutput.
 */
export function validateClassifyOutput(data: unknown): ClassifyOutput {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      "validateClassifyOutput: expected a JSON object, got " +
        (data === null ? "null" : Array.isArray(data) ? "array" : typeof data),
    );
  }

  const obj = data as Record<string, unknown>;

  const boolFields = [
    "touches_public_api",
    "touches_runtime",
    "perf_sensitive",
    "touches_schema_or_proto",
  ] as const;

  for (const field of boolFields) {
    if (typeof obj[field] !== "boolean") {
      throw new Error(
        `validateClassifyOutput: field "${field}" must be boolean, got ${typeof obj[field]}`,
      );
    }
  }

  return {
    touches_public_api: obj["touches_public_api"] as boolean,
    touches_runtime: obj["touches_runtime"] as boolean,
    perf_sensitive: obj["perf_sensitive"] as boolean,
    touches_schema_or_proto: obj["touches_schema_or_proto"] as boolean,
  };
}

// ---------------------------------------------------------------------------
// Fixture workflows (consumed by the test-author)
// ---------------------------------------------------------------------------

/**
 * A minimal valid workflow: expand → implement (with dependency).
 */
export const FIXTURE_VALID: Workflow = {
  name: "fixture-valid",
  nodes: [
    {
      id: "expand",
      command: "/expand",
      model: "haiku",
    },
    {
      id: "implement",
      command: "/implement",
      dependsOn: ["expand"],
    },
  ],
};

/**
 * Invalid: node "classify" declares model "opus" which is not a ModelTier.
 * Cast through unknown to bypass compile-time narrowing — the runtime check
 * must catch what the type system cannot (e.g. data loaded from disk/JSON).
 */
export const FIXTURE_BAD_MODEL: Workflow = {
  name: "fixture-bad-model",
  nodes: [
    {
      id: "classify",
      command: "/classify",
      model: "opus" as unknown as "haiku",
    },
  ],
};

/**
 * Invalid: "expand" depends on "nonexistent" which is not declared.
 */
export const FIXTURE_BAD_DEPENDS: Workflow = {
  name: "fixture-bad-depends",
  nodes: [
    {
      id: "classify",
      command: "/classify",
      model: "haiku",
    },
    {
      id: "expand",
      command: "/expand",
      dependsOn: ["nonexistent"],
    },
  ],
};

/**
 * Invalid: two nodes share the id "classify".
 */
export const FIXTURE_DUPLICATE_ID: Workflow = {
  name: "fixture-duplicate-id",
  nodes: [
    {
      id: "classify",
      command: "/classify",
      model: "haiku",
    },
    {
      id: "classify",
      command: "/classify-again",
    },
  ],
};

/**
 * Invalid: "node-a" depends on "node-b" and "node-b" depends on "node-a".
 */
export const FIXTURE_CYCLE: Workflow = {
  name: "fixture-cycle",
  nodes: [
    {
      id: "node-a",
      command: "/step-a",
      dependsOn: ["node-b"],
    },
    {
      id: "node-b",
      command: "/step-b",
      dependsOn: ["node-a"],
    },
  ],
};
