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

describe("@comis/skills -- architecture invariants (TOOLING-CFG-19, MCPNAME-03)", () => {
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

  it("MCPNAME-03: mcp-tool-bridge.ts has no inline mcp__...--... parser (delegates to @comis/shared)", () => {
    // §10.6 inverted-cycle proof: this test was proven failing on a real
    // violation BEFORE merge. Steps captured in 18-03-SUMMARY.md — a scratch
    // _scratchExtract body was added to mcp-tool-bridge.ts; the test fired
    // with the offending file path; the scratch was reverted byte-perfectly;
    // the test went green again. The committed state is green.
    //
    // The forbidden shape: a function body that strips the `mcp__` prefix
    // (`.slice(5)` or `.slice("mcp__".length)`) and locates the `--`
    // separator (`.indexOf("--")`) within ~200 chars of each other. The
    // [\s\S]{0,200} cross-line allowance accommodates inline parsers that
    // span ~3 lines between the two stems. Post-migration the only place
    // this shape exists is `packages/shared/src/mcp-tool-name.ts`.
    const result = findInSourceFiles({
      rootDir: resolve(SRC_ROOT, "bridge"),
      needle: /\.slice\(5\)[\s\S]{0,200}\.indexOf\(["']--["']\)/,
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "mcp-tool-bridge.ts must import extractMcpServerName from @comis/shared, " +
        "not inline-parse; expected matches to be empty",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in bridge/").toBeGreaterThan(0);
  });
});
