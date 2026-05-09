// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/shared.
 *
 * Asserts that production source MUST NOT contain inline mcp__...--...
 * regex parsers; only @comis/shared exports the canonical parser.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/shared -- architecture invariants", () => {
  it("defense-in-depth: only mcp-tool-name.ts contains the canonical parser shape", () => {
    // If a future contributor copy-pastes the slice(5)+indexOf("--") shape
    // into another shared utility (creating a near-duplicate of the canonical
    // parser), this test catches it. The single legitimate carrier is
    // mcp-tool-name.ts; everything else in @comis/shared/src/ must delegate
    // to it.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /\.slice\(5\)[\s\S]{0,200}\.indexOf\(["']--["']\)/,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => !m.endsWith("mcp-tool-name.ts"));
    expect(
      offenders,
      "Only @comis/shared/src/mcp-tool-name.ts may contain the canonical parser shape; " +
        "any other shared utility must delegate to extractMcpServerName / parseSanitizedMcpToolName",
    ).toEqual([]);
    // Sanity: the canonical file MUST match — confirms the regex actually finds the shape.
    // If this assertion fires, mcp-tool-name.ts has drifted away from the canonical body
    // (or the regex is broken).
    expect(result.matches.length, "sanity: mcp-tool-name.ts itself should match the canonical shape").toBeGreaterThan(0);
  });
});
