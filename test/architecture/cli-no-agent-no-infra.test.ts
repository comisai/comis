// SPDX-License-Identifier: Apache-2.0
/**
 * Lock-in: CLI imports neither @comis/agent nor @comis/infra. Top-level
 * defense-in-depth boundary at the architecture-allowlist level.
 *
 * Mirrors the per-package architecture test in
 * packages/cli/src/__tests__/architecture.test.ts but additionally
 * grep-asserts the JSON config files (package.json + tsconfig.json) — so
 * a future PR that re-adds a workspace dep or tsconfig reference is
 * caught by the architecture suite before any source-level import
 * regression.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenImports } from "../support/import-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const CLI_SRC = resolve(REPO_ROOT, "packages/cli/src");

describe("CLI no @comis/agent + no @comis/infra", () => {
  for (const forbidden of ["@comis/agent", "@comis/infra"] as const) {
    it(`cli/src imports do NOT include ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: CLI_SRC,
        forbiddenPackage: forbidden,
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        violations,
        formatViolations({
          description: `cli/src imports must not include ${forbidden}`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix: `Retarget the import to @comis/core.`,
          designRef: "CLI must not depend on @comis/agent or @comis/infra",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one cli/src file",
      ).toBeGreaterThan(0);
    });
  }

  it("packages/cli/package.json declares no @comis/agent or @comis/infra dependency", () => {
    const pkg = readFileSync(
      resolve(REPO_ROOT, "packages/cli/package.json"),
      "utf8",
    );
    expect(pkg, "package.json must not list @comis/agent").not.toMatch(
      /"@comis\/agent"/,
    );
    expect(pkg, "package.json must not list @comis/infra").not.toMatch(
      /"@comis\/infra"/,
    );
  });

  it("packages/cli/tsconfig.json declares no reference to ../agent or ../infra", () => {
    const ts = readFileSync(
      resolve(REPO_ROOT, "packages/cli/tsconfig.json"),
      "utf8",
    );
    expect(ts, "tsconfig.json must not reference ../agent").not.toMatch(
      /"path":\s*"\.\.\/agent"/,
    );
    expect(ts, "tsconfig.json must not reference ../infra").not.toMatch(
      /"path":\s*"\.\.\/infra"/,
    );
  });
});
