// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/shared (Plan 17-04, scaffolding).
 *
 * Phase 17 establishes the file location + import contract so subsequent
 * phases can append invariants without re-establishing scaffolding:
 *   - Phase 18 (MCPNAME-03) will assert that production source MUST NOT
 *     contain inline mcp__...--... regex parsers; only @comis/shared
 *     exports the canonical parser.
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
  it("scaffolding: findInSourceFiles helper resolves and walks the package src tree", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "TOOLING_CFG_19_PLACEHOLDER_xyz_should_never_match",
    });
    expect(result.matches).toEqual([]);
    expect(
      result.checkedFiles,
      "sanity: helper walked at least one file in @comis/shared/src",
    ).toBeGreaterThan(0);
  });
});
