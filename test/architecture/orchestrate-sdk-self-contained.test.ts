// SPDX-License-Identifier: Apache-2.0
/**
 * orchestrate-sdk-self-contained — the SDK runtime assets the `orchestrate`
 * runner copies INTO the jailed workspace (`comis_tools.js` +
 * `orchestrate-sdk-runtime.js`, the runtime half of `SDK_ASSETS`) execute in a
 * workspace that has **no `node_modules`** (the bwrap jail binds only the
 * workspace + `SYSTEM_RO_PATHS`). So they MUST import only node built-ins and
 * their relative siblings (which are copied too). Any **bare** specifier (e.g.
 * `@comis/core`) is unreachable from inside the jail and makes EVERY orchestrate
 * script fail with `ERR_MODULE_NOT_FOUND` the moment it `import`s `comis_tools` —
 * i.e. the entire headline orchestrate happy-path silently breaks.
 *
 * A concrete failure this guards against: `orchestrate-sdk-runtime.ts` imported
 * `systemGetEnv` from `@comis/core` (a trivial `process.env` accessor). It passed
 * every unit test (the test runner CAN resolve `@comis/core`) but the real bwrap
 * jail — which cannot — failed each run with exit 1 ("comis_tools import not
 * available"). This arch test reproduces that structurally, cross-platform, so the
 * jail-only failure can never regress unseen again.
 *
 * Reads the BUILT dist (what is literally copied into the jail), so it requires a
 * prior `pnpm build` — which the `validate` gate always runs before `test:coverage`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_DIST = join(HERE, "..", "..", "packages", "skills", "dist", "tools", "builtin", "orchestrate");

/** The `.js` assets the runner copies into the jail (`SDK_ASSETS` minus the `.d.ts`). */
const JAIL_RUNTIME_ASSETS = ["comis_tools.js", "orchestrate-sdk-runtime.js"] as const;

/** A specifier is jail-reachable iff it is a node built-in or a relative sibling. */
function isJailReachable(spec: string): boolean {
  if (spec.startsWith("node:")) return true; // node built-in (explicit)
  if (spec.startsWith("./") || spec.startsWith("../")) return true; // relative sibling (also copied in)
  // Bare built-in names (no node: prefix) — net/fs/path/etc.
  return ["net", "fs", "path", "url", "crypto", "os", "util", "stream", "events"].includes(spec);
}

/** All import/require specifiers in a built module (from-imports, side-effect imports, requires). */
function specifiersOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

describe("orchestrate SDK jail runtime is self-contained (no node_modules in the jail)", () => {
  for (const asset of JAIL_RUNTIME_ASSETS) {
    it(`${asset} imports only node built-ins + relative siblings`, () => {
      const file = join(ORCH_DIST, asset);
      expect(existsSync(file), `${file} missing — run \`pnpm build\` first`).toBe(true);
      const specs = specifiersOf(readFileSync(file, "utf8"));
      // Non-vacuity: the runtime DOES import something (node:net), so an empty
      // match set would mean the regex broke, not that the asset is clean.
      expect(specs.length, `${asset}: no imports parsed — the matcher likely broke`).toBeGreaterThan(0);
      const unreachable = specs.filter((s) => !isJailReachable(s));
      expect(
        unreachable,
        `${asset} has jail-unreachable bare import(s) ${JSON.stringify(unreachable)} — the jail has no node_modules, so EVERY orchestrate script would fail ERR_MODULE_NOT_FOUND. Inline the dependency or use a node built-in.`,
      ).toEqual([]);
    });
  }
});
