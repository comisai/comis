// SPDX-License-Identifier: Apache-2.0
/**
 * Forward-protective umbrella-bundling alignment test.
 *
 * Asserts bidirectional 6-way alignment between:
 *   1. The set of packages/<name>/ directories (excluding `comis` itself + `web` if no namespace)
 *   2. WORKSPACE_PACKAGES in packages/comis/scripts/prepack.js (literal array)
 *   3. bundledDependencies in packages/comis/package.json
 *   4. exports map keys in packages/comis/package.json (sans ".")
 *   5. mirror files at packages/comis/src/<name>.ts (one per package, except web)
 *   6. Namespace re-exports in packages/comis/src/index.ts (one per package, except web)
 *
 * Failure mode this test prevents: developer adds @comis/foo to one surface
 * but forgets the others -> tarball publish-time failure rather than test-time
 * failure (per RESEARCH RES-PIT-4 / ORCH-EXT-04).
 *
 * Note on `web`: web is bundled (in WORKSPACE_PACKAGES + bundledDependencies)
 * but has NO namespace re-export and NO mirror file (current pattern). The
 * test handles this by excluding web from the mirror+namespace assertions
 * while keeping it in the bundling+exports assertions.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Packages that have a namespace re-export and a mirror file in `packages/comis/src/`.
 * `web` is bundled but has no namespace re-export (current convention).
 */
const NAMESPACED_PACKAGES = [
  "shared",
  "core",
  "infra",
  "memory",
  "gateway",
  "skills",
  "scheduler",
  "agent",
  "channels",
  "orchestrator",
  "cli",
  "daemon",
] as const;

const ALL_BUNDLED_PACKAGES = [...NAMESPACED_PACKAGES, "web"] as const;

function readPrepackWorkspacePackages(): string[] {
  const path = resolve(REPO_ROOT, "packages/comis/scripts/prepack.js");
  const content = readFileSync(path, "utf8");
  const match = content.match(/const WORKSPACE_PACKAGES = \[([\s\S]*?)\];/);
  if (!match) throw new Error("WORKSPACE_PACKAGES array not found in prepack.js");
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/["']/g, "").replace(/\/\/.*$/g, "").trim())
    .filter((s) => s.length > 0);
}

function readUmbrellaPackageJson(): {
  bundledDependencies: string[];
  exports: Record<string, unknown>;
} {
  const path = resolve(REPO_ROOT, "packages/comis/package.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function readIndexNamespaces(): string[] {
  const path = resolve(REPO_ROOT, "packages/comis/src/index.ts");
  const content = readFileSync(path, "utf8");
  const importRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+"@comis\/(\w+)"/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    found.push(m[2]);
  }
  return found;
}

function readPackagesDirectories(): string[] {
  const packagesDir = resolve(REPO_ROOT, "packages");
  return readdirSync(packagesDir)
    .filter((name) => {
      const stat = statSync(join(packagesDir, name));
      if (!stat.isDirectory()) return false;
      if (name === "comis") return false; // exclude the umbrella itself
      return existsSync(join(packagesDir, name, "package.json"));
    })
    .sort();
}

describe("umbrella-bundling -- bidirectional 6-way alignment", () => {
  it("packages/ directories match ALL_BUNDLED_PACKAGES (set equality)", () => {
    const dirs = new Set(readPackagesDirectories());
    const expected = new Set<string>(ALL_BUNDLED_PACKAGES);
    const onlyInDirs = [...dirs].filter((d) => !expected.has(d));
    const onlyInExpected = [...expected].filter((d) => !dirs.has(d));
    expect(
      { onlyInDirs, onlyInExpected },
      formatViolations({
        description:
          "packages/ directories must match ALL_BUNDLED_PACKAGES (six-way alignment surface 1).",
        violations: [
          ...onlyInDirs.map((d) => ({
            file: `packages/${d}/`,
            line: 0,
            snippet: "unexpected directory not in ALL_BUNDLED_PACKAGES",
          })),
          ...onlyInExpected.map((d) => ({
            file: "(missing)",
            line: 0,
            snippet: `expected directory packages/${d}/ not found`,
          })),
        ],
        suggestedFix:
          "Add the new package to ALL_BUNDLED_PACKAGES (this file) AND to WORKSPACE_PACKAGES (prepack.js) AND to bundledDependencies AND to exports AND to mirror file AND to namespace re-export. All 6 surfaces or none.",
        designRef: "RESEARCH §Pitfall 4 / ORCH-EXT-04",
      }),
    ).toEqual({ onlyInDirs: [], onlyInExpected: [] });
  });

  it("WORKSPACE_PACKAGES in prepack.js matches ALL_BUNDLED_PACKAGES", () => {
    const fromPrepack = new Set(readPrepackWorkspacePackages());
    const expected = new Set<string>(ALL_BUNDLED_PACKAGES);
    const onlyInPrepack = [...fromPrepack].filter((p) => !expected.has(p));
    const missingInPrepack = [...expected].filter((p) => !fromPrepack.has(p));
    expect({ onlyInPrepack, missingInPrepack }).toEqual({
      onlyInPrepack: [],
      missingInPrepack: [],
    });
  });

  it("bundledDependencies includes every @comis/<bundled> entry", () => {
    const pkg = readUmbrellaPackageJson();
    const bundled = new Set(pkg.bundledDependencies);
    const expected = new Set<string>(
      ALL_BUNDLED_PACKAGES.map((p) => `@comis/${p}`),
    );
    const missing = [...expected].filter((e) => !bundled.has(e));
    expect(
      missing,
      `missing @comis/* in bundledDependencies: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("exports map includes every namespaced bundled package (except web)", () => {
    const pkg = readUmbrellaPackageJson();
    const exportKeys = new Set(
      Object.keys(pkg.exports).filter((k) => k !== "."),
    );
    const expected = new Set<string>(NAMESPACED_PACKAGES.map((p) => `./${p}`));
    const missing = [...expected].filter((e) => !exportKeys.has(e));
    expect(missing, `missing ./<pkg> in exports: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("mirror file exists for every namespaced bundled package", () => {
    const missing: string[] = [];
    for (const pkg of NAMESPACED_PACKAGES) {
      const mirrorPath = resolve(REPO_ROOT, `packages/comis/src/${pkg}.ts`);
      if (!existsSync(mirrorPath))
        missing.push(`packages/comis/src/${pkg}.ts`);
    }
    expect(missing, `missing mirror files: ${missing.join(", ")}`).toEqual([]);
  });

  it("namespace re-export in src/index.ts includes every namespaced bundled package", () => {
    const fromIndex = new Set(readIndexNamespaces());
    const expected = new Set<string>(NAMESPACED_PACKAGES);
    const missing = [...expected].filter((p) => !fromIndex.has(p));
    expect(
      missing,
      `missing namespace re-export in src/index.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("sanity: at least 12 namespaced packages (Pattern E)", () => {
    expect(
      NAMESPACED_PACKAGES.length,
      "Pattern E sanity: at least 12 packages bundled",
    ).toBeGreaterThanOrEqual(12);
  });
});
