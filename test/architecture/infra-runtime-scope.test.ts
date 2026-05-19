// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/infra runtime-scope invariant.
 *
 * No implementation package other than `@comis/daemon` may value-import
 * `@comis/infra` at runtime. The umbrella `@comis/comis` package may keep
 * its facade re-export (`import * as infra from "@comis/infra"` in
 * `packages/comis/src/index.ts` + the mirror file `packages/comis/src/infra.ts`).
 * `@comis/infra` itself self-imports during build — also allowed.
 *
 * Type-only imports of `@comis/infra` types (notably `ComisLogger` consumed
 * by 30+ daemon-internal files at HEAD) are allowed ANYWHERE — they
 * disappear at compile time. The `valueImportsOnly: true` flag implements
 * this distinction.
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

// Directories where value-imports of @comis/infra are allowed at runtime.
//
// `packages/observability/src/` is intentionally absent: the fs-safe primitives
// (appendRegularFile / writeRegularFile / SymlinkParentRejected /
// FileSizeLimitExceeded / PathEscapesConfinementError) live inside
// @comis/observability itself, so no source file under
// packages/observability/src/ value-imports @comis/infra. The dep arrow
// points the OTHER way (infra → observability via the static re-export in
// logging/redact-transport.ts).
const ALLOWED_INFRA_RUNTIME_DIRS: readonly string[] = [
  "packages/daemon/src/",         // composition root (runtime wiring)
  "packages/infra/src/",          // self-imports during build
] as const;

// Umbrella facade allowed value-imports.
const FACADE_REEXPORT_ALLOWLIST: readonly string[] = [
  "packages/comis/src/index.ts",  // `import * as infra from "@comis/infra"` namespace re-export
  "packages/comis/src/infra.ts",  // `export * from "@comis/infra"` mirror file
] as const;

describe("infra-runtime-scope — only daemon/infra/umbrella value-import @comis/infra", () => {
  it("packages/*/src value-imports of @comis/infra are restricted to daemon + infra + umbrella facade", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: PACKAGES_ROOT,
      forbiddenPackage: "@comis/infra",
      excludeFileSuffixes: [".test.ts"],
      valueImportsOnly: true,
    });

    const offenders = violations.filter((v) => {
      // Convert absolute file path to relative-from-repo-root for matching.
      const relativeFromRepo = v.file.startsWith(REPO_ROOT)
        ? v.file.slice(REPO_ROOT.length + 1)
        : v.file;
      if (ALLOWED_INFRA_RUNTIME_DIRS.some((d) => relativeFromRepo.startsWith(d))) {
        return false;
      }
      if (FACADE_REEXPORT_ALLOWLIST.some((p) => relativeFromRepo === p)) {
        return false;
      }
      return true;
    });

    expect(
      offenders,
      formatViolations({
        description:
          "Only daemon and infra packages may value-import @comis/infra at runtime (umbrella facade allowed). Type-only imports of @comis/infra types are allowed anywhere.",
        violations: offenders.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          'Use `import type { ComisLogger } from "@comis/core"` for type-only consumers; inject the runtime logger via the `Deps` interface (AGENTS.md §2.4). The Pino-backed runtime implementation lives in @comis/infra and is wired only at the composition root (daemon).',
        designRef: "AGENTS.md §2.4 + §2.7",
        allowlistRef: "ALLOWED_INFRA_RUNTIME_DIRS + FACADE_REEXPORT_ALLOWLIST (in-file)",
      }),
    ).toEqual([]);

    // Coverage floor: assert findForbiddenImports descended into the whole
    // packages/*/src tree rather than bailing after one package. With the
    // L-allowlist closed to zero, there is no "must find violations"
    // backstop to catch a walker regression that silently visits only a
    // single directory. Empirical baseline at HEAD is ~1,290 .ts source
    // files across all packages; the largest single package is ~225 files,
    // so a floor of 500 catches "walker stuck in one package" while
    // leaving generous headroom for normal refactors.
    expect(
      checkedFiles,
      `sanity: findForbiddenImports must walk every packages/*/src tree; got ${checkedFiles} (expected >= 500 — current HEAD has ~1,290 source .ts files; largest single package is ~225)`,
    ).toBeGreaterThanOrEqual(500);
  });
});
