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
 *   - Phase 20 (CAPINDEX-RENDER-16, DONE): asserts that `prompt-assembly.ts`
 *     does NOT import `capability-index-context.ts` AND does NOT call the
 *     two live-runtime port accessors that mutate between turns —
 *     cache-fence Pitfall 1 enforcement at the source-grep boundary.
 *     `assemblerParams` MUST stay free of live-runtime accessors so the
 *     cached system-prompt prefix remains byte-identical when the skill
 *     registry reloads between turns. The config-derived
 *     `capabilityIndexEnabled` boolean IS allowed inside `assemblerParams`
 *     because it is operator-only/restart-required and stable across the
 *     session — the grep targets only LIVE-RUNTIME accessors.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

describe("@comis/agent -- architecture invariants (MCPNAME-03, DEFER-04, CAPINDEX-RENDER-16, WIRING-10)", () => {
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

  // ---------------------------------------------------------------------------
  // Phase 20 — CAPINDEX-RENDER-16: cache-fence invariant (Pitfall 1, the
  // highest-cost regression class in the v1.1 milestone).
  // ---------------------------------------------------------------------------
  //
  // `prompt-assembly.ts` builds the cached system-prompt prefix via
  // `assembleRichSystemPrompt(assemblerParams)`. The prefix MUST stay
  // byte-identical across turns; if a skill discovery sweep mutates a value
  // that flows into `assemblerParams`, the Anthropic prompt-cache prefix
  // invalidates every turn and the cost of the agent doubles or worse.
  //
  // The forbidden symbols are:
  //   - the renderer module name (importing it from prompt-assembly.ts is
  //     itself the regression — the renderer is per-turn dynamic, not
  //     cached prefix.)
  //   - the live-runtime skill-catalog accessor (mutates between turns when
  //     skills are created/deleted/reloaded.)
  //   - the live-runtime MCP-server accessor (mutates between turns when
  //     servers connect/disconnect.)
  //
  // `capabilityIndexEnabled` (a config-derived BOOLEAN, restart-required) IS
  // allowed inside `assemblerParams` — config-derived values are stable
  // across the session by design. The grep below targets the LIVE-RUNTIME
  // accessors only.

  it("CAPINDEX-RENDER-16: prompt-assembly.ts does NOT import capability-index-context or call live-runtime port accessors", () => {
    // §10.6 inverted-cycle proof — Plan 20-04 ran the dance:
    //   1. cp packages/agent/src/executor/prompt-assembly.ts /tmp/p20-cap-fence-backup.ts
    //   2. Append: import { buildCapabilityIndexContext as _scratchP20 } from "./capability-index-context.js";
    //   3. pnpm --filter @comis/agent exec vitest run src/__tests__/architecture
    //      => observed FAIL with "prompt-assembly.ts" in the offenders array
    //   4. cp /tmp/p20-cap-fence-backup.ts packages/agent/src/executor/prompt-assembly.ts
    //   5. diff: empty
    //   6. Re-run: GREEN
    //   7. Documented in 20-04-SUMMARY.md.
    //
    // The test scans the executor/ directory and filters for prompt-assembly.ts
    // so the failure message names exactly that file.
    const result = findInSourceFiles({
      rootDir: resolve(SRC_ROOT, "executor"),
      needle: /capability-index-context|getPromptSkillCapabilities|getConnectedMcpServers/,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => m.endsWith("prompt-assembly.ts"));
    expect(
      offenders,
      "prompt-assembly.ts must NOT import the capability-index renderer or " +
        "call ToolCapabilityPort live-runtime accessors " +
        "(getPromptSkillCapabilities, getConnectedMcpServers) — cache fence " +
        "(Pitfall 1; design §4.3 invariant). If the cache prefix invalidates " +
        "every turn, the Anthropic prompt-cache cost doubles or worse.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Phase 23 — WIRING-10a / -10b: production/test boundary for the
  // ToolCapabilityPort. The agent package only CONSUMES ToolCapabilityPort
  // (it never constructs one); these greps lock the test/prod crossover at
  // the source-grep boundary so a regression cannot ship in the published
  // comisai tarball via __test-helpers/ (NOT tsconfig-excluded — Pitfall 13).
  // ---------------------------------------------------------------------------

  it("WIRING-10a: production source does NOT import createCapabilityPortStub (Pitfall 13 — test/prod boundary)", () => {
    // §10.6 INVERTED-CYCLE PROOF (Phase 23 Plan 23-03): planted violation:
    //   1. cp packages/agent/src/safety/circuit-breaker.ts /tmp/p23-cb-backup.ts
    //   2. Append: import { createCapabilityPortStub } from "../../core/src/ports/__test-helpers/tool-capability-stub.js";
    //   3. Run: pnpm --filter @comis/agent exec vitest run src/__tests__/architecture.test.ts
    //      Expected: WIRING-10a fails with circuit-breaker.ts in offenders.
    //   4. cp /tmp/p23-cb-backup.ts packages/agent/src/safety/circuit-breaker.ts
    //   5. Run again: GREEN
    //   6. Document in 23-03-SUMMARY.md.
    //
    // Rationale (Pitfall 13): __test-helpers/ is NOT excluded by tsconfig;
    // the architecture-grep is the SOLE boundary keeping the stub out of the
    // published comisai tarball (via bundledDependencies). A production import
    // smuggles the stub into dist/ and ships to end-users.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createCapabilityPortStub",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "__test-helpers"],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/agent production source must not import createCapabilityPortStub " +
        "(use createNoOpCapabilityPort if a real adapter is unavailable; the agent " +
        "package itself only consumes ToolCapabilityPort, never constructs one — " +
        "see Phase 17 + Phase 23 architecture)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/agent").toBeGreaterThan(0);
  });

  it("WIRING-10b: test source files do NOT import createNoOpCapabilityPort (use createCapabilityPortStub from __test-helpers/ instead)", () => {
    // §10.6 INVERTED-CYCLE PROOF (Phase 23 Plan 23-03): planted violation:
    //   1. cp packages/agent/src/executor/capability-index-context.test.ts /tmp/p23-cic-backup.ts
    //   2. Insert: import { createNoOpCapabilityPort } from "@comis/core";
    //   3. Run: pnpm --filter @comis/agent exec vitest run src/__tests__/architecture.test.ts
    //      Expected: WIRING-10b fails with capability-index-context.test.ts
    //               in offenders (after the allowlist filter).
    //   4. cp /tmp/p23-cic-backup.ts packages/agent/src/executor/capability-index-context.test.ts
    //   5. Run again: GREEN
    //   6. Document in 23-03-SUMMARY.md.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    // Allowlist: this architecture.test.ts itself legitimately references the
    // literal (the planted-violation comment block above contains it, even in
    // green state). The plan deliberately keeps the allowlist minimal — any
    // OTHER test file containing the literal indicates a real bug (use
    // createCapabilityPortStub from @comis/core's __test-helpers/ instead).
    const ALLOWLIST = ["architecture.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "@comis/agent test files must use createCapabilityPortStub from @comis/core's " +
        "__test-helpers/ instead of createNoOpCapabilityPort — production no-op " +
        "factory is for daemon-side fallback only (see Plan 17-04 + Plan 23-03)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one test file in @comis/agent").toBeGreaterThan(0);
  });
});
