// SPDX-License-Identifier: Apache-2.0
/**
 * Per-package dependency completeness (runtime + build-time).
 *
 * Two complementary checks, both reading each package's `src/` statically
 * (AST/regex over source — independent of how pnpm laid out node_modules, so
 * neither is fooled by a phantom/hoisted dependency in the dev tree):
 *
 *   1. RUNTIME — every backend `@comis/*` package must DECLARE (in dependencies
 *      / peerDependencies / optionalDependencies) every third-party package it
 *      VALUE-imports. An undeclared value import resolves via pnpm's hoisted dev
 *      node_modules (and the umbrella tarball's FLAT node_modules), so the
 *      monorepo and the npm install both work — but the official Docker image
 *      runs `pnpm install --frozen-lockfile --prod` with pnpm's ISOLATED
 *      node_modules, where it is unreachable and the daemon dies at boot with
 *      `ERR_MODULE_NOT_FOUND`. (devDependencies do NOT count here — they are
 *      pruned by `--prod`.)
 *
 *   2. BUILD-TIME — every backend package must also declare every third-party
 *      package it TYPE-imports (`import type … from`, `export type … from`).
 *      Such imports are erased from the emitted `.js`, so they impose no
 *      *runtime* requirement — but `tsc` must still resolve their `.d.ts` to
 *      type-check. An undeclared type import compiles in the hoisted dev tree
 *      yet fails the clean `pnpm install --frozen-lockfile` build CI runs with
 *      `TS2307: Cannot find module '<pkg>' or its corresponding type
 *      declarations`. This is exactly how `@comis/memory`'s undeclared
 *      `import type { Message } from "@earendil-works/pi-ai"` reached `main` and
 *      reddened both CI and Docker Release: the dev build (and even
 *      `pnpm build:clean`, which keeps node_modules) resolved the hoisted phantom.
 *      Because a type import is erased, a devDependency is sufficient for the
 *      build — so this check allows devDependencies too.
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

/**
 * Extract third-party TYPE-ONLY import specifiers — the exact inverse of the
 * `import type`/`export type` skip in `valueImportSpecs`. These are erased from
 * the emitted `.js` (no runtime dep) but `tsc` still resolves their `.d.ts` at
 * build time, so an undeclared one fails the clean isolated build with TS2307.
 */
function typeOnlyImportSpecs(code: string): Set<string> {
  const src = stripComments(code);
  const specs = new Set<string>();
  const fromRe = /^\s*(import|export)\b([\s\S]{0,400}?)\bfrom\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) {
    if (!/^\s*type\b/.test(m[2])) continue; // ONLY `import type` / `export type`
    specs.add(m[3]);
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

type DepViolation = { file: string; line: number; snippet: string };

/**
 * For every backend package, scan its `src/` with `specsFor`, resolve each
 * third-party specifier to a package name, and collect the ones not declared in
 * any of the named manifest fields. Reads source statically, so the result is
 * independent of the node_modules layout (a hoisted phantom cannot hide a
 * missing declaration).
 */
function scanUndeclared(
  specsFor: (code: string) => Set<string>,
  manifestFields: readonly string[],
  snippet: (pkg: string, name: string) => string,
): DepViolation[] {
  const violations: DepViolation[] = [];
  for (const pkg of listPackages()) {
    const pkgJson = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const declared = new Set(
      manifestFields.flatMap((field) => Object.keys(pkgJson[field] ?? {})),
    );
    const srcDir = join(REPO_ROOT, "packages", pkg, "src");
    if (!existsSync(srcDir)) continue;

    const seen = new Set<string>();
    for (const file of walk(srcDir, [])) {
      for (const spec of specsFor(readFileSync(file, "utf8"))) {
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
          snippet: snippet(pkg, name),
        });
      }
    }
  }
  return violations;
}

describe("package-runtime-deps -- each backend package declares its imports", () => {
  it("no backend @comis/* package value-imports an undeclared third-party package", () => {
    // Runtime: value imports must resolve under `--prod` isolated node_modules,
    // so devDependencies (pruned by --prod) do NOT satisfy this.
    const violations = scanUndeclared(
      valueImportSpecs,
      ["dependencies", "peerDependencies", "optionalDependencies"],
      (pkg, name) => `@comis/${pkg} value-imports "${name}" but does not declare it`,
    );

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

  it("no backend @comis/* package type-imports an undeclared third-party package", () => {
    // Build-time: a type-only import is erased at runtime, so a devDependency is
    // enough for tsc to resolve its types — but it MUST be declared somewhere,
    // or the clean isolated build fails with TS2307 (the @earendil-works/pi-ai
    // regression). devDependencies therefore count here.
    const violations = scanUndeclared(
      typeOnlyImportSpecs,
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"],
      (pkg, name) => `@comis/${pkg} type-imports "${name}" but does not declare it`,
    );

    expect(
      violations,
      formatViolations({
        description:
          "Each backend @comis/* package must declare every third-party package it type-imports (import type / export type). The import is erased at runtime, but tsc still resolves its .d.ts at build time — an undeclared one compiles in the hoisted dev tree (and survives `pnpm build:clean`, which keeps node_modules) yet fails the clean `pnpm install --frozen-lockfile` build CI runs with TS2307. This is the phantom-dependency class that reddened CI when @comis/memory imported `type Message` from @earendil-works/pi-ai without declaring it.",
        violations,
        suggestedFix:
          "Add the package to that workspace package's dependencies (or devDependencies, since a type-only import is build-time only), version-matched to the rest of the workspace, then run pnpm install.",
        designRef: "package-runtime-deps — per-package dependency completeness (build-time)",
      }),
    ).toEqual([]);
  });
});
