/**
 * Shared TypeScript types for dagrunner workflow definitions.
 *
 * This file has ZERO runtime dependencies — no SDK, no Node built-ins.
 * It is the contract layer: precise unions over string/any everywhere.
 */

// ---------------------------------------------------------------------------
// Model tiers (validated at load time)
// ---------------------------------------------------------------------------

export type ModelTier = "haiku" | "sonnet" | "opus";

// ---------------------------------------------------------------------------
// Artifact accessor context (passed to `when` predicates)
// ---------------------------------------------------------------------------

/**
 * Read-only accessor for upstream node artifacts. Artifacts are the ONLY
 * cross-node channel — no in-memory upstream returns, no shared state.
 */
export type Ctx = {
  /** Parse and return the JSON artifact produced by nodeId. */
  json(nodeId: string): unknown;
  /** Read a named text artifact produced by nodeId. */
  read(nodeId: string, file: string): string;
  /** Return the artifact directory path for nodeId. */
  dir(nodeId: string): string;
};

// ---------------------------------------------------------------------------
// Gate config
// ---------------------------------------------------------------------------

export type GateConfig = {
  /** Max human-review iterations before a forced terminal choice. Default 10. */
  maxIterations?: number;
  /**
   * On reject: revise-self (default) or re-run a specific prior node.
   * Template literal enforces `rerun:<id>` shape at the type level.
   */
  onReject?: "revise-self" | `rerun:${string}`;
  /**
   * When true, quitting the interactive gate marks the node skipped and continues
   * the run instead of halting. Used for post-PR gates that must never block shipping.
   */
  skippable?: boolean;
};

// ---------------------------------------------------------------------------
// Loop config
// ---------------------------------------------------------------------------

export type LoopConfig = {
  /** Hard ceiling on loop iterations. */
  maxIterations: number;
  /** Shell command string; exit 0 = loop passes. */
  until: string;
  /**
   * Behaviour when maxIterations is exhausted without the shell gate passing.
   * Default 'gate'.
   */
  onExhausted?: "fail" | "gate" | "continue";
};

// ---------------------------------------------------------------------------
// Join rule
// ---------------------------------------------------------------------------

export type JoinRule = "none-failed-min-one-success";

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

export type Node = {
  /** Unique node identifier within the workflow. */
  id: string;
  /** IDs of nodes that must complete before this node is eligible to run. */
  dependsOn?: string[];
  /** Predicate evaluated at scheduling time; false → node is skipped. */
  when?: (ctx: Ctx) => boolean;
  /**
   * Slash command or skill reference, e.g. "/expand" or "skill:review".
   */
  command: string;
  /** Model tier. Omit = unpinned (opusplan chooses). */
  model?: ModelTier;
  /** Tool names auto-allowed for this node's SDK session. */
  allowedTools?: string[];
  /** JSON schema for structured output. */
  outputSchema?: Record<string, unknown>;
  /** Artifact files this node must produce; verified post-run by the runner. */
  produces?: string[];
  /** When true the node must emit valid JSON; runner verifies. */
  producesJson?: boolean;
  /** Human-review gate config. */
  gate?: GateConfig;
  /** Autonomous loop config (stop-hook driven). */
  loop?: LoopConfig;
  /** When true, a failed run degrades this node to 'skipped' instead of 'failed'. */
  optional?: boolean;
  /** How to proceed when joining from multiple parallel predecessors. */
  joinRule?: JoinRule;
  /** Max infra/transient retries before marking the node failed. Default 2. */
  maxRetries?: number;
  /** Per-node spend ceiling in USD (for unpinned/Opus-eligible nodes). */
  maxBudget?: number;
  /**
   * Shell command to run inside the worktree before each `git commit` the agent
   * makes. Typical use: `"./mvnw spotless:apply --no-transfer-progress"` for
   * Camunda Java nodes. A non-zero exit blocks the commit (fail loud).
   */
  formatCommand?: string;
  /** Per-node hook scripts. */
  hooks?: { stop?: string };
  /**
   * Custom revision prompt injected when gate feedback is applied.
   * Overrides the default "rewrite {artifact}" prompt. Use `{artifactsDir}`
   * as a placeholder for the absolute per-node artifacts directory path.
   * Required for fix node where the product is the worktree diff, not a single artifact.
   */
  revisionInstruction?: string;
};

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export type Workflow = {
  /** Human-readable workflow name (e.g. "feature-pipeline"). */
  name: string;
  /** Ordered list of node definitions. */
  nodes: Node[];
  /** Max concurrent SDK sessions. Default 6. */
  maxParallel?: number;
};
