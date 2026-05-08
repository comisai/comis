// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/agent (Plan 17-04, scaffolding).
 *
 * Phase 17 places this file so subsequent phases can append invariants
 * without re-establishing scaffolding:
 *   - Phase 19 (DEFER-04) will assert that `discover_tools` and
 *     `tool_search_tool_regex` literals do not appear in production source
 *     (excluding __snapshots__ / fixtures / allowlist files).
 *   - Phase 20 (CAPINDEX-RENDER-15/16) will assert that
 *     `prompt-assembly.ts` does NOT import `getPromptSkillCapabilities`
 *     or `capability-index-context.ts` (cache-fence Pitfall 1; the
 *     JSDoc invariant landed in Plan 17-04 and the architecture-grep
 *     enforcement lands in Phase 20).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/agent -- architecture invariants", () => {
  it("scaffolding: findInSourceFiles helper resolves and walks the package src tree", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "TOOLING_CFG_19_PLACEHOLDER_xyz_should_never_match",
    });
    expect(result.matches).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });
});
