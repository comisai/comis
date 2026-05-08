// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/agent.
 *
 * Each phase appends invariants without re-establishing scaffolding:
 *   - Phase 18 (MCPNAME-03, DONE): asserts no inline `slice(5) + indexOf("--")`
 *     parser exists in `bridge/bridge-event-handlers.ts` or
 *     `executor/tool-deferral.ts` — only the canonical home in `@comis/shared`.
 *   - Phase 19 (DEFER-04, DONE): asserts that `discover_tools` and
 *     `tool_search_tool_regex` literals do not appear in production source
 *     (excluding `__tests__/`, `__snapshots__/`, fixtures, and an explicit
 *     allowlist for tool-name-table / API-payload-reshape / tool-identifier
 *     files). The `discover_tools` invariant has an allowlist for files where
 *     the literal appears as a tool-name identifier (e.g., the
 *     `name: "discover_tools"` field in the `ToolDefinition` returned by
 *     `createDiscoverTool`, the demotion-skip identifier in `tool-lifecycle.ts`,
 *     and the discovery-handoff message text where the public tool name is the
 *     stable API the LLM calls), NOT the provider-branched prompt teaching
 *     scrubbed by Plan 19-01. `tool_search_tool_regex` has an allowlist for
 *     `request-body-injector.ts` (the surviving Anthropic-payload-reshape
 *     file where the literal appears as a tool-name field in the API
 *     payload), `cache-break-detection.ts` (server-side-tool skip-list with
 *     the literal in comments + a `tool_search_tool_` prefix-match), and
 *     `stub-filter-injector.ts` (JSDoc explaining the payload-reshape
 *     interaction with the stub-filter).
 *   - Phase 20 (CAPINDEX-RENDER-15/16): will assert that
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

