// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/skills (Plan 17-04, TOOLING-CFG-19).
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub`.
 *   - Test source files MUST NOT import the production no-op
 *     `createNoOpCapabilityPort` (tests should use the stub instead).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/skills -- architecture invariants (TOOLING-CFG-19)", () => {
  it("production source does NOT import createCapabilityPortStub (Pitfall 13)", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/skills production source must not import the test stub",
    ).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });

  it("test source does NOT import createNoOpCapabilityPort", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/skills tests must use createCapabilityPortStub from @comis/core's __test-helpers",
    ).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });
});
