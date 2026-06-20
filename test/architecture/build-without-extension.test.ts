// SPDX-License-Identifier: Apache-2.0
/**
 * N2 invariant — the opt-in extension never forces the always-on build.
 *
 * `@comis/observability-otel` is the monorepo's FIRST opt-in extension package
 * (design §6 WS2; ROADMAP phase 178). Its whole reason to exist is that core and
 * the daemon stay OpenTelemetry/Prometheus-free: `pnpm --filter @comis/core
 * build:clean` and `pnpm --filter @comis/daemon build:clean` MUST succeed with
 * `packages/observability-otel/dist` absent. That holds only if NO production
 * file in any package VALUE-imports `@comis/observability-otel` — the daemon
 * reaches it exclusively through a config-gated runtime `await import(...)`
 * (resolved lazily, never a static dependency) and a type-only
 * `import type { OtelExporterDeps } from "@comis/observability-otel"` (which
 * produces no JS and is allowed anywhere).
 *
 * This is the value-import-gate mold (`composition-root.test.ts`,
 * `valueImportsOnly: true`): `import type` shapes are filtered out; a single
 * static `import { x } from "@comis/observability-otel"` anywhere under the
 * `packages/*\/src` tree (other than the runtime `await import`, which is not a
 * static ImportDeclaration) trips it.
 *
 * The clean-room half of N2 — `rm -rf packages/observability-otel/dist` then
 * `build:clean` core+daemon — is exercised by the plan's verification command +
 * `pnpm cycles:refs` (no tsconfig project-reference forces the build); this test
 * is the deterministic, macOS-verifiable static guard that keeps a value-import
 * from ever landing.
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

const EXTENSION_PACKAGE = "@comis/observability-otel";

describe("build-without-extension — N2: no static value-import of the opt-in extension", () => {
  it(`no packages/*/src production file value-imports ${EXTENSION_PACKAGE} (type-only + runtime await import allowed)`, () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: PACKAGES_ROOT,
      forbiddenPackage: EXTENSION_PACKAGE,
      excludeFileSuffixes: [".test.ts"],
      valueImportsOnly: true,
    });

    // The extension package itself is the one place its own modules import each
    // other by the relative path; the forbidden-package scan keys on the bare
    // `@comis/observability-otel` specifier, so intra-package relative imports
    // never match. There is therefore no legitimate value-import to allowlist:
    // core/daemon (and every other package) must reach it only via the
    // config-gated runtime `await import(...)` + a type-only import.
    expect(
      violations,
      formatViolations({
        description: `production source must not VALUE-import ${EXTENSION_PACKAGE} — the opt-in extension is reached only via a config-gated runtime \`await import(...)\` (gated on otel.enabled || prometheus.enabled) and a type-only \`import type { OtelExporterDeps }\`. A static value-import would force core/daemon build:clean to require the extension's dist/ (N2 violation).`,
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix: `Use \`import type { OtelExporterDeps } from "${EXTENSION_PACKAGE}"\` for types, and \`const mod = await import("${EXTENSION_PACKAGE}")\` (config-gated, try/catch) for the runtime registration. Never a static \`import { ... } from "${EXTENSION_PACKAGE}"\`.`,
        designRef: "observability-excellence-implementation.md §6 WS2 (N2 — core/daemon build with the extension absent)",
      }),
    ).toEqual([]);

    // Coverage floor: assert findForbiddenImports descended into the whole
    // packages/*/src tree rather than bailing after one package (mirrors
    // composition-root.test.ts — HEAD has ~1,290 source .ts files; the largest
    // single package is ~225, so a floor of 500 catches a walker stuck in one
    // directory while leaving generous headroom).
    expect(
      checkedFiles,
      `sanity: findForbiddenImports must walk every packages/*/src tree; got ${checkedFiles} (expected >= 500)`,
    ).toBeGreaterThanOrEqual(500);
  });
});
