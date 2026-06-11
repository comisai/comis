// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/agent.
 *
 * Invariants enforced:
 *   - No inline `slice(5) + indexOf("--")` parser exists in
 *     `bridge/bridge-event-handlers.ts` or `executor/tool-deferral.ts` —
 *     only the canonical home in `@comis/shared`.
 *   - The `discover_tools` and `tool_search_tool_regex` literals do not
 *     appear in production source (excluding `__tests__/`, `__snapshots__/`,
 *     fixtures, and an explicit allowlist for tool-name-table /
 *     API-payload-reshape / tool-identifier files). The `discover_tools`
 *     invariant has an allowlist for files where the literal appears as a
 *     tool-name identifier (e.g., the `name: "discover_tools"` field in the
 *     `ToolDefinition` returned by `createDiscoverTool`, the demotion-skip
 *     identifier in `tool-lifecycle.ts`, and the discovery-handoff message
 *     text where the public tool name is the stable API the LLM calls), NOT
 *     provider-branched prompt teaching. `tool_search_tool_regex` has an
 *     allowlist for `request-body/tool-deferral-injection.ts` (the surviving
 *     Anthropic-payload-reshape file where the literal appears as a
 *     tool-name field in the API payload), `request-body/types.ts`
 *     (JSDoc reference on the deferred-tools config option),
 *     `cache-detection/anthropic-extractor.ts` (server-side-tool skip-list
 *     with the literal in comments + a `tool_search_tool_` prefix-match),
 *     and `stub-filter-injector.ts` (JSDoc explaining the payload-reshape
 *     interaction with the stub-filter).
 *   - `prompt-assembly.ts` does NOT import `capability-index-context.ts`
 *     AND does NOT call the two live-runtime port accessors that mutate
 *     between turns — cache-fence enforcement at the source-grep boundary.
 *     `assemblerParams` MUST stay free of live-runtime accessors so the
 *     cached system-prompt prefix remains byte-identical when the skill
 *     registry reloads between turns. Only LIVE-RUNTIME accessors are
 *     forbidden; config-derived booleans no longer flow through
 *     `assemblerParams`.
 *   - `bootstrap/` and `workspace/` directories remain agent-owned.
 *     Both directories are executor support (LLM system-prompt assembly
 *     + ~/.comis/ filesystem-layout management), NOT inbound message
 *     handling. A future PR that moves either directory to orchestrator
 *     fails CI at the existsSync boundary below.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as ts from "typescript";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const PKG_ROOT = resolve(SRC_ROOT, "..");

// Audit-coverage paths. The audit doc at packages/agent/AUDIT.md mirrors
// packages/orchestrator/AUDIT.md and is parsed by the architecture test
// below to assert bidirectional set equality between SubAgentRunnerDeps
// fields and the audit table.
const AUDIT_PATH = resolve(PKG_ROOT, "AUDIT.md");
const SUB_AGENT_RUNNER_PATH = resolve(SRC_ROOT, "spawn/sub-agent-runner.ts");

