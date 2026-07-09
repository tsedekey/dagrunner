/**
 * loadWorkflow — load-time validator for dagrunner workflow definitions.
 *
 * Validates at load, returns the workflow unchanged if valid, throws on any
 * error. Error messages always name the offending node and the exact problem.
 *
 * Checks (in order):
 *   1. No duplicate node IDs
 *   2. All dependsOn references point to known node IDs
 *   3. All model values are in {'haiku','sonnet','opus'} or undefined
 *   3b. All effort values are in {'low','medium','high','xhigh','max'} or undefined
 *   4. All gate.onReject of form `rerun:<id>` reference known node IDs
 *   5. No cycles (Kahn's algorithm)
 *
 * No external dependencies — hand-rolled validation only.
 */

import type { Workflow } from "../core/types.js";

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

  // 3. Model strings must be 'haiku' | 'sonnet' | 'opus' | undefined
  //    Read through `unknown` so TS doesn't narrow `node.model` to `never`
  //    (the declared type already excludes bad values; this check defends
  //    against runtime data that bypasses the type system).
  const validModels: ReadonlySet<string> = new Set(["haiku", "sonnet", "opus"]);
  for (const node of def.nodes) {
    const m: unknown = node.model;
    if (m !== undefined && (typeof m !== "string" || !validModels.has(m))) {
      throw new Error(
        `loadWorkflow: node "${node.id}" has invalid model value "${String(m)}" — must be 'haiku' | 'sonnet' | 'opus' or omitted`,
      );
    }
  }

  // 3b. Effort strings must be 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
  //     Same "typed at load" reasoning as the model check above: read through
  //     `unknown` so a bad runtime value (not just a bad compile-time one) is
  //     caught with a loud load error, never a silent SDK default.
  const validEfforts: ReadonlySet<string> = new Set([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  for (const node of def.nodes) {
    const e: unknown = node.effort;
    if (e !== undefined && (typeof e !== "string" || !validEfforts.has(e))) {
      throw new Error(
        `loadWorkflow: node "${node.id}" has invalid effort value "${String(e)}" — must be 'low' | 'medium' | 'high' | 'xhigh' | 'max' or omitted`,
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

  // 4b. outcomeGate shape: file/field non-empty strings, passValues non-empty
  //     array of non-empty strings. A typo here (empty passValues → every
  //     outcome fails; empty file → nothing to read) is a load error, not a
  //     runtime surprise (CLAUDE.md "Typed at load").
  for (const node of def.nodes) {
    const gate: unknown = node.outcomeGate;
    if (gate === undefined) continue;
    if (typeof gate !== "object" || gate === null) {
      throw new Error(
        `loadWorkflow: node "${node.id}" outcomeGate must be an object`,
      );
    }
    const g = gate as Record<string, unknown>;
    if (typeof g["file"] !== "string" || g["file"] === "") {
      throw new Error(
        `loadWorkflow: node "${node.id}" outcomeGate.file must be a non-empty string`,
      );
    }
    if (typeof g["field"] !== "string" || g["field"] === "") {
      throw new Error(
        `loadWorkflow: node "${node.id}" outcomeGate.field must be a non-empty string`,
      );
    }
    if (
      !Array.isArray(g["passValues"]) ||
      (g["passValues"] as unknown[]).length === 0 ||
      !(g["passValues"] as unknown[]).every(
        (v) => typeof v === "string" && v !== "",
      )
    ) {
      throw new Error(
        `loadWorkflow: node "${node.id}" outcomeGate.passValues must be a non-empty array of non-empty strings`,
      );
    }
  }

  // 4c. noPlaceholders shape: when present, must be a non-empty array of
  //     non-empty strings — same "typed at load" reasoning as outcomeGate
  //     above (an empty array is a no-op that misleadingly reads as "checked").
  for (const node of def.nodes) {
    const np: unknown = node.noPlaceholders;
    if (np === undefined) continue;
    if (
      !Array.isArray(np) ||
      np.length === 0 ||
      !np.every((v) => typeof v === "string" && v !== "")
    ) {
      throw new Error(
        `loadWorkflow: node "${node.id}" noPlaceholders must be a non-empty array of non-empty strings`,
      );
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
// Fixture workflows (consumed by tests)
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
 * Invalid: node "step-a" declares model "gemini" which is not a ModelTier.
 * Cast through unknown to bypass compile-time narrowing — the runtime check
 * must catch what the type system cannot (e.g. data loaded from disk/JSON).
 */
export const FIXTURE_BAD_MODEL: Workflow = {
  name: "fixture-bad-model",
  nodes: [
    {
      id: "step-a",
      command: "/step-a",
      model: "gemini" as unknown as "haiku",
    },
  ],
};

/**
 * Invalid: node "step-a" declares effort "ultra" which is not an EffortLevel.
 * Cast through unknown to bypass compile-time narrowing, same rationale as
 * FIXTURE_BAD_MODEL above.
 */
export const FIXTURE_BAD_EFFORT: Workflow = {
  name: "fixture-bad-effort",
  nodes: [
    {
      id: "step-a",
      command: "/step-a",
      effort: "ultra" as unknown as "medium",
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
      id: "step-a",
      command: "/step-a",
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
 * Invalid: two nodes share the id "step-a".
 */
export const FIXTURE_DUPLICATE_ID: Workflow = {
  name: "fixture-duplicate-id",
  nodes: [
    {
      id: "step-a",
      command: "/step-a",
      model: "haiku",
    },
    {
      id: "step-a",
      command: "/step-b",
    },
  ],
};

/**
 * Invalid: "step-a" declares outcomeGate.passValues as an empty array —
 * every outcome would fail the gate, which is never intentional.
 */
export const FIXTURE_BAD_OUTCOME_GATE: Workflow = {
  name: "fixture-bad-outcome-gate",
  nodes: [
    {
      id: "step-a",
      command: "/step-a",
      produces: ["report.json"],
      outcomeGate: { file: "report.json", field: "outcome", passValues: [] },
    },
  ],
};

/**
 * Invalid: "step-a" declares noPlaceholders as an empty array — a no-op that
 * would misleadingly read as "this file is checked" when nothing is scanned.
 */
export const FIXTURE_BAD_NO_PLACEHOLDERS: Workflow = {
  name: "fixture-bad-no-placeholders",
  nodes: [
    {
      id: "step-a",
      command: "/step-a",
      produces: ["guide.md"],
      noPlaceholders: [],
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
