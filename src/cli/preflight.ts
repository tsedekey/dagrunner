/**
 * preflight.ts — pre-run sanity checks (Phase 2a D1).
 *
 * Runs before the DAG starts. Fails loud on any misconfiguration so the
 * runtime permission model, sandbox, and environment are correct before
 * any node mutates the real repo.
 *
 * Called by: `dagrun preflight` (standalone) and `cmdStart` (always).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { DagrunnerConfig } from "../config/xdg.js";
import {
  readSourcePassthrough,
  buildSeededSettings,
  readWorkProfileMcpServers,
} from "../config/settings-seed.js";
import { EXPECTED_CLAUDE_CLI_VERSION } from "../config/versions.js";

// ---------------------------------------------------------------------------
// PreflightResult
// ---------------------------------------------------------------------------

export type PreflightResult = { ok: true } | { ok: false; failures: string[] };

// ---------------------------------------------------------------------------
// parseClaudeVersion / checkClaudeCliVersion — pure, TDD-able seam
// ---------------------------------------------------------------------------

/**
 * Extract the semver from `claude --version` output.
 * Throws (fail-loud) if no semver is found — never silently passes.
 */
export function parseClaudeVersion(output: string): string {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(
      `Cannot parse claude version from output: "${output.trim()}"`,
    );
  }
  return match[1]!;
}

/**
 * Pure: compare the raw `claude --version` output against the expected pin.
 * Returns a list of failure messages (empty = ok).
 * skip=true bypasses the check (DAGRUN_SKIP_CLI_VERSION_CHECK=1).
 */