describe("@comis/agent -- architecture invariants", () => {
  // FORBIDDEN_PARSER_RE: catches the canonical inline mcp__server--tool parser shape
  // (`.slice(5)` followed by `.indexOf("--")` within ~200 characters). No production
  // file in @comis/agent matches this pattern; the canonical home is
  // `packages/shared/src/mcp-tool-name.ts`.
  const FORBIDDEN_PARSER_RE = /\.slice\(5\)[\s\S]{0,200}\.indexOf\(["']--["']\)/;

  it("bridge/bridge-event-handlers.ts has no inline mcp__...--... parser", () => {
    // The walk is scoped to bridge/ rather than the whole package because (a) test
    // isolation — failure messages name exactly bridge/* files; (b) other invariants
    // scoped to executor/ benefit from a separate it().
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

  it("executor/tool-deferral.ts has no inline mcp__...--... parser", () => {
    // The test file remains independent of the bridge/ test so failure messages
    // name exactly one directory.
    const result = findInSourceFiles({
      rootDir: resolve(SRC_ROOT, "executor"),
      needle: FORBIDDEN_PARSER_RE,
      excludeFileSuffixes: [".test.ts"],
    });
    const offenders = result.matches.filter((m) => m.endsWith("tool-deferral.ts"));
    expect(
      offenders,
      "tool-deferral.ts must import extractMcpServerName from @comis/shared",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one file in executor/").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Forbidden-literal invariants
  // ---------------------------------------------------------------------------
  //
  // The "forbidden literal" here is provider-branched prompt teaching that
  // mentions `discover_tools` / `tool_search_tool_regex` (the ternary in
  // tool-deferral.ts that named different tools per provider was scrubbed).
  // It is NOT every mention of these literals in production source — both
  // strings are also legitimate tool-name identifiers used as object keys,
  // string discriminants, and JSDoc cross-references. The allowlists below
  // catalogue every production file where the literals legitimately appear in
  // a tool-identifier context, so the test fires only on a NEW file that
  // re-introduces provider-branched prompt teaching (the regression class we
  // want to catch pre-merge).

  it("discover_tools literal absent from production source (excluding allowlist)", () => {
    // Allowlist of files where "discover_tools" legitimately appears as a
    // tool-name identifier (NOT provider-branched prompt teaching). Any file
    // outside this list that contains the literal is a regression of the
    // mechanism-neutral teaching surgery in tool-deferral.ts /
    // executor-tool-assembly.ts.
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
      "scaffold-defaults.ts",      // JSDoc on SMALL_DEFAULT_ACTIVE_TOOL_CEILING: "defers cold long-tail behind discover_tools"
      "pi-executor.ts",            // JSDoc + comments referring to discover_tools as a known concept (mid-turn injection)
      "pi-executor-types.ts",      // PiExecutorDeps interface JSDoc references discover_tools concept
      "viable-floor.ts",           // FLOOR-01 boot-WARN dominance hint names discover_tools as the discovery API (active-tool-ceiling lever)
      // Anthropic payload-reshape identifiers.
      "tool-deferral-injection.ts", // payload reshape removes the client-side discover_tools tool name
      "stub-filter-injector.ts",   // JSDoc explaining stub-filter interaction with discover_tools removal
    ];
    const offenders = result.matches.filter(
      (m) => !ALLOWED_FILES.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "discover_tools literal must not appear outside the tool-identifier-context allowlist " +
        "— a new file containing this literal is most likely provider-branched prompt teaching, " +
        "the regression class scrubbed from production source",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  it("tool_search_tool_regex literal absent from production source (excluding allowlist)", () => {
    // Allowlist of files where "tool_search_tool_regex" legitimately appears
    // as a tool-identifier in the Anthropic API payload reshape OR
    // in the deferred-tools prompt teaching that explicitly
    // names the discovery tool. Five legitimate carriers:
    //   - request-body/tool-deferral-injection.ts — appends the server-side
    //     tool to the API payload (type discriminant + name field) when
    //     supportsToolSearch gates a tool-search-eligible model.
    //   - request-body/types.ts — JSDoc on the config option naming the tool.
    //   - cache-detection/anthropic-extractor.ts — skip-list comments + per-tool-hash
    //     skip for server-side tools that lack input_schema (the literal appears
    //     in comments naming what gets skipped; the runtime check uses the
    //     `tool_search_tool_` prefix).
    //   - stub-filter-injector.ts — JSDoc cross-reference explaining how the
    //     stub-filter interacts with the payload-reshape that appends this
    //     tool to the rendered Anthropic payload.
    //   - tool-deferral.ts — `buildDeferredToolsContext` instruction names
    //     `tool_search_tool_regex` (Sonnet/Opus 4.x path) AND `discover_tools`
    //     (other models) so the model has a concrete discovery tool to call
    //     instead of the pre-flip "discovery mechanism available in your
    //     active toolspace" pointer. Provider branching is acceptable here:
    //     the prompt teaches both paths because the actual carrier swap
    //     happens inside `request-body/tool-deferral-injection.ts` and the
    //     model only invokes whichever one is present in its toolspace.
    // The supportsToolSearch gate in tool-deferral.ts (surviving-caller
    // branch) routes invocations of this reshape through
    // request-body/tool-deferral-injection.ts.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "tool_search_tool_regex",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "fixtures"],
      excludeFileSuffixes: [".test.ts"],
    });
    const ALLOWED_FILES = [
      "tool-deferral-injection.ts", // request-body/ payload-reshape module
      "request-body/types.ts",     // JSDoc reference on the deferred-tools config option
      "anthropic-extractor.ts",    // cache-detection/ extractor module
      "stub-filter-injector.ts",   // JSDoc cross-reference to the payload reshape
      "tool-deferral.ts",          // deferred-tools instruction names both discovery tools
    ];
    const offenders = result.matches.filter(
      (m) => !ALLOWED_FILES.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "tool_search_tool_regex literal must not appear outside the allowlist " +
        "(request-body/tool-deferral-injection.ts, request-body/types.ts, " +
        "cache-detection/anthropic-extractor.ts, stub-filter-injector.ts, " +
        "tool-deferral.ts)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Cache-fence invariant — the highest-cost regression class.
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
  // The grep below targets the LIVE-RUNTIME accessors only — config-derived
  // booleans no longer flow through `assemblerParams`.

  it("prompt-assembly.ts does NOT import capability-index-context or call live-runtime port accessors", () => {
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
        "invariant. If the cache prefix invalidates every turn, the " +
        "Anthropic prompt-cache cost doubles or worse.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Production/test boundary for the ToolCapabilityPort. The agent package
  // only CONSUMES ToolCapabilityPort (it never constructs one); these greps
  // lock the test/prod crossover at the source-grep boundary so a regression
  // cannot ship in the published comisai tarball via __test-helpers/ (NOT
  // tsconfig-excluded).
  // ---------------------------------------------------------------------------

  it("production source does NOT import createCapabilityPortStub (test/prod boundary)", () => {
    // Rationale: __test-helpers/ is NOT excluded by tsconfig; the
    // architecture-grep is the SOLE boundary keeping the stub out of the
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
        "package itself only consumes ToolCapabilityPort, never constructs one)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file in @comis/agent").toBeGreaterThan(0);
  });

  it("test source files do NOT import createNoOpCapabilityPort (use createCapabilityPortStub from __test-helpers/ instead)", () => {
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "createNoOpCapabilityPort",
      extensions: [".test.ts"],
    });
    // Allowlist: this architecture.test.ts itself legitimately references the
    // literal (the rationale comment block above contains it). The allowlist
    // is deliberately minimal — any OTHER test file containing the literal
    // indicates a real bug (use createCapabilityPortStub from @comis/core's
    // __test-helpers/ instead).
    const ALLOWLIST = ["architecture.test.ts"];
    const offenders = result.matches.filter(
      (m) => !ALLOWLIST.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "@comis/agent test files must use createCapabilityPortStub from @comis/core's " +
        "__test-helpers/ instead of createNoOpCapabilityPort — the production no-op " +
        "factory is for daemon-side fallback only",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one test file in @comis/agent").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Logger contract types canonically live in @comis/core. Agent production
  // source must import them from @comis/core, not @comis/infra (the
  // runtime-Pino package). The package no longer has an @comis/infra dep;
  // any production source with a stale `from "@comis/infra"` import would
  // fail `pnpm build`. This rule guards the regression at the source-grep
  // boundary so a future edit is caught pre-merge instead of pre-publish.
  // ---------------------------------------------------------------------------

  it("imports logger contract types from @comis/core, not @comis/infra", () => {
    const { violations, checkedFiles } = findForbiddenImports({
      rootDir: SRC_ROOT,
      forbiddenPackage: "@comis/infra",
    });
    expect(
      violations,
      formatViolations({
        description:
          "@comis/agent production source must import logger contract types (ComisLogger, LogFields, ErrorKind) from @comis/core, not @comis/infra.",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          column: v.column,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core.",
      }),
    ).toEqual([]);
    expect(
      checkedFiles,
      "sanity: findForbiddenImports walked at least one agent/src file",
    ).toBeGreaterThan(0);
  });

  it("agent/tsconfig.json and agent/package.json do not reference @comis/infra", () => {
    const tsconfigPath = resolve(PKG_ROOT, "tsconfig.json");
    const packageJsonPath = resolve(PKG_ROOT, "package.json");
    const tsconfigContent = readFileSync(tsconfigPath, "utf8");
    const packageJsonContent = readFileSync(packageJsonPath, "utf8");
    expect(
      tsconfigContent.includes("@comis/infra") ||
        tsconfigContent.includes('"path": "../infra"'),
      "agent/tsconfig.json must not reference @comis/infra. " +
        "If a logger contract type is needed, import it from @comis/core; the runtime Pino " +
        "factory belongs in @comis/daemon's wiring, not @comis/agent.",
    ).toBe(false);
    expect(
      packageJsonContent.includes("@comis/infra"),
      "agent/package.json must not depend on @comis/infra. " +
        "agent's logger contract usage is type-only and resolves through @comis/core.",
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Agent has zero memory production imports.
  //
  // SessionStorePort + its 3 Session* row DTOs live in @comis/core; agent
  // production source imports them from @comis/core. (The DAG ContextStorePort +
  // the 9 Ctx*Row DTOs were removed in v2.12, Phase 126.) The OAuth credential
  // store selector is rewritten to consume a daemon-injected encryptedStore
  // port, so no value-import into @comis/memory remains.
  // ---------------------------------------------------------------------------

  describe("agent -> memory cut", () => {
    // The OAuth credential store selector consumes a daemon-injected
    // encryptedStore port; the memory value-import moved to daemon's
    // setup-agents.ts. Empty array means the architecture invariant
    // asserts ZERO agent -> memory production imports going forward.
    const MEMORY_ALLOWLIST: readonly string[] = [];

    it("production source does NOT import @comis/memory", () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: "@comis/memory",
        allowlistPaths: [...MEMORY_ALLOWLIST],
      });
      expect(
        violations,
        formatViolations({
          description:
            "@comis/agent production source must not import @comis/memory. SessionStore->SessionStorePort plus the 3 Session* row DTOs live in @comis/core. The lone value-import (createOAuthProfileStoreEncrypted) moved to daemon's setup-agents.ts -- the agent selector now consumes an injected encryptedStore port.",
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            'Replace `from "@comis/memory"` with `from "@comis/core"`. Rename SessionStore->SessionStorePort at use sites. For OAuth-store construction, inject an OAuthCredentialStorePort from the daemon composition (setup-agents.ts already owns the createOAuthProfileStoreEncrypted call site).',
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one agent/src file",
      ).toBeGreaterThan(0);
    });

    it("agent/tsconfig.json and agent/package.json dependencies do NOT reference @comis/memory", () => {
      const tsconfigPath = resolve(PKG_ROOT, "tsconfig.json");
      const packageJsonPath = resolve(PKG_ROOT, "package.json");
      const tsconfigContent = readFileSync(tsconfigPath, "utf8");
      const packageJsonContent = readFileSync(packageJsonPath, "utf8");

      // tsconfig.json: no reference to ../memory anywhere.
      expect(
        tsconfigContent,
        "agent/tsconfig.json must not reference ../memory. " +
          "The runtime OAuth-store factory moved to daemon composition; agent's production source resolves all memory-domain types through @comis/core.",
      ).not.toMatch(/"path":\s*"\.\.\/memory"/);

      // package.json: `dependencies` block must NOT contain @comis/memory.
      // `devDependencies` retention is permitted because co-located test
      // files still need memory's factories; the production invariant
      // excludes .test.ts via findForbiddenImports' default suffix filter.
      const pkg = JSON.parse(packageJsonContent) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(
        pkg.dependencies?.["@comis/memory"],
        "agent/package.json `dependencies` must not include @comis/memory. " +
          "devDependencies retention is permitted for co-located test compilation.",
      ).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // OAuth helpers (resolveCodexAuthIdentity, rewriteOAuthError,
  // redactEmailForLog, decodeCodexJwtPayload, resolveCodexStableSubject,
  // resolveCodexAccessTokenExpiry, OAuthErrorCode, RewrittenOAuthError) live
  // in @comis/core/src/security/oauth-helpers.ts. Agent production source
  // must import them from @comis/core; the agent-local model/oauth-identity.ts
  // and model/oauth-errors.ts files do not exist.
  // ---------------------------------------------------------------------------

  it("does not import resolveCodexAuthIdentity, rewriteOAuthError, redactEmailForLog from its own model/oauth-* files", () => {
    // The agent-local oauth-identity.ts + oauth-errors.ts source files do
    // not exist; any production source still importing from them via
    // relative path is a regression that would also fail the build, but
    // the source-grep catches it pre-build with a clearer message.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /from\s+"\.\/(oauth-identity|oauth-errors)\.js"|from\s+"\.\.\/model\/(oauth-identity|oauth-errors)\.js"/,
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/agent production source must not import from ./oauth-identity.js or ./oauth-errors.js. " +
        "Import from \"@comis/core\" instead.",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one agent/src file").toBeGreaterThan(0);
  });

  it("imports oauth helpers from @comis/core", () => {
    // Assert at least one production source file imports rewriteOAuthError,
    // resolveCodexAuthIdentity, or redactEmailForLog from @comis/core. This
    // is the consumer-side mirror of the export-side rule in
    // packages/core/src/__tests__/architecture.test.ts (which asserts the
    // helpers exist in core/src/security/oauth-helpers.ts).
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /(rewriteOAuthError|resolveCodexAuthIdentity|redactEmailForLog|resolveCodexAccessTokenExpiry)[\s\S]{0,200}from\s+"@comis\/core"/,
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches.length,
      "@comis/agent production source must import oauth helpers (rewriteOAuthError | resolveCodexAuthIdentity | " +
        "redactEmailForLog | resolveCodexAccessTokenExpiry) from @comis/core (single source).",
    ).toBeGreaterThan(0);
    expect(result.checkedFiles, "sanity: helper walked at least one agent/src file").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Agent directory ownership: agent/src/bootstrap/ + agent/src/workspace/
  // contain executor support (LLM system-prompt assembly + ~/.comis/
  // filesystem-layout management), not inbound message handling. Cross-
  // package consumers (cli/src/commands/agent.ts for workspace lifecycle,
  // daemon/src/wiring/setup-heartbeat.ts for heartbeat empty-detection)
  // reach these surfaces through the @comis/agent barrel, never through
  // cross-package direct paths. The orchestrator package references
  // "bootstrap" only via a deps callback (getBootstrapInfo) supplied
  // externally — no module-import edge into agent/src/bootstrap/.
  //
  // The existsSync assertions below freeze that ownership at the source-
  // grep boundary: a future PR that accidentally moves either directory to
  // @comis/orchestrator (or anywhere outside packages/agent/src/) fails CI
  // here instead of surfacing as a regression at integration time.
  //
  // The expected-file lists are intentionally minimal — they name the
  // load-bearing files only (the barrel + the 4-5 highest-traffic modules
  // per directory). Adding a new file to either directory does NOT require
  // updating this test; deleting one of the listed files DOES, because
  // deletion is the regression class this test is designed to catch.
  // ---------------------------------------------------------------------------

  describe("agent directory ownership", () => {
    it("bootstrap/ remains agent-owned (executor prompt assembly, not inbound)", () => {
      const bootstrapDir = resolve(SRC_ROOT, "bootstrap");
      expect(
        existsSync(bootstrapDir),
        "packages/agent/src/bootstrap/ must exist (executor prompt assembly stays in agent). " +
          "NO file in this directory is inbound-only; every file is LLM system-prompt assembly support.",
      ).toBe(true);

      // Sanity: the barrel + the load-bearing modules are present. Adding
      // new files is allowed; deleting one of these is a regression.
      const expectedFiles = [
        "index.ts",
        "system-prompt-assembler.ts",
        "workspace-loader.ts",
        "section-extractor.ts",
        "types.ts",
      ];
      for (const f of expectedFiles) {
        expect(
          existsSync(resolve(bootstrapDir, f)),
          `${f} must exist in packages/agent/src/bootstrap/ (agent-owned).`,
        ).toBe(true);
      }
    });

    it("workspace/ remains agent-owned (executor workspace runtime, not inbound)", () => {
      const workspaceDir = resolve(SRC_ROOT, "workspace");
      expect(
        existsSync(workspaceDir),
        "packages/agent/src/workspace/ must exist (executor workspace runtime stays in agent). " +
          "Like bootstrap/, this directory is filesystem-layout management for ~/.comis/, " +
          "not inbound message handling.",
      ).toBe(true);

      // Sanity: the barrel + the load-bearing modules are present.
      const expectedFiles = [
        "index.ts",
        "workspace-manager.ts",
        "boot-file.ts",
        "data-env.ts",
      ];
      for (const f of expectedFiles) {
        expect(
          existsSync(resolve(workspaceDir, f)),
          `${f} must exist in packages/agent/src/workspace/ (agent-owned).`,
        ).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Hard-forbid `proper-lockfile` from agent production source.
  //
  // Agent production source has zero imports of proper-lockfile; FileLockPort
  // is injected through deps. proper-lockfile lives in `devDependencies`
  // only. The `export { createFileLock } from "@comis/scheduler"` re-export
  // was removed; the package-graph edge is severed.
  //
  // @comis/scheduler is NOT promoted to HARD_FORBIDDEN here because agent
  // production source still consumes `computeNextRunAtMs`,
  // `createSystemEventQueue`, and `WakeReasonKind` from scheduler at the
  // value-import level (`session-reset-policy.ts`, `executor/spawn/...`).
  // The lockfile-edge is the only one that needed cutting; the other
  // scheduler-symbol edges are by-design.
  // ---------------------------------------------------------------------------

  const HARD_FORBIDDEN_PACKAGES = ["proper-lockfile"] as const;

  for (const forbidden of HARD_FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/agent production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "Consume the `FileLockPort` abstraction via deps injection instead. " +
            "createFileLock() (from @comis/core) is the canonical adapter; the " +
            "daemon composition root constructs one instance and threads it " +
            "through OAuthTokenManagerDeps / OAuthCredentialStoreFileConfig / " +
            "ComisSessionManagerDeps. See `packages/daemon/src/wiring/setup-agents.ts` " +
            "for the wiring pattern.",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one agent/src file",
      ).toBeGreaterThan(0);
    });
  }

  // ---------------------------------------------------------------------------
  // SubAgentRunnerDeps audit-coverage. Mirrors
  // packages/orchestrator/src/__tests__/architecture.test.ts. The audit doc
  // at packages/agent/AUDIT.md must align row-for-row with SubAgentRunnerDeps;
  // CI failure on field drift forces audit refresh.
  // ---------------------------------------------------------------------------

  it("every SubAgentRunnerDeps field appears in the agent AUDIT.md audit table", () => {
    // 1. Parse the audit Markdown table at packages/agent/AUDIT.md.
    const auditContent = readFileSync(AUDIT_PATH, "utf8");
    const tableLines = auditContent
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("|-"));
    // Skip the header row (first line); subsequent lines are data rows.
    // Header text uses bold markdown (`**Field**`, `**Classification**`, ...) so
    // ordinary field-name rows do not collide with the header.
    const rows = tableLines
      .slice(1)
      .map((l) => {
        const cells = l.split("|").map((s) => s.trim());
        return {
          field: cells[1] ?? "",
          classification: cells[2] ?? "",
          whenAbsent: cells[3] ?? "",
          evidenceLink: cells[4] ?? "",
        };
      })
      .filter((r) => r.field.length > 0 && !r.field.startsWith("**"));

    // 2. Parse the SubAgentRunnerDeps interface body via regex.
    const srContent = readFileSync(SUB_AGENT_RUNNER_PATH, "utf8");
    const interfaceMatch = srContent.match(
      /export interface SubAgentRunnerDeps\s*\{([\s\S]*?)^\}/m,
    );
    expect(
      interfaceMatch,
      `SubAgentRunnerDeps interface not found in ${SUB_AGENT_RUNNER_PATH}`,
    ).not.toBeNull();
    const body = interfaceMatch![1];
    const fieldRegex = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)(\??):/gm;
    const interfaceFields = new Map<string, "required" | "optional">();
    let m: RegExpExecArray | null;
    while ((m = fieldRegex.exec(body)) !== null) {
      interfaceFields.set(m[1], m[2] === "?" ? "optional" : "required");
    }

    // 3. Bidirectional set equality between audit rows and interface fields.
    const auditFieldNames = new Set(rows.map((r) => r.field));
    const interfaceFieldNames = new Set(interfaceFields.keys());
    const inAuditOnly = [...auditFieldNames].filter(
      (f) => !interfaceFieldNames.has(f),
    );
    const inInterfaceOnly = [...interfaceFieldNames].filter(
      (f) => !auditFieldNames.has(f),
    );
    expect(
      inAuditOnly,
      `AUDIT.md has fields not in SubAgentRunnerDeps: ${inAuditOnly.join(", ")}`,
    ).toEqual([]);
    expect(
      inInterfaceOnly,
      `SubAgentRunnerDeps has fields not in AUDIT.md: ${inInterfaceOnly.join(", ")}`,
    ).toEqual([]);

    // 4. No forbidden "delete-this-field" classification values; every row must
    //    classify as `required` or `optional` (the third "stale-fallback" value
    //    is forbidden as a terminal classification at every commit).
    const forbidden = rows.filter(
      (r) =>
        r.classification !== "required" && r.classification !== "optional",
    );
    expect(
      forbidden,
      `every row must classify as required|optional; bad rows: ${forbidden
        .map((r) => `${r.field}=${r.classification}`)
        .join(", ")}`,
    ).toEqual([]);

    // 5. Classification matches optional/required from the interface.
    const mismatches: string[] = [];
    for (const r of rows) {
      const expected = interfaceFields.get(r.field);
      if (!expected) continue; // covered by set-equality above
      if (r.classification !== expected) {
        mismatches.push(
          `${r.field}: audit=${r.classification} interface=${expected}`,
        );
      }
    }
    expect(
      mismatches,
      `classification mismatches: ${mismatches.join("; ")}`,
    ).toEqual([]);

    // 6. Every row has a non-empty evidence-link cell.
    const missingEvidence = rows.filter(
      (r) => !r.evidenceLink || r.evidenceLink === "",
    );
    expect(
      missingEvidence,
      `rows missing evidence-link: ${missingEvidence
        .map((r) => r.field)
        .join(", ")}`,
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Closure-extraction + dependency-direction structural invariants for the
  // pi-executor + prompt-runner splits.
  //
  // Until the target subdirectories exist on disk, both tests are vacuously
  // satisfied (early-return on !existsSync(dir)). Once the directories
  // materialize, the assertions enforce their respective invariants.
  // ---------------------------------------------------------------------------

  /**
   * Closure-extraction protocol enforcement.
   *
   * Every helper extracted from createPiExecutor's closure body (under
   * pi-executor/) takes its state via an explicit first parameter named
   * `state` typed as a Readonly<...> shape — not via closure capture.
   * This catches silent state-drift regressions where a refactor moves
   * code out of the factory closure while leaving closure-captured
   * variables intact.
   *
   * Exempt files: index.ts, pi-executor.ts (the factory itself);
   * before-tool-call-guard.ts and session-stats.ts (co-equal top-level
   * functions that already take named typed parameters); types.ts
   * (type-only collection file); execution-plan-holder.ts (a standalone
   * ExecutionPlanPort holder factory that owns its
   * OWN per-instance live ref; it is NOT a helper extracted from
   * createPiExecutor's closure and reads no PiExecutorState, so the
   * `state`-first contract does not apply — same posture as the co-equal
   * top-level functions above).
   *
   * If the pi-executor/ directory does not exist yet, the assertion is
   * vacuously satisfied.
   */
  it("pi-executor extracted helpers accept state by parameter", () => {
    const piExecutorDir = resolve(SRC_ROOT, "executor/pi-executor");
    if (!existsSync(piExecutorDir)) {
      // Vacuously satisfied pre-split — directory will materialize when the
      // pi-executor split lands.
      expect([]).toEqual([]);
      return;
    }
    const helperFiles = readdirSync(piExecutorDir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "index.ts" &&
        f !== "pi-executor.ts" &&
        f !== "before-tool-call-guard.ts" &&
        f !== "session-stats.ts" &&
        f !== "types.ts" &&
        f !== "execution-plan-holder.ts",
    );
    const violations: Array<{ file: string; export: string; reason: string }> =
      [];
    for (const file of helperFiles) {
      const source = readFileSync(resolve(piExecutorDir, file), "utf8");
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.ES2023,
        true,
      );
      ts.forEachChild(sf, (node) => {
        if (
          ts.isFunctionDeclaration(node) &&
          node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
          )
        ) {
          const name = node.name?.text ?? "<anonymous>";
          const firstParam = node.parameters[0];
          if (
            !firstParam ||
            !ts.isIdentifier(firstParam.name) ||
            firstParam.name.text !== "state"
          ) {
            violations.push({
              file,
              export: name,
              reason:
                "First parameter must be `state` (closure-extraction protocol)",
            });
          }
        }
      });
    }
    expect(
      violations,
      formatViolations({
        description:
          "Every exported function in packages/agent/src/executor/pi-executor/ (excluding index.ts, pi-executor.ts, before-tool-call-guard.ts, session-stats.ts, types.ts) must accept its state via an explicit first parameter named `state`. Closure capture silently breaks under code motion — the explicit-state contract makes every helper independently testable and immune to drift.",
        violations: violations.map((v) => ({
          file: `executor/pi-executor/${v.file}`,
          line: 0,
          snippet: `export function ${v.export}(... ) — ${v.reason}`,
        })),
        suggestedFix:
          "Reshape the helper to `export function <name>(state: Readonly<PiExecutorState>, ...args)`. The state shape is defined alongside the factory; helpers should read from `state` instead of closure-capturing values.",
      }),
    ).toEqual([]);
  });

  /**
   * Prompt-runner dependency-direction.
   *
   * Modules extracted from executor-prompt-runner.ts into prompt-runner/
   * (other than prompt-runner.ts itself and index.ts) must not import
   * from prompt-runner.ts. The dependency arrow points inward: the thin
   * orchestrator (prompt-runner.ts) calls into leaf modules; leaves
   * never call back into the orchestrator. A cycle here re-creates the
   * mega-function smell at the package boundary.
   *
   * If the prompt-runner/ directory does not exist yet, the assertion is
   * vacuously satisfied.
   */
  it("prompt-runner leaf modules do not import from prompt-runner.ts", () => {
    const promptRunnerDir = resolve(SRC_ROOT, "executor/prompt-runner");
    if (!existsSync(promptRunnerDir)) {
      // Vacuously satisfied pre-split — directory will materialize when the
      // prompt-runner split lands.
      expect([]).toEqual([]);
      return;
    }
    const leafFiles = readdirSync(promptRunnerDir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "index.ts" &&
        f !== "prompt-runner.ts",
    );
    const violations: Array<{ file: string; importPath: string }> = [];
    for (const file of leafFiles) {
      const source = readFileSync(resolve(promptRunnerDir, file), "utf8");
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.ES2023,
        true,
      );
      ts.forEachChild(sf, (node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier.text;
          if (
            spec === "./prompt-runner.js" ||
            spec.endsWith("/prompt-runner.js")
          ) {
            violations.push({ file, importPath: spec });
          }
        }
      });
    }
    expect(
      violations,
      formatViolations({
        description:
          "Every leaf module under packages/agent/src/executor/prompt-runner/ (excluding index.ts and prompt-runner.ts) must NOT import from prompt-runner.ts. The orchestrator depends inward on leaves; leaves never depend back on the orchestrator.",
        violations: violations.map((v) => ({
          file: `executor/prompt-runner/${v.file}`,
          line: 0,
          snippet: `imports "${v.importPath}" — leaf modules must not depend on prompt-runner.ts`,
        })),
        suggestedFix:
          "Promote the shared symbol to prompt-runner-types.ts (type-only) or a sibling leaf module. Never let a leaf import back into the orchestrator file.",
      }),
    ).toEqual([]);
  });
});
