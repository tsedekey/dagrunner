#!/usr/bin/env node
/**
 * dagrunner CLI entrypoint (STUB).
 *
 * This stub exists so that:
 *   - `npm link` / install resolves the `dagrun` bin before the engine is built,
 *   - `git init` + first commit is clean and the package is internally consistent,
 *   - the build agent has a single, known entry file to grow into the real CLI.
 *
 * The engine-author replaces this with the real command surface. Per the locked
 * spec (architecture-spec skill, Themes 2 & 10), the v1 verb set is:
 *
 *   dagrun init                         Create the XDG home tree + config template
 *   dagrun start <workflow> --plan <f>  Start a run; execute to the first gate, exit
 *   dagrun resume <run-id>              Re-enter at the awaiting gate (interactive)
 *                                       Flags: --approve | --reject "<comment>"
 *   dagrun status [<run-id>]            Render run/node status, cost, awaiting-gate
 *   dagrun logs <run-id> <node>         Dump a node's friction-journal slice
 *   dagrun report <run-id>              Write a static, zero-dep HTML snapshot
 *   dagrun list                         List all runs; reconcile against worktrees
 *   dagrun abort <run-id>              Mark a run aborted
 *   dagrun cleanup <run-id>            Tear down worktree + verify cluster
 *
 * Until then, every invocation fails loud (no silent no-op) per the
 * fail-loud / no-silent-fallback discipline in CLAUDE.md.
 */

const KNOWN_COMMANDS = [
  "init",
  "start",
  "resume",
  "status",
  "logs",
  "report",
  "list",
  "abort",
  "cleanup",
] as const;

function main(argv: string[]): number {
  const [command] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "dagrun \u2014 not yet implemented (stub).",
        "",
        "Planned v1 commands:",
        ...KNOWN_COMMANDS.map((c) => `  dagrun ${c}`),
        "",
        "See HANDOFF.md and the architecture-spec skill for the full surface.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // Fail loud: a recognized-but-unbuilt command must not look like success.
  process.stderr.write(
    `dagrun: command "${command}" is not implemented yet (CLI stub).\n` +
      `The build agent replaces src/cli.ts with the real implementation.\n`,
  );
  return 1;
}

process.exit(main(process.argv.slice(2)));