describe("@comis/agent -- architecture invariants (MCPNAME-03, DEFER-04)", () => {
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

  // ---------------------------------------------------------------------------
  // Phase 19 DEFER-04: forbidden-literal invariants
  // ---------------------------------------------------------------------------
  //
  // The "forbidden literal" here is provider-branched prompt teaching that
  // mentions `discover_tools` / `tool_search_tool_regex` (Plan 19-01 scrubbed
  // the ternary in tool-deferral.ts that named different tools per provider).
  // It is NOT every mention of these literals in production source — both
  // strings are also legitimate tool-name identifiers used as object keys,
  // string discriminants, and JSDoc cross-references. The allowlists below
  // catalogue every production file where the literals legitimately appear in
  // a tool-identifier context, so the test fires only on a NEW file that
  // re-introduces provider-branched prompt teaching (the design §6 regression
  // we want to catch pre-merge).

  it("DEFER-04: discover_tools literal absent from production source (excluding allowlist)", () => {
    // §10.6 inverted-cycle proof captured in 19-03-SUMMARY.md (Task 2 dance:
    // scratch violation `const _scratch_discover = "discover_tools";` planted
    // in packages/agent/src/safety/circuit-breaker.ts triggered failure
    // with that file's path in `result.matches`; scratch reverted; re-run
    // green). The committed state is green.
    //
    // Allowlist of files where "discover_tools" legitimately appears as a
    // tool-name identifier (NOT provider-branched prompt teaching). Any file
    // outside this list that contains the literal is a regression of design
    // §3 non-goal #2 / §6 (the Phase 19 mechanism-neutral teaching surgery
    // in tool-deferral.ts / executor-tool-assembly.ts).
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "discover_tools",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "fixtures"],
      excludeFileSuffixes: [".test.ts"],
    });
    const ALLOWED_FILES = [
      // Tool-name-table contexts (the canonical home of the tool-name string).
      "tool-descriptions.ts",   // tool-name -> description map (entries for the discover_tools tool) + skill-install handoff
      "tool-lifecycle.ts",      // demotion-skip identifier: `if (toolName === "discover_tools") continue`
      "tool-deferral.ts",       // names "discover_tools" as the ToolDefinition.name in createDiscoverTool
      "tool-parallelism.ts",    // discover_tools in the parallelism-allowed tool-name list
      // Discovery-handoff identifiers — the public tool name is the stable
      // API the LLM calls; these references name the tool by its public
      // identifier, not provider-branched teaching.
      "tool-retry-breaker.ts",     // skill-install error-recovery handoff message names discover_tools as the discovery API
      "executor-tool-pipeline.ts", // deferred-tool stub result hints "Call discover_tools with query <select:...>"
      "executor-tool-assembly.ts", // comment about rebuilding discover_tools post-deferral
      "executor-post-execution.ts", // comment about stripping discover_tools result schemas
      "schema-stripping.ts",       // tool-name discriminant: `msg.toolName !== "discover_tools"`
      "discovery-tracker.ts",      // JSDoc explaining the session-scoped tracker tied to discover_tools
      "pi-executor.ts",            // JSDoc + comments referring to discover_tools as a known concept (mid-turn injection)
      // Anthropic payload-reshape identifiers.
      "request-body-injector.ts",  // payload reshape removes the client-side discover_tools tool name
      "stub-filter-injector.ts",   // JSDoc explaining stub-filter interaction with discover_tools removal
    ];
    const offenders = result.matches.filter(
      (m) => !ALLOWED_FILES.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "discover_tools literal must not appear outside the tool-identifier-context allowlist " +
        "— design §3 non-goal #2 / §6 (a new file containing this literal is most likely " +
        "provider-branched prompt teaching, the regression class Plan 19-01 scrubbed)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  it("DEFER-04: tool_search_tool_regex literal absent from production source (excluding allowlist)", () => {
    // §10.6 inverted-cycle proof captured in 19-03-SUMMARY.md (Task 2 dance:
    // scratch violation `const _scratch_tsr = "tool_search_tool_regex";`
    // planted in packages/agent/src/safety/circuit-breaker.ts triggered
    // failure with that file's path in `result.matches`; scratch reverted;
    // re-run green). The committed state is green.
    //
    // Allowlist of files where "tool_search_tool_regex" legitimately appears
    // as a tool-identifier in the Anthropic API payload reshape (NOT prompt
    // teaching shipped to the model). Three legitimate carriers, all in the
    // payload-reshape / cache-detection layer:
    //   - request-body-injector.ts — appends the server-side tool to the API
    //     payload (type discriminant + name field) when supportsToolSearch
    //     gates a tool-search-eligible model.
    //   - cache-break-detection.ts — skip-list comments + per-tool-hash skip
    //     for server-side tools that lack input_schema (the literal appears
    //     in comments naming what gets skipped; the runtime check uses the
    //     `tool_search_tool_` prefix).
    //   - stub-filter-injector.ts — JSDoc cross-reference explaining how the
    //     stub-filter interacts with the payload-reshape that appends this
    //     tool to the rendered Anthropic payload.
    // The supportsToolSearch gate in tool-deferral.ts (DEFER-03 surviving-
    // caller branch) routes invocations of this reshape through
    // request-body-injector.ts.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "tool_search_tool_regex",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "fixtures"],
      excludeFileSuffixes: [".test.ts"],
    });
    const ALLOWED_FILES = [
      "request-body-injector.ts",  // surviving Anthropic-payload-reshape file (DEFER-03)
      "cache-break-detection.ts",  // server-side-tool skip-list comments + tool_search_tool_ prefix-match
      "stub-filter-injector.ts",   // JSDoc cross-reference to the payload reshape
    ];
    const offenders = result.matches.filter(
      (m) => !ALLOWED_FILES.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "tool_search_tool_regex literal must not appear outside the allowlist " +
        "(request-body-injector.ts, cache-break-detection.ts, stub-filter-injector.ts) " +
        "— design §3 non-goal #2 / §6",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });
});
