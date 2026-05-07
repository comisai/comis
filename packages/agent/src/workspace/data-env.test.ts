// SPDX-License-Identifier: Apache-2.0
//
// Workspace-internal venv contract:
//   - resolveDataEnv({ workspaceDir }) returns an object with MPLCONFIGDIR,
//     XDG_CACHE_HOME, and PATH (with `${workspaceDir}/venv/bin` prepended).
//   - All values are derived from `workspaceDir` — NOT from `process.env`.
//   - A source-grep test enforces the no-process.env invariant.
//   - Mirrors workspace-resolver.ts's safePath + os.homedir precedent
//     (no path.join).
import { describe, it, expect } from "vitest";

async function loadDataEnv(): Promise<
  | {
      resolveDataEnv: (opts: { workspaceDir: string }) => Record<string, string>;
    }
  | undefined
> {
  try {
    const mod = (await import("./data-env.js")) as Record<string, unknown>;
    if (typeof mod.resolveDataEnv !== "function") return undefined;
    return mod as unknown as {
      resolveDataEnv: (opts: { workspaceDir: string }) => Record<string, string>;
    };
  } catch {
    return undefined;
  }
}

describe("data-env (Phase 8, RC-7)", () => {
  it("T0.17 source-grep: data-env.ts has NO process.env literal in non-comment lines (D-W1)", async () => {
    // The source-grep assertion is over the literal source text;
    // a missing file is treated as a failure.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const target = path.resolve(here, "data-env.ts");
    if (!fs.existsSync(target)) {
      expect(fs.existsSync(target)).toBe(true);
      return;
    }
    const src = fs.readFileSync(target, "utf-8");
    // Strip block + line comments so the gate cannot be self-invalidated.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // The file MUST NOT contain `process.env` outside of comments.
    // The fault-injector exception precedent (eslint-disable-next-line) is
    // explicitly forbidden for this file.
    expect(stripped).not.toMatch(/process\.env/);
  });

  it("T0.18: resolveDataEnv({workspaceDir}) returns MPLCONFIGDIR / XDG_CACHE_HOME / PATH derived from workspaceDir", async () => {
    const mod = await loadDataEnv();
    expect(mod).toBeDefined();
    if (!mod) return;
    const env = mod.resolveDataEnv({ workspaceDir: "/tmp/fake-workspace" });
    // Required keys.
    expect(env).toHaveProperty("MPLCONFIGDIR");
    expect(env).toHaveProperty("XDG_CACHE_HOME");
    expect(env).toHaveProperty("PATH");
    // Values are derived from workspaceDir.
    expect(env.MPLCONFIGDIR).toContain("/tmp/fake-workspace");
    expect(env.XDG_CACHE_HOME).toContain("/tmp/fake-workspace");
    expect(env.PATH).toContain("/tmp/fake-workspace/venv/bin");
  });
});
