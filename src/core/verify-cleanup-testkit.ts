/**
 * verify-cleanup-testkit.ts — test-only stateful fake `docker` for the injectable
 * DockerExec seam (unit tests and smoke:mock). Never used in production paths.
 */

import type { DockerExec } from "./verify-cleanup.js";

/** Stateful fake docker: tracks live resources, records every call. */
export function fakeDocker(initial: { container?: string[]; network?: string[]; image?: string[]; volume?: string[] }, opts: { stubborn?: string[]; down?: boolean } = {}) {
  const live = {
    container: new Set(initial.container ?? []),
    network: new Set(initial.network ?? []),
    image: new Set(initial.image ?? []),
    volume: new Set(initial.volume ?? []),
  };
  const calls: string[][] = [];
  const exec: DockerExec = (a) => {
    calls.push(a);
    if (opts.down) return { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    const ok = (out = "") => ({ status: 0, stdout: out, stderr: "" });
    const bad = { status: 1, stdout: "", stderr: "No such" };
    const [c, ...r] = a;
    if (c === "rm") { const n = r[r.length - 1]!; if (opts.stubborn?.includes(n)) return bad; return live.container.delete(n) ? ok() : bad; }
    if (c === "network" && r[0] === "rm") return live.network.delete(r[1]!) ? ok() : bad;
    if (c === "volume" && r[0] === "rm") return live.volume.delete(r[2]!) ? ok() : bad;
    if (c === "image" && r[0] === "rm") { const n = r[2]!; return live.image.delete(n) || (!n.includes(":") && live.image.delete(n + ":latest")) ? ok() : bad; }
    const listOf = (set: Set<string>, needle: string) => ok([...set].filter((n) => n.includes(needle)).join("\n"));
    const f = (a.find((x) => x.startsWith("name=") || x.startsWith("reference=")) ?? "").split("=")[1] ?? "";
    if (c === "ps") return listOf(live.container, f);
    if (c === "network" && r[0] === "ls") return listOf(live.network, f);
    if (c === "volume" && r[0] === "ls") return listOf(live.volume, f);
    if (c === "image" && r[0] === "ls") return listOf(live.image, f);
    return bad;
  };
  return { exec, calls, live };
}

