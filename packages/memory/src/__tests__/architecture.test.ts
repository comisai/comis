// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/memory.
 *
 * Forbidden-import rules: production source MUST NOT import any of the
 * downstream packages (@comis/agent, @comis/channels, @comis/skills,
 * @comis/scheduler, @comis/cli, @comis/gateway, @comis/daemon,
 * @comis/orchestrator). memory provides ContextStore / SessionStore
 * implementations consumed by daemon-side wiring.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(here, "../../../..");

const FORBIDDEN_PACKAGES = [
  "@comis/agent",
  "@comis/channels",
  "@comis/skills",
  "@comis/scheduler",
  "@comis/cli",
  "@comis/gateway",
  "@comis/daemon",
  "@comis/orchestrator",
] as const;

describe("@comis/memory -- architecture invariants", () => {
  for (const forbidden of FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/memory production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "memory is a leaf in the package graph (depends only on @comis/shared and @comis/core). If a type is needed, move it to @comis/core/ports.",
        }),
      ).toEqual([]);
      // Pattern E sanity check: helper actually walked production source files.
      expect(checkedFiles, "sanity: findForbiddenImports walked at least one memory/src file").toBeGreaterThan(0);
    });
  }
});

describe("@comis/memory -- single-source SessionData", () => {
  it("SessionData is declared exactly once in production source", () => {
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages"),
      needle: /^export interface SessionData\b/m,
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches.length,
      formatViolations({
        description:
          "SessionData must be declared exactly once in production source at packages/core/src/ports/session-store-types.ts.",
        violations: result.matches.map((path) => ({ file: path, line: 0 })),
        suggestedFix:
          "Delete the duplicate declaration; import SessionData from @comis/core.",
      }),
    ).toBe(1);
    expect(result.matches[0]).toMatch(
      /packages\/core\/src\/ports\/session-store-types\.ts$/,
    );
  });
});
