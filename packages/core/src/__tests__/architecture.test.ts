// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/core.
 *
 * Source-grep boundary tests enforce that:
 *   - Production source MUST NOT import the test-only stub factory
 *     `createCapabilityPortStub` (lives in `__test-helpers/`).
 *   - Test source files MUST NOT import the production no-op
 *     `createNoOpCapabilityPort` (tests should use the stub instead),
 *     except for the no-op's own test file which legitimately
 *     references its own export.
 *   - core/bootstrap.ts MUST NOT import skills internals (McpClientManager,
 *     SkillRegistry, @comis/skills) — the live ToolCapabilityPort adapter
 *     is constructed in daemon-side wiring, not in core bootstrap.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const BOOTSTRAP_PATH_FRAGMENT = "bootstrap.ts";

describe("@comis/core -- architecture invariants", () => {
  it("production source does NOT import createCapabilityPortStub", () => {
    // Default excludeDirs already drops __tests__ + __snapshots__ + dist + node_modules.
    // Add __test-helpers (where the stub legitimately lives) so the boundary
    // means "production OUTSIDE __test-helpers must not import the stub".
    // excludeFileSuffixes drops *.test.ts so test files (which legitimately
    // reference the literal in negative-export assertions) do not poison
    // the grep.
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

  it("test source files do NOT import createNoOpCapabilityPort (except no-op's own test + port public-surface test)", () => {
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

  it("core/bootstrap.ts does NOT import McpClientManager, SkillRegistry, or @comis/skills", () => {
    // The live ToolCapabilityPort adapter is constructed in daemon-side
    // wiring, NOT in core bootstrap. Core bootstrap must not import
    // McpClientManager or SkillRegistry — those are daemon/skills
    // internals.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /McpClientManager|SkillRegistry|@comis\/skills/,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => m.endsWith(BOOTSTRAP_PATH_FRAGMENT));
    expect(
      offenders,
      "core/bootstrap.ts must NOT import skills internals — the live adapter must not be constructed in core bootstrap (no McpClientManager, no SkillRegistry, no @comis/skills imports there).",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in @comis/core src tree").toBeGreaterThan(0);
  });
});
