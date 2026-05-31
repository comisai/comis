// SPDX-License-Identifier: Apache-2.0
/**
 * Per-package runtime dependency completeness.
 *
 * Every backend `@comis/*` package must DECLARE (in dependencies /
 * peerDependencies / optionalDependencies) every third-party package it
 * VALUE-imports from its `src/`. A value import that is not declared resolves
 * via pnpm's hoisted dev node_modules (and via the umbrella tarball's FLAT
 * node_modules), so the monorepo and the npm install both work — but the
 * official Docker image runs `pnpm install --frozen-lockfile --prod` with
 * pnpm's ISOLATED node_modules, where an undeclared import is unreachable and
 * the daemon dies at boot with `ERR_MODULE_NOT_FOUND`.
 *
 * This is the per-package sibling of the umbrella dependency-closure check in
 * umbrella-bundling.test.ts: the umbrella can declare zod while
 * `@comis/observability` does not, so the flat tarball works but the isolated
 * `--prod` image breaks. This test closes that gap.
 *
 * Scope / exclusions:
 *   - `web` is excluded — it is a frontend package bundled by `vite build`
 *     (its third-party deps are inlined into client assets, never resolved
 *     from a Node node_modules at runtime). Mirrors umbrella-bundling.test.ts.
 *   - Type-only imports (`import type …`, `export type … from`) are excluded:
 *     they are erased by tsc and never appear in the emitted `.js`, so they
 *     impose no runtime resolution requirement.
 *   - Test files, type decls, and test-support directories are excluded.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const BUILTINS = new Set(builtinModules);

const SKIP_DIRS = new Set([
  "node_modules", "dist", "__tests__", "__test-helpers", "test-support",
  "test-helpers", "fixtures", "__fixtures__", "__mocks__",
]);

// `web` is a vite-bundled frontend package (see module doc).
const EXCLUDED_PACKAGES = new Set(["web"]);

function listPackages(): string[] {
  const dir = join(REPO_ROOT, "packages");
  return readdirSync(dir)
    .filter((name) => {
      if (EXCLUDED_PACKAGES.has(name)) return false;
      const p = join(dir, name);
      return statSync(p).isDirectory() && existsSync(join(p, "package.json"));
    })
    .sort();
}

function walk(dir: string, acc: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), acc);
    } else if (
      /\.ts$/.test(e.name) &&
      !/\.test\.ts$/.test(e.name) &&
      !/\.d\.ts$/.test(e.name) &&
      !/test-helpers?\.ts$/.test(e.name) &&
      !/\.bench\.ts$/.test(e.name)
    ) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Extract third-party VALUE import specifiers (type-only imports excluded). */
function valueImportSpecs(code: string): Set<string> {
  const src = stripComments(code);
  const specs = new Set<string>();
  // import …/export … from "x"  — line-anchored; skip `import type` / `export type`.
  const fromRe = /^\s*(import|export)\b([\s\S]{0,400}?)\bfrom\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) {
    const head = m[2];
    // `import type { … }` / `export type { … }` → erased, not a runtime dep.
    if (/^\s*type\b/.test(head)) continue;
    specs.add(m[3]);
  }
  for (const re of [
    /^\s*import\s*["']([^"']+)["']/gm, // side-effect import "x"
    /\bimport\s*\(\s*["']([^"']+)["']/g, // dynamic import("x")
    /\brequire\s*\(\s*["']([^"']+)["']/g, // require("x")
  ]) {
    while ((m = re.exec(src)) !== null) specs.add(m[1]);
  }
  return specs;
}

function packageName(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split("/")[0];
}

describe("package-runtime-deps -- each backend package declares its value imports", () => {
  it("no backend @comis/* package value-imports an undeclared third-party package", () => {
    const violations: { file: string; line: number; snippet: string }[] = [];

    for (const pkg of listPackages()) {
      const pkgJson = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const declared = new Set([
        ...Object.keys(pkgJson.dependencies ?? {}),
        ...Object.keys(pkgJson.peerDependencies ?? {}),
        ...Object.keys(pkgJson.optionalDependencies ?? {}),
      ]);
      const srcDir = join(REPO_ROOT, "packages", pkg, "src");
      if (!existsSync(srcDir)) continue;

      const seen = new Set<string>();
      for (const file of walk(srcDir, [])) {
        for (const spec of valueImportSpecs(readFileSync(file, "utf8"))) {
          const name = packageName(spec);
          if (name.startsWith("node:") || BUILTINS.has(name)) continue;
          if (name.startsWith("@comis/") || /^[.\/]/.test(name)) continue;
          if (declared.has(name)) continue;
          const key = `${pkg}:${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          violations.push({
            file: `packages/${pkg}/${relative(srcDir, file)}`,
            line: 0,
            snippet: `@comis/${pkg} value-imports "${name}" but does not declare it`,
          });
        }
      }
    }

    expect(
      violations,
      formatViolations({
        description:
          "Each backend @comis/* package must declare every third-party package it value-imports. An undeclared import works in the hoisted dev monorepo and the flat npm tarball, but breaks the official Docker image (pnpm --prod isolated node_modules) with ERR_MODULE_NOT_FOUND at daemon boot.",
        violations,
        suggestedFix:
          "Add the package to that workspace package's dependencies (version-matched to the rest of the workspace), then run pnpm install.",
        designRef: "package-runtime-deps — per-package dependency completeness",
      }),
    ).toEqual([]);
  });
});