export function checkClaudeCliVersion(
  versionOutput: string,
  expected: string,
  skip: boolean,
): string[] {
  if (skip) return [];
  let found: string;
  try {
    found = parseClaudeVersion(versionOutput);
  } catch {
    return [
      `Cannot parse claude CLI version from output: "${versionOutput.trim()}". ` +
        `Set DAGRUN_SKIP_CLI_VERSION_CHECK=1 to bypass.`,
    ];
  }
  if (found !== expected) {
    return [
      `claude CLI version mismatch: pinned ${expected}, found ${found}. ` +
        `Install the pinned version, or set DAGRUN_SKIP_CLI_VERSION_CHECK=1 to bypass.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

/**
 * Verify the environment is safe to start a run.
 *
 * @param config   Resolved dagrunner config (DEVHARNESS_SRC must be set).
 * @param homeDir  Resolved dagrunner home directory.
 * @param opts     Optional overrides (base branch, expected API key absence, etc.).
 */
export function runPreflight(
  config: DagrunnerConfig,
  homeDir: string,
  opts: {
    /** Expected base branch in DEVHARNESS_SRC. Default: "main". */
    baseBranch?: string;
    /** When true, ANTHROPIC_API_KEY must be absent (enterprise managed-auth). */
    requireManagedAuth?: boolean;
  } = {},
): PreflightResult {
  const failures: string[] = [];
  const baseBranch = opts.baseBranch ?? "main";

  // ------------------------------------------------------------------
  // 1. DEVHARNESS_SRC resolves and is a git repo
  // ------------------------------------------------------------------
  if (!existsSync(config.DEVHARNESS_SRC)) {
    failures.push(`DEVHARNESS_SRC does not exist: "${config.DEVHARNESS_SRC}"`);
  } else {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: config.DEVHARNESS_SRC,
        stdio: "pipe",
      });
    } catch {
      failures.push(
        `DEVHARNESS_SRC is not a git repository: "${config.DEVHARNESS_SRC}"`,
      );
    }

    // 2. On expected base branch
    if (existsSync(config.DEVHARNESS_SRC)) {
      try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: config.DEVHARNESS_SRC,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
        if (branch !== baseBranch) {
          failures.push(
            `DEVHARNESS_SRC is on branch "${branch}", expected "${baseBranch}". ` +
              `Run: git -C "${config.DEVHARNESS_SRC}" checkout ${baseBranch}`,
          );
        }
      } catch {
        failures.push(
          `Could not determine current branch in DEVHARNESS_SRC: "${config.DEVHARNESS_SRC}"`,
        );
      }

      // 3. Git working tree clean (no uncommitted changes)
      try {
        const status = execSync("git status --porcelain", {
          cwd: config.DEVHARNESS_SRC,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
        if (status !== "") {
          failures.push(
            `DEVHARNESS_SRC has uncommitted changes. Commit or stash them first.\n` +
              `  ${status.split("\n").slice(0, 5).join("\n  ")}`,
          );
        }
      } catch {
        failures.push(
          `Could not check git status in DEVHARNESS_SRC: "${config.DEVHARNESS_SRC}"`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. Dagrunner home exists and has required subdirs
  // ------------------------------------------------------------------
  for (const sub of ["runs", "worktrees", "inbox", "store"]) {
    if (!existsSync(join(homeDir, sub))) {
      failures.push(
        `Dagrunner home missing "${sub}" directory: ${join(homeDir, sub)}. Run: dagrun init`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 5. At least one auth credential is present
  // ------------------------------------------------------------------
  const hasApiKey =
    typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
    process.env["ANTHROPIC_API_KEY"] !== "";
  const hasAuthToken =
    typeof process.env["ANTHROPIC_AUTH_TOKEN"] === "string" &&
    process.env["ANTHROPIC_AUTH_TOKEN"] !== "";
  const hasClaudeAuth = (() => {
    try {
      const out = execSync("claude auth status 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      });
      return (
        out.includes('"loggedIn": true') || out.includes('"loggedIn":true')
      );
    } catch {
      return false;
    }
  })();

  if (!hasApiKey && !hasAuthToken && !hasClaudeAuth) {
    failures.push(
      `No Anthropic auth found. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or run \`claude login\`.`,
    );
  }

  // When enterprise managed-auth is expected, ANTHROPIC_API_KEY must NOT be set.
  if (opts.requireManagedAuth === true && hasApiKey) {
    failures.push(
      `Enterprise managed-auth required but ANTHROPIC_API_KEY is set. Unset it and use managed credentials.`,
    );
  }

  // ------------------------------------------------------------------
  // 6. macOS Seatbelt sandbox availability (advisory warning, not hard fail)
  //    The sandbox key is darwin-only; we only check availability, not activation.
  // ------------------------------------------------------------------
  if (process.platform === "darwin") {
    try {
      execSync("which sandbox-exec", { stdio: "pipe" });
      // sandbox-exec present — seatbelt available
    } catch {
      // Not a hard fail — sandbox.enabled in settings.json will still work
      // via Claude Code's built-in sandbox wrapper on supported macOS versions.
    }
  }

  // ------------------------------------------------------------------
  // 7. claude CLI is on PATH + version matches pin
  // ------------------------------------------------------------------
  try {
    execSync("which claude", { stdio: "pipe" });
    // Version check — fail loud on drift; bypass with DAGRUN_SKIP_CLI_VERSION_CHECK=1
    try {
      const versionOut = execSync("claude --version", {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      });
      const skip = process.env["DAGRUN_SKIP_CLI_VERSION_CHECK"] === "1";
      failures.push(
        ...checkClaudeCliVersion(versionOut, EXPECTED_CLAUDE_CLI_VERSION, skip),
      );
    } catch {
      if (process.env["DAGRUN_SKIP_CLI_VERSION_CHECK"] !== "1") {
        failures.push(
          `Cannot run "claude --version". Set DAGRUN_SKIP_CLI_VERSION_CHECK=1 to bypass.`,
        );
      }
    }
  } catch {
    failures.push(
      `"claude" CLI not found on PATH. Install Claude Code: https://claude.ai/code`,
    );
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}

// ---------------------------------------------------------------------------
// printPreflightResult — human-readable output
// ---------------------------------------------------------------------------

export function printPreflightResult(result: PreflightResult): void {
  if (result.ok) {
    process.stdout.write("🚀 dagrun preflight: all checks passed\n");
    return;
  }

  process.stderr.write(
    `❌ dagrun preflight: ${result.failures.length} check(s) failed:\n\n`,
  );
  for (let i = 0; i < result.failures.length; i++) {
    process.stderr.write(`  ⚠️  [${i + 1}] ${result.failures[i]}\n`);
  }
  process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// Agent context — what nodes will see inside the worktree session
// ---------------------------------------------------------------------------

/** Per-item source attribution. */
export type CtxSource = "dagrunner" | "DEVHARNESS_SRC";

export interface AgentContextItem {
  name: string;
  source: CtxSource;
}

export interface AgentContext {
  commands: AgentContextItem[];
  agents: AgentContextItem[];
  skills: AgentContextItem[];
  env: Record<string, string>;
  mcpServers: string[];
  hooks: string[];
  /** The full settings.json template (runDir shown as placeholder). */
  seededSettings: Record<string, unknown>;
}

function listItems(
  primaryDir: string,
  primarySource: CtxSource,
  secondaryDir: string,
  secondarySource: CtxSource,
): AgentContextItem[] {
  const read = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map((f) => basename(f, ".md"));
    } catch {
      return [];
    }
  };
  const primary = new Set(read(primaryDir));
  const items: AgentContextItem[] = [...primary]
    .sort()
    .map((name) => ({ name, source: primarySource }));
  for (const name of read(secondaryDir).sort()) {
    if (!primary.has(name)) items.push({ name, source: secondarySource });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * Derive the merged agent context that a node session will see.
 * Uses buildSeededSettings (same as run-engine) so the display is always accurate.
 */
export function getAgentContext(
  dagrunnerRoot: string,
  config: DagrunnerConfig,
): AgentContext {
  const passthrough = readSourcePassthrough(config.DEVHARNESS_SRC);

  const commands = listItems(
    join(dagrunnerRoot, "payload", "commands"),
    "dagrunner",
    join(config.DEVHARNESS_SRC, ".claude", "commands"),
    "DEVHARNESS_SRC",
  );
  const agents = listItems(
    join(dagrunnerRoot, "payload", "agents"),
    "dagrunner",
    join(config.DEVHARNESS_SRC, ".claude", "agents"),
    "DEVHARNESS_SRC",
  );
  // Skills: dagrunner has none; DEVHARNESS_SRC's survive the git checkout
  const skills = listItems(
    join(config.DEVHARNESS_SRC, ".claude", "skills"),
    "DEVHARNESS_SRC",
    "",
    "dagrunner",
  ).filter((s) => s.name !== "README");

  // MCP servers: merge DEVHARNESS_SRC passthrough + work-profile servers.
  // Work-profile servers are injected via query() options (not settings.json).
  const devharnessMcp =
    passthrough.mcpServers !== null &&
    typeof passthrough.mcpServers === "object"
      ? Object.keys(passthrough.mcpServers as Record<string, unknown>)
      : [];
  const workProfileMcpKeys = Object.keys(
    readWorkProfileMcpServers(homedir(), config.DEVHARNESS_SRC),
  );
  const mcpServers = [...devharnessMcp, ...workProfileMcpKeys];

  const seededSettings = buildSeededSettings({
    runDir: "<run-dir>",
    homeDir: homedir(),
    tmpDir: tmpdir(),
    passthrough,
  });

  return {
    commands,
    agents,
    skills,
    env: passthrough.env,
    mcpServers,
    hooks: ["SessionStart", "Stop", "PostToolUse", "SessionEnd"],
    seededSettings,
  };
}

/**
 * Write the full agent context to a markdown file in cacheDir.
 * Returns the path written.
 */
export function writeAgentContextFile(
  ctx: AgentContext,
  config: DagrunnerConfig,
  dagrunnerRoot: string,
  cacheDir: string,
): string {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = join(cacheDir, "preflight-context.md");

  const bySource = (items: AgentContextItem[], src: CtxSource) =>
    items.filter((i) => i.source === src).map((i) => i.name);

  const dagrunnerCmds = bySource(ctx.commands, "dagrunner");
  const srcCmds = bySource(ctx.commands, "DEVHARNESS_SRC");
  const dagrunnerAgents = bySource(ctx.agents, "dagrunner");
  const srcAgents = bySource(ctx.agents, "DEVHARNESS_SRC");

  const lines: string[] = [];

  lines.push(`# dagrun Agent Context`);
  lines.push(``);
  lines.push(
    `Generated by \`dagrun preflight\` on ${new Date().toISOString()}.`,
  );
  lines.push(`This file shows what every node session will have access to.`);
  lines.push(``);
  lines.push(`| Property | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| dagrunner root | \`${dagrunnerRoot}\` |`);
  lines.push(`| DEVHARNESS_SRC | \`${config.DEVHARNESS_SRC}\` |`);
  lines.push(``);

  lines.push(`## Quick summary`);
  lines.push(``);
  lines.push(`| | Count | Sources |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(
    `| Commands | ${ctx.commands.length} | dagrunner: ${dagrunnerCmds.length}, DEVHARNESS_SRC: ${srcCmds.length} |`,
  );
  lines.push(
    `| Agents | ${ctx.agents.length} | dagrunner: ${dagrunnerAgents.length}, DEVHARNESS_SRC: ${srcAgents.length} |`,
  );
  lines.push(`| Skills | ${ctx.skills.length} | all from DEVHARNESS_SRC |`);
  lines.push(
    `| MCP servers | ${ctx.mcpServers.length} | ${ctx.mcpServers.length === 0 ? "none" : ctx.mcpServers.join(", ")} |`,
  );
  lines.push(
    `| Env injected | ${Object.keys(ctx.env).length} | ${Object.keys(ctx.env).length === 0 ? "none" : Object.keys(ctx.env).join(", ")} |`,
  );
  lines.push(``);

  lines.push(`## Commands`);
  lines.push(``);
  lines.push(`Slash commands available inside node sessions.`);
  lines.push(``);
  lines.push(`| Command | Source |`);
  lines.push(`| --- | --- |`);
  for (const item of ctx.commands) {
    lines.push(`| \`/${item.name}\` | ${item.source} |`);
  }
  lines.push(``);

  lines.push(`## Agents`);
  lines.push(``);
  lines.push(`Subagent specs available for fan-out within node sessions.`);
  lines.push(``);
  lines.push(`| Agent | Source |`);
  lines.push(`| --- | --- |`);
  for (const item of ctx.agents) {
    lines.push(`| \`${item.name}\` | ${item.source} |`);
  }
  lines.push(``);

  lines.push(`## Skills`);
  lines.push(``);
  lines.push(
    `Skill directories available via \`/\` prefix in node sessions (from DEVHARNESS_SRC).`,
  );
  lines.push(``);
  if (ctx.skills.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`| Skill | Source |`);
    lines.push(`| --- | --- |`);
    for (const item of ctx.skills) {
      lines.push(`| \`${item.name}\` | ${item.source} |`);
    }
  }
  lines.push(``);

  lines.push(`## MCP Servers`);
  lines.push(``);
  if (ctx.mcpServers.length === 0) {
    lines.push(`_None configured._`);
  } else {
    const workProfileServers = Object.keys(
      readWorkProfileMcpServers(homedir(), config.DEVHARNESS_SRC),
    );
    for (const s of ctx.mcpServers) {
      const via = workProfileServers.includes(s)
        ? " — injected via `query()` options, `CREV_REPO_DIR` = worktree"
        : " — from DEVHARNESS_SRC `settings.json`";
      lines.push(`- \`${s}\`${via}`);
    }
    lines.push(``);
    lines.push(
      `> **Note:** Work-profile servers are passed to the SDK \`query()\` call directly,`,
    );
    lines.push(
      `> not via \`settings.json\`. Tool allow/deny is enforced by the seeded \`settings.json\` below.`,
    );
  }
  lines.push(``);

  lines.push(`## Lifecycle Hooks`);
  lines.push(``);
  lines.push(`Wired in the seeded \`.claude/settings.json\`:`);
  lines.push(``);
  for (const h of ctx.hooks) lines.push(`- **${h}**`);
  lines.push(``);

  lines.push(`## Seeded settings.json`);
  lines.push(``);
  lines.push(
    `The exact file written to each worktree's \`.claude/settings.json\`.`,
  );
  lines.push(
    `\`<run-dir>\` is replaced with the actual run directory at start time.`,
  );
  lines.push(``);
  lines.push("```json");
  lines.push(JSON.stringify(ctx.seededSettings, null, 2));
  lines.push("```");
  lines.push(``);

  writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

/** Brief terminal summary — counts and key env vars, with file pointer for full detail. */
export function formatAgentContext(
  ctx: AgentContext,
  contextFile: string,
  config: DagrunnerConfig,
  homeDir: string,
): string {
  const lbl = (s: string) => `  ${s.padEnd(20)}`;
  const lines: string[] = [];
  const hr = "─".repeat(60);

  lines.push(`\n⚙️  Configuration`);
  lines.push(hr);
  lines.push(`  Home              ${homeDir}`);
  lines.push(`  Config            ${join(homeDir, "config.json")}`);
  lines.push(`  DEVHARNESS_SRC    ${config.DEVHARNESS_SRC}`);
  lines.push(
    `  Claude config     ${config.claudeConfigDir ?? "~/.claude  (default)"}`,
  );
  if (config.maxBudgetUsd !== undefined) {
    lines.push(`  Max budget        $${config.maxBudgetUsd}`);
  }
  if (config.maxParallel !== undefined) {
    lines.push(`  Max parallel      ${config.maxParallel}`);
  }
  if (config.worktreeRoot !== undefined) {
    lines.push(`  Worktree root     ${config.worktreeRoot}`);
  }

  lines.push(`\n🤖 Agent context  (dagrunner + DEVHARNESS_SRC)`);
  lines.push(hr);
  lines.push(`  Permission mode   acceptEdits`);
  lines.push(`  Sandbox           enabled for all nodes`);
  lines.push(`  Hooks             ${ctx.hooks.join(" · ")}`);

  if (Object.keys(ctx.env).length === 0) {
    lines.push(`  Env               (none)`);
  } else {
    const envStr = Object.entries(ctx.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    lines.push(`  Env               ${envStr}  ← DEVHARNESS_SRC`);
  }

  lines.push(
    `  MCP servers       ${ctx.mcpServers.length === 0 ? "(none)" : ctx.mcpServers.join(", ")}`,
  );
  lines.push(
    `${lbl(`Commands (${ctx.commands.length})`)}dagrunner: ${bySource(ctx.commands, "dagrunner").length}  DEVHARNESS_SRC: ${bySource(ctx.commands, "DEVHARNESS_SRC").length}`,
  );
  lines.push(
    `${lbl(`Agents (${ctx.agents.length})`)}dagrunner: ${bySource(ctx.agents, "dagrunner").length}  DEVHARNESS_SRC: ${bySource(ctx.agents, "DEVHARNESS_SRC").length}`,
  );
  lines.push(`${lbl(`Skills (${ctx.skills.length})`)}all from DEVHARNESS_SRC`);
  lines.push(`\n  Full detail: ${contextFile}\n`);

  return lines.join("\n");
}

function bySource(
  items: AgentContextItem[],
  src: CtxSource,
): AgentContextItem[] {
  return items.filter((i) => i.source === src);
}
