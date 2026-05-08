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

describe("@comis/agent -- architecture invariants (MCPNAME-03)", () => {
  // FORBIDDEN_PARSER_RE: catches the canonical inline mcp__server--tool parser shape
  // (`.slice(5)` followed by `.indexOf("--")` within ~200 characters). Post-migration
  // (Plan 18-02) no production file in @comis/agent matches this pattern; the
  // canonical home is `packages/shared/src/mcp-tool-name.ts`. RESEARCH §Pattern 2b.
  const FORBIDDEN_PARSER_RE = /\.slice\(5\)[\s\S]{0,200}\.indexOf\(["']--["']\)/;

  it("MCPNAME-03: bridge/bridge-event-handlers.ts has no inline mcp__...--... parser", () => {
    // §10.6 inverted-cycle proof captured in 18-03-SUMMARY.md (Task 2 dance: scratch
    // violation in bridge-event-handlers.ts triggered failure with its file path;
    // scratch reverted; re-run green).
    //
    // The walk is scoped to bridge/ rather than the whole package because (a) test
    // isolation — failure messages name exactly bridge/* files; (b) Phase 19 may
    // add a new invariant scoped to executor/ that benefits from a separate it().
    // Note: pi-event-bridge.ts also lives in bridge/ and is automatically covered
    // by this scan; a dedicated assertion is unnecessary because pi-event-bridge.ts
    // was never an inline-parser carrier (it only consumed the symbol).
    const result = findInSourceFiles({
      rootDir: resolve(SRC_ROOT, "bridge"),
      needle: FORBIDDEN_PARSER_RE,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => m.endsWith("bridge-event-handlers.ts"));
    expect(
      offenders,
      "bridge-event-handlers.ts must import/re-export extractMcpServerName from @comis/shared, not inline-parse",
    ).toEqual([]);
    // Whole-bridge sanity: no other file in bridge/ may inline-parse either
    expect(result.matches, "no file in @comis/agent/src/bridge/ may contain the canonical parser shape").toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in bridge/").toBeGreaterThan(0);
  });

  it("MCPNAME-03: executor/tool-deferral.ts has no inline mcp__...--... parser", () => {
    // §10.6 inverted-cycle proof captured in 18-03-SUMMARY.md (Task 2 dance:
    // scratch violation in tool-deferral.ts triggered failure with its file path;
    // scratch reverted; re-run green). The test file remains independent of the
    // bridge/ test so failure messages name exactly one directory.
    const result = findInSourceFiles({
      rootDir: resolve(SRC_ROOT, "executor"),
      needle: FORBIDDEN_PARSER_RE,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => m.endsWith("tool-deferral.ts"));
    expect(
      offenders,
      "tool-deferral.ts must import extractMcpServerName from @comis/shared (or its re-export)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in executor/").toBeGreaterThan(0);
  });
});
