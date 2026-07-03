// SPDX-License-Identifier: Apache-2.0
/**
 * No-eval JSONPath supply-chain guard: the `jsonpath` ResultRef query core
 * MUST NOT introduce an eval-based JSONPath library. `jsonpath` (uses
 * `static-eval`) and `jsonpath-plus` (RCE via `eval` — CVE-2024-21534,
 * CVE-2025-1302) both violate AGENTS.md §2.2 (no `eval`/`Function`), and the
 * class of bug recurs. The query core deliberately maps JSONPath onto DuckDB
 * `json_extract` (no new dependency) instead, so NONE of these may ever appear
 * in any `package.json` manifest or in the pnpm lockfile.
 *
 * This grep-guard reads the manifests + lockfile directly (independent of how
 * pnpm laid out node_modules) so a smuggled-in eval lib is a BUILD failure, not
 * a latent RCE surface discovered in production. The companion ESLint `no-eval`
 * rule gates direct `eval(...)` calls; this gate closes the "pull in a library
 * that does the eval for you" loophole.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Banned eval-based JSONPath packages. Matched as exact dependency KEYS in the
 * manifests, and as the lockfile's quoted-key form so a benign domain mention
 * (e.g. "jsonpath" in prose) elsewhere never trips. `jmespath` is included
 * because it is the other "expression engine as a dep" the query core must not reach for.
 */
const BANNED_JSONPATH_PACKAGES = ["jsonpath", "jsonpath-plus", "static-eval", "jmespath"] as const;

/** Collect every package.json under packages/* + the root (the manifests we own). */
function ownedManifests(): string[] {
  const out: string[] = [join(REPO_ROOT, "package.json")];
  const pkgRoot = join(REPO_ROOT, "packages");
  for (const e of readdirSync(pkgRoot)) {
    const p = join(pkgRoot, e);
    if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) {
      out.push(join(p, "package.json"));
    }
  }
  const websiteManifest = join(REPO_ROOT, "website", "package.json");
  if (existsSync(websiteManifest)) out.push(websiteManifest);
  return out;
}

describe("no-eval JSONPath supply-chain guard", () => {
  it("declares no eval-based JSONPath library in any owned package.json", () => {
    const violations: string[] = [];
    for (const manifestPath of ownedManifests()) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      for (const banned of BANNED_JSONPATH_PACKAGES) {
        if (banned in allDeps) {
          violations.push(`${relative(REPO_ROOT, manifestPath)} declares "${banned}"`);
        }
      }
    }
    expect(
      violations,
      `Eval-based JSONPath libraries are banned (AGENTS.md §2.2; RCE CVEs). QRY-02 uses DuckDB json_extract instead. Found:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("contains no eval-based JSONPath library in the pnpm lockfile", () => {
    const lockPath = join(REPO_ROOT, "pnpm-lock.yaml");
    const lock = readFileSync(lockPath, "utf8");
    const found: string[] = [];
    for (const banned of BANNED_JSONPATH_PACKAGES) {
      const esc = banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // pnpm v9 lock (lockfileVersion 9.0) keys a package snapshot as a line of
      // the form `  <name>@<version>(...peers):` (leading whitespace, then
      // name@version). Match the name preceded by whitespace OR a `/` (scoped
      // forms) and immediately followed by `@`, so a substring inside another
      // package name (e.g. "@scope/jsonpath-utils@1.0.0:") does not false-positive
      // — the trailing `@` after the exact name is the boundary.
      const re = new RegExp(`(^\\s+|/)${esc}@`, "m");
      if (re.test(lock)) found.push(banned);
    }
    expect(
      found,
      `Eval-based JSONPath libraries are banned in the lockfile (AGENTS.md §2.2; RCE CVEs). QRY-02 uses DuckDB json_extract. Found: ${found.join(", ")}`,
    ).toEqual([]);
  });
});
