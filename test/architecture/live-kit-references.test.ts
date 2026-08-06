// SPDX-License-Identifier: Apache-2.0
/**
 * Live-kit reference guard: the self-driving kit is the last gate before
 * production, and until this test existed nothing machine-checked it.
 *
 * `vitest.config.ts` scopes its projects to `packages/*`, `test/architecture`
 * and `scripts/contracts`, so `test/live/self-driving/**` sits outside build,
 * lint, coverage and `docs:check` alike. Its only prior guard was the
 * domain-term scan in `generic-runtime-boundary.test.ts`. That let silent drift
 * accumulate in the one document set a driver trusts to aim a run — and a kit
 * that points at a renamed file or omits a shipped capability produces a run
 * that reads GREEN while the capability was never driven.
 *
 * Every check here is deterministic and false-positive-free by construction.
 * Deliberately NOT checked (they need judgement a gate cannot supply, and a
 * noisy gate gets disabled, which is worse than no gate):
 *  - config-key and RPC-name citations. The kit legitimately cites REMOVED keys
 *    as migration hazards (`memory.costFeatures.enabled` FATALs a boot under
 *    `z.strictObject`, so the kit tells a driver to delete it), and it uses two
 *    namespaces for the same signal — `memory:recalled` on the event bus vs
 *    `memory.recalled` as a trajectory record. No rule separates those from a
 *    typo without reading intent.
 *  - numeric default claims. Verified by a drive, not by a grep.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const KIT = "test/live/self-driving";

/** Per-run output and generated trees carry no contract worth pinning. */
const SKIP_DIRS = new Set([".git", "node_modules", "runs", "dist", "coverage"]);

function walk(rel: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(resolve(REPO_ROOT, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(child, acc);
    else acc.push(child);
  }
  return acc;
}

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const kitFiles = walk(KIT);
const kitDocs = kitFiles.filter((f) => f.endsWith(".md"));
const kitProse = kitFiles.filter((f) => /\.(md|mjs|sh|ts|yaml)$/.test(f));
const kitText = kitProse.map(read).join("\n");

describe("self-driving kit references", () => {
  it("resolves every repository path the kit cites", () => {
    // Kit docs cite paths four ways: repo-relative (`packages/...`),
    // kit-relative (`scripts/db.mjs`), doc-relative (a sibling under targets/),
    // and test/live-relative (`harness/control-api.ts`). Resolve all four —
    // treating a kit-relative path as repo-relative is what made the first
    // draft of this check report 522 phantom failures.
    const citation =
      /\b(?:packages|scripts|test|website|docs|templates|targets|sim|emulators|harness|bin|assert)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_]\.[A-Za-z0-9]{2,6}\b/g;
    const violations: string[] = [];
    for (const doc of kitDocs) {
      for (const match of read(doc).matchAll(citation)) {
        const cited = match[0];
        // Placeholders are instructions to the reader, not paths.
        if (/[*<>‹…]/u.test(cited)) continue;
        // Per-run output is LOCAL-ONLY by contract — `runs/.gitignore` is `*`, so
        // nothing under it is ever committed and a citation into that tree cannot
        // resolve in a clean checkout. This is the same reason SKIP_DIRS keeps
        // `runs` out of the walk, applied to the resolving side: a campaign prompt
        // legitimately points the driver at its own TEST-PLAN, and requiring that
        // to exist would assert something the repository guarantees is false.
        if (/(?:^|\/)runs\//.test(cited)) continue;
        const candidates = [cited, `${KIT}/${cited}`, `${dirname(doc)}/${cited}`, `test/live/${cited}`];
        if (!candidates.some((c) => existsSync(resolve(REPO_ROOT, c)))) {
          violations.push(`${doc}: ${cited}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("names every registered platform tool somewhere in the kit", () => {
    // The load-bearing check. A tool the kit never names is a tool no driver
    // plans for, so it ships untested — the exact "issue we missed becomes
    // customer-facing" case. Naming it in the catalog or an arc is enough; this
    // guards discoverability, not depth of coverage.
    const registry = read("packages/skills/src/platform-tools/registry.ts");
    const tools = [...registry.matchAll(/^ {6}name: "([a-z_0-9]+)"/gm)].map((m) => m[1]);
    expect(tools.length).toBeGreaterThan(40); // the extraction itself must not silently break
    expect(tools.filter((tool) => !kitText.includes(tool))).toEqual([]);
  });

  it("documents every driver script in the scripts README", () => {
    // An undocumented helper is tooling a run never learns exists, so the
    // driver hand-rolls a weaker version and gets a weaker oracle.
    // `_`-prefixed files are the internal mode/portability layer.
    // A `*.test.mjs` is a helper's own unit test, not tooling a driver invokes —
    // the same reason a `*.test.ts` neighbour is already outside this filter.
    const readme = read(`${KIT}/scripts/README.md`);
    const scripts = readdirSync(resolve(REPO_ROOT, KIT, "scripts"))
      .filter((f) => /\.(sh|mjs)$/.test(f) && !f.startsWith("_") && !f.endsWith(".test.mjs"));
    expect(scripts.filter((s) => !readme.includes(s))).toEqual([]);
  });

  it("resolves every pnpm script the kit tells a driver to run", () => {
    const scripts = new Set(
      Object.keys((JSON.parse(read("package.json")) as { scripts?: Record<string, string> }).scripts ?? {}),
    );
    // pnpm's own verbs are not package scripts.
    const builtins = new Set([
      "install", "add", "remove", "vitest", "exec", "dlx", "run", "pack", "publish", "why",
      "audit", "list", "up", "store", "link", "unlink", "outdated", "prune", "rebuild",
    ]);
    const violations: string[] = [];
    for (const doc of kitDocs) {
      for (const match of read(doc).matchAll(/\bpnpm ([a-z][a-z0-9:-]+)/g)) {
        const name = match[1];
        if (builtins.has(name) || scripts.has(name)) continue;
        violations.push(`${doc}: pnpm ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
