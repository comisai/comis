// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/core (Plan 17-04, TOOLING-CFG-19).
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub` (lives in `__test-helpers/`).
 *   - Test source files MUST NOT import the production no-op
 *     `createNoOpCapabilityPort` (tests should use the stub instead),
 *     except for the no-op's own test file which legitimately
 *     references its own export.
 *
 * Both invariants were PROVEN failing on a real violation per design v1.1
 * §10.6 inverted TDD cycle BEFORE merge -- see SUMMARY.md for the file:line
 * snapshots that fired the failure path. The proof-of-failure dance happens
 * in the working tree only; only the green test state is committed.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/core -- architecture invariants (TOOLING-CFG-19)", () => {
  it("TOOLING-CFG-19a: production source does NOT import createCapabilityPortStub (Pitfall 13)", () => {
    // Default excludeDirs already drops __tests__ + __snapshots__ + dist + node_modules.
    // Add __test-helpers (where the stub legitimately lives) so the boundary
    // means "production OUTSIDE __test-helpers must not import the stub".
    // excludeFileSuffixes drops *.test.ts so test files (which legitimately
    // reference the literal in negative-export assertions) do not poison
    // the grep -- see Plan 17-02 deviation #3 for the helper option's origin.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "production source must not import createCapabilityPortStub (use createNoOpCapabilityPort instead)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper actually walked files").toBeGreaterThan(0);
  });

  it("TOOLING-CFG-19b: test source files do NOT import createNoOpCapabilityPort (except no-op's own test + port public-surface test)", () => {
    // Tests should use createCapabilityPortStub (in __test-helpers/) for
    // fixture overrides. Two legitimate exceptions exist within @comis/core:
    //   - no-op-tool-capability.test.ts  -- tests the no-op itself.
    //   - tool-capability.test.ts        -- verifies the port public surface
    //                                       (createNoOpCapabilityPort is
    //                                       re-exported from @comis/core;
    //                                       createCapabilityPortStub is NOT).
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    const ALLOWLIST = ["no-op-tool-capability.test.ts", "tool-capability.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "test files (outside the port public-surface test allowlist) must use createCapabilityPortStub instead of createNoOpCapabilityPort",
    ).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });
});
