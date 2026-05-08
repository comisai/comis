// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/daemon (Plan 17-04, scaffolding).
 *
 * Phase 17 places this file so subsequent phases can append invariants
 * without re-establishing scaffolding:
 *   - Phase 23 (WIRING-01..11) will assert that the live ToolCapabilityPort
 *     adapter is constructed at daemon-side wiring, NOT in core/bootstrap.ts;
 *     plus cluster-ID typo WARN paths and the createNoOpCapabilityPort
 *     interim removal at the swap point.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/daemon -- architecture invariants", () => {
  it("scaffolding: findInSourceFiles helper resolves and walks the package src tree", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "TOOLING_CFG_19_PLACEHOLDER_xyz_should_never_match",
    });
    expect(result.matches).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });
});
