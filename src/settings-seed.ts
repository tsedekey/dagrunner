/**
 * settings-seed.ts — shared logic for seeding the worktree's .claude/settings.json.
 *
 * Merge rules (owned = dagrunner wins, passthrough = DEVHARNESS_SRC wins):
 *   - permissions / sandbox / hooks: dagrunner replaces wholesale.
 *   - env: key-level merge; dagrunner's keys win on conflict (none defined today).
 *   - mcpServers + anything else: DEVHARNESS_SRC passes through unchanged.
 *
 * buildSeededSettings is the single source of truth for the template.
 * run-engine.ts writes it; preflight.ts displays it. Same function → no drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourcePassthrough {
  /** Env vars from DEVHARNESS_SRC to pass through to the seeded settings. */
  env: Record<string, string>;
  /** MCP server config from DEVHARNESS_SRC, if any. */
  mcpServers: unknown;
}

/**
 * Read MCP server definitions from ~/.claude-work/.claude.json and return
 * them with CREV_REPO_DIR overridden to crevRepoDir.
 * Returns an empty object if the file is absent, unparseable, or has no servers.
 */
export function readWorkProfileMcpServers(
  homeDir: string,
  crevRepoDir: string,
): Record<string, unknown> {
  const claudeJson = join(homeDir, ".claude-work", ".claude.json");
  if (!existsSync(claudeJson)) return {};
  try {
    const parsed = JSON.parse(readFileSync(claudeJson, "utf8")) as Record<
      string,
      unknown
    >;
    const servers = parsed["mcpServers"];
    if (servers === null || typeof servers !== "object") return {};
    const result: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(
      servers as Record<string, unknown>,
    )) {
      if (def !== null && typeof def === "object") {
        const d = def as Record<string, unknown>;
        // Only include stdio servers — HTTP/SSE servers may carry auth headers
        // that should not be auto-injected into every SDK session.
        const serverType = d["type"] ?? "stdio";
        if (serverType !== "stdio" && serverType !== undefined) continue;
        if (typeof d["command"] !== "string") continue;
        const copy = { ...d };
        if (
          copy["env"] !== null &&
          typeof copy["env"] === "object" &&
          "CREV_REPO_DIR" in (copy["env"] as object)
        ) {
          copy["env"] = {
            ...(copy["env"] as Record<string, string>),
            CREV_REPO_DIR: crevRepoDir,
          };
        }
        result[name] = copy;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Read the passthrough keys from DEVHARNESS_SRC's .claude/settings.json.
 * Returns empty defaults if the file is absent or unparseable.
 */
export function readSourcePassthrough(
  devharnessSrc: string,
): SourcePassthrough {
  const settingsPath = join(devharnessSrc, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return { env: {}, mcpServers: undefined };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    const env =
      parsed["env"] !== null && typeof parsed["env"] === "object"
        ? (parsed["env"] as Record<string, string>)
        : {};
    return { env, mcpServers: parsed["mcpServers"] };
  } catch {
    return { env: {}, mcpServers: undefined };
  }
}

/**
 * Build the full settings object that gets written to each worktree's
 * .claude/settings.json. Pass runDir="<run-dir>" for a display/inspection copy.
 */
export function buildSeededSettings(opts: {
  runDir: string;
  homeDir: string;
  tmpDir: string;
  passthrough: SourcePassthrough;
  /** Expanded path to the Claude config dir (e.g. /Users/x/.claude-work). */
  claudeConfigDir?: string;
  /** Work-profile MCP servers to include in settings (from readWorkProfileMcpServers). */
  workProfileMcpServers?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    runDir,
    homeDir,
    tmpDir,
    passthrough,
    claudeConfigDir,
    workProfileMcpServers,
  } = opts;

  const settings: Record<string, unknown> = {
    permissions: {
      defaultMode: "acceptEdits",
      additionalDirectories: [
        runDir,
        join(homeDir, ".m2"),
        join(homeDir, ".docker"),
        "/tmp",
        tmpDir,
      ],
      allow: [
        "Read",
        "Bash(git *)",
        "Bash(npm *)",
        "Bash(npx tsc *)",
        "Bash(npx prettier *)",
        "Bash(./mvnw *)",
        "Bash(cd java && ./mvnw *)",
        "Bash(mvn *)",
        "Bash(curl *)",
        "Bash(jq *)",
        // camunda-knowledge MCP — allowed tools (mirrors ~/.claude-work/settings.json)
        "mcp__camunda-knowledge__docs_lookup",
        "mcp__camunda-knowledge__semgrep_scan",
        "mcp__camunda-knowledge__bpmn_lint",
        "mcp__camunda-knowledge__zeebe_invariants",
        "mcp__camunda-knowledge__graph_query",
      ],
      deny: [
        "Bash(rm -rf *)",
        "Bash(sudo *)",
        "Bash(git push --force *)",
        "Bash(git push * --force)",
        "Read(**/.env)",
        "Read(**/.env.*)",
        "Read(**/secrets/**)",
        "Write(**/.env*)",
        // camunda-knowledge MCP — tools that must remain off-limits
        "mcp__camunda-knowledge__history_search",
        "mcp__camunda-knowledge__incident_search",
        "mcp__camunda-knowledge__sg_search",
        "mcp__camunda-knowledge__sg_definition",
        "mcp__camunda-knowledge__sg_references",
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: [
          "api.anthropic.com",
          "registry.npmjs.org",
          "*.npmjs.org",
          "github.com",
          "api.github.com",
          "*.githubusercontent.com",
          "repo.maven.apache.org",
          "central.maven.org",
          "*.maven.org",
          "plugins.gradle.org",
        ],
      },
    },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-verifier.sh",
            },
            {
              type: "command",
              command: "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-schema.sh",
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [
            {
              type: "command",
              command:
                "$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use-format.sh",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: "$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.sh",
            },
          ],
        },
      ],
    },
  };

  // Passthrough: env (key-level merge — dagrunner's keys would win, none defined now)
  if (Object.keys(passthrough.env).length > 0) {
    settings["env"] = { ...passthrough.env };
  }
  // MCP servers: merge work-profile servers (from .claude.json) with source-repo
  // passthrough (from DEVHARNESS_SRC/.claude/settings.json). Writing them into
  // settings.json ensures they connect under settingSources:["project"] — SDK-level
  // options.mcpServers alone is suppressed when project settings has mcpServers:{}.
  const mergedMcp: Record<string, unknown> = {};
  if (
    passthrough.mcpServers !== null &&
    typeof passthrough.mcpServers === "object"
  ) {
    Object.assign(mergedMcp, passthrough.mcpServers);
  }
  if (workProfileMcpServers !== undefined) {
    Object.assign(mergedMcp, workProfileMcpServers);
  }
  if (Object.keys(mergedMcp).length > 0) {
    settings["mcpServers"] = mergedMcp;
  }

  // Mirror enabledPlugins from the Claude profile's global settings so LSP and
  // other marketplace plugins remain active when settingSources: ["project"]
  // causes the global settings file to be skipped entirely.
  if (claudeConfigDir !== undefined && claudeConfigDir !== "") {
    const profileSettingsPath = join(claudeConfigDir, "settings.json");
    if (existsSync(profileSettingsPath)) {
      try {
        const ps = JSON.parse(
          readFileSync(profileSettingsPath, "utf8"),
        ) as Record<string, unknown>;
        const ep = ps["enabledPlugins"];
        if (ep !== null && typeof ep === "object") {
          const plugins: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(ep as Record<string, unknown>)) {
            if (typeof v === "boolean") plugins[k] = v;
          }
          if (Object.keys(plugins).length > 0) {
            settings["enabledPlugins"] = plugins;
          }
        }
      } catch {
        // Unparseable profile settings — skip; don't block the run.
      }
    }
  }

  return settings;
}
