// SPDX-License-Identifier: Apache-2.0
/**
 * Native-ESM module-load guard for the terminal-worker load chain.
 *
 * The Terminal Worker is spawned as a SEPARATE node process — the registry's
 * `buildProductionSpawnWorker` does `childSpawn(process.execPath, [...permArgs,
 * workerJs], …)` for crash isolation — so the worker loads the BUILT
 * `dist/.../*.js` under Node's NATIVE ESM loader, NOT under vitest's bundler.
 *
 * That distinction is the whole point of this file. Vitest's transform rewrites
 * CommonJS interop, so a `import { Terminal } from "@xterm/headless"` (a NAMED
 * import from a CJS package whose exports the cjs-module-lexer cannot statically
 * resolve) loads green in EVERY vitest unit/`.linux` test — then throws
 * `SyntaxError: Named export 'Terminal' not found …` the instant the real
 * spawned worker loads the built file in production. A unit test literally
 * cannot catch this class; only loading the built artifact in a real `node`
 * does.
 *
 * So this guard spawns a real `node --input-type=module` subprocess that
 * `import()`s the built dist file and asserts it exits 0. It covers the two
 * entry modules the production worker actually loads under native ESM:
 *   - `terminal-render.ts`  — the @xterm emulator wrapper (the regressing file);
 *   - `terminal-worker-entry.ts` — the worker entry, which statically imports
 *     `terminal-render.js`, so it crashes transitively on the same fault and
 *     also guards any future native-only fault added to the entry itself.
 *
 * GATED on the built dist existing (`describe.skipIf(!existsSync(...))`): it
 * needs `pnpm build` first, so it RUNS in CI / `pnpm validate` (which build
 * before test) and SKIPS in a pure-`src` watch run. With bare named CJS
 * imports the subprocess exits 1; with the `createRequire` loading idiom it
 * exits 0.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// This test lives in src/tools/builtin/terminal-driver; the built twin sits in
// the parallel dist/ tree. Map src → dist so we load the ACTUAL production
// artifact (a native loader on src .ts would be meaningless — tsc/vitest, not
// node, owns .ts).
const here = dirname(fileURLToPath(import.meta.url));
const distDir = here.replace(`${join("src", "tools")}`, `${join("dist", "tools")}`);

/** A built worker-load-chain module + the absolute path to its dist artifact. */
interface DistEntry {
  name: string;
  distPath: string;
}

const ENTRIES: DistEntry[] = [
  { name: "terminal-render.js", distPath: join(distDir, "terminal-render.js") },
  { name: "terminal-worker-entry.js", distPath: join(distDir, "terminal-worker-entry.js") },
];

const allBuilt = ENTRIES.every((e) => existsSync(e.distPath));

/**
 * Spawn a real `node` that `import()`s the built file under the NATIVE ESM
 * loader (NOT vitest's bundler) and return its exit status + stderr. A named
 * import from an unresolvable CJS module throws at module-load, so the dynamic
 * `import()` rejects and the subprocess exits 1; a clean load exits 0. We pass
 * the file as a `file://` URL (Windows/′space-in-path′ safe) on argv to keep the
 * inline program a fixed string.
 */
function loadUnderNativeNode(distPath: string): { status: number | null; stderr: string } {
  const program = `
    import(process.argv[1])
      .then(() => process.exit(0))
      .catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
  `;
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program, pathToFileURL(distPath).href],
    { encoding: "utf8" },
  );
  return { status: res.status, stderr: res.stderr ?? "" };
}

describe.skipIf(!allBuilt)("terminal worker load chain — native ESM module load", () => {
  it.each(ENTRIES)(
    "loads the built $name under a real node process (not vitest's CJS-interop bundler)",
    ({ distPath }) => {
      const { status, stderr } = loadUnderNativeNode(distPath);
      // status===0 ⇒ the built module loaded cleanly under the native loader,
      // exactly as the spawned production worker loads it. A non-zero exit means
      // a load-time throw (the `Named export … not found` CJS-interop crash, or
      // any future native-only fault) — the production worker would crash on
      // startup. stderr is surfaced so the failure names the offending export.
      expect(stderr).toBe("");
      expect(status).toBe(0);
    },
  );
});
