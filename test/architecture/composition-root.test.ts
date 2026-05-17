// SPDX-License-Identifier: Apache-2.0
/**
 * Composition-root invariant (GUARDRAILS-03 + GUARDRAILS-04).
 *
 * Asserts that production source value-imports `bootstrap` from `@comis/core`
 * ONLY from `packages/daemon/src/daemon.ts` — every other production import
 * MUST be type-only (`import type { bootstrap } from "@comis/core"`) or
 * MUST live inside the umbrella facade re-export allowlist
 * (`packages/comis/src/{core,index}.ts` — per RES-ARCH-10).
 *
 * Type-only imports are allowed anywhere; the test uses the
 * `valueImportsOnly: true` flag on `findForbiddenImports` to filter out
 * `import type { bootstrap }` shapes (which produce no JS at runtime).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenImports } from "../support/import-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const ALLOWED_DAEMON_BOOTSTRAP_FILE = resolve(
  PACKAGES_ROOT,
  "daemon/src/daemon.ts",
);

// Umbrella facade re-exports the @comis/core barrel; these are allowed per
// RES-ARCH-10 (the umbrella `comisai` package is the public surface for
// downstream consumers, including `import * as core from "@comis/core"`).
const FACADE_REEXPORT_ALLOWLIST: readonly string[] = [
  "packages/comis/src/core.ts",
  "packages/comis/src/index.ts",
] as const;

describe("composition-root — single production bootstrap value-import (GUARDRAILS-03 + GUARDRAILS-04)", () => {
  it("only daemon/src/daemon.ts value-imports `bootstrap` from @comis/core (umbrella facade allowed)", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: PACKAGES_ROOT,
      forbiddenPackage: "@comis/core",
      excludeFileSuffixes: [".test.ts"],
      valueImportsOnly: true,
    });

    // Filter to imports that name `bootstrap` as a value symbol.
    const bootstrapImports = violations.filter((v) =>
      v.importedSymbols.includes("bootstrap"),
    );

    // Allow daemon.ts (the legitimate composition root) + umbrella facade.
    const offenders = bootstrapImports.filter((imp) => {
      if (imp.file === ALLOWED_DAEMON_BOOTSTRAP_FILE) return false;
      if (FACADE_REEXPORT_ALLOWLIST.some((p) => imp.file.endsWith(p))) {
        return false;
      }
      return true;
    });

    expect(
      offenders,
      formatViolations({
        description:
          "production source must not value-import `bootstrap` from @comis/core (only daemon/src/daemon.ts may; umbrella facade re-exports allowed per RES-ARCH-10).",
        violations: offenders.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          'Use `import type { ... } from "@comis/core"` if you need the type. If you need to CALL bootstrap, you are at the composition root — code belongs in `daemon/src/daemon.ts`.',
        designRef: "design §13.3 (single-production-composition-root) / RES-ARCH-10 (umbrella facade allowance) / GUARDRAILS-03 + GUARDRAILS-04",
        allowlistRef: "FACADE_REEXPORT_ALLOWLIST (in-file)",
      }),
    ).toEqual([]);

    // Coverage floor: assert findForbiddenImports descended into the whole
    // packages/*/src tree rather than bailing after one package. With the
    // architecture allowlist closed to zero, there is no "must find
    // violations" backstop to catch a walker regression that silently
    // visits only a single directory. Empirical baseline at HEAD is
    // ~1,290 .ts source files across all packages; the largest single
    // package is ~225 files, so a floor of 500 catches "walker stuck in
    // one package" while leaving generous headroom for normal refactors.
    expect(
      checkedFiles,
      `sanity: findForbiddenImports must walk every packages/*/src tree; got ${checkedFiles} (expected >= 500 — current HEAD has ~1,290 source .ts files; largest single package is ~225)`,
    ).toBeGreaterThanOrEqual(500);
  });
});
