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
 *     allowlist for `request-body-injector.ts` (the surviving
 *     Anthropic-payload-reshape file where the literal appears as a
 *     tool-name field in the API payload), `cache-break-detection.ts`
 *     (server-side-tool skip-list with the literal in comments + a
 *     `tool_search_tool_` prefix-match), and `stub-filter-injector.ts`
 *     (JSDoc explaining the payload-reshape interaction with the
 *     stub-filter).
 *   - `prompt-assembly.ts` does NOT import `capability-index-context.ts`
 *     AND does NOT call the two live-runtime port accessors that mutate
 *     between turns — cache-fence enforcement at the source-grep boundary.
 *     `assemblerParams` MUST stay free of live-runtime accessors so the
 *     cached system-prompt prefix remains byte-identical when the skill
 *     registry reloads between turns. The config-derived
 *     `capabilityIndexEnabled` boolean IS allowed inside `assemblerParams`
 *     because it is operator-only/restart-required and stable across the
 *     session — the grep targets only LIVE-RUNTIME accessors.
 *   - `bootstrap/` and `workspace/` directories remain agent-owned per
 *     Phase 32 ORCH-EXT-09 audit (OQ-5). Both directories are executor
 *     support (LLM system-prompt assembly + ~/.comis/ filesystem-layout
 *     management), NOT inbound message handling. A future PR that moves
 *     either directory to orchestrator fails CI at the existsSync
 *     boundary below.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const PKG_ROOT = resolve(SRC_ROOT, "..");

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
        "— a new file containing this literal is most likely provider-branched prompt teaching, " +
        "the regression class scrubbed from production source",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  it("tool_search_tool_regex literal absent from production source (excluding allowlist)", () => {
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
    // The supportsToolSearch gate in tool-deferral.ts (surviving-caller
    // branch) routes invocations of this reshape through
    // request-body-injector.ts.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "tool_search_tool_regex",
      excludeDirs: ["__tests__", "__snapshots__", "dist", "node_modules", "fixtures"],
      excludeFileSuffixes: [".test.ts"],
    });
    const ALLOWED_FILES = [
      "request-body-injector.ts",  // surviving Anthropic-payload-reshape file
      "cache-break-detection.ts",  // server-side-tool skip-list comments + tool_search_tool_ prefix-match
      "stub-filter-injector.ts",   // JSDoc cross-reference to the payload reshape
    ];
    const offenders = result.matches.filter(
      (m) => !ALLOWED_FILES.some((allowed) => m.endsWith(allowed)),
    );
    expect(
      offenders,
      "tool_search_tool_regex literal must not appear outside the allowlist " +
        "(request-body-injector.ts, cache-break-detection.ts, stub-filter-injector.ts)",
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: helper walked at least one production source file").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Cache-fence invariant — the highest-cost regression class in the v1.1
  // milestone.
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
  // Phase 28 commit 2 (CORE-PORTS-05) — logger contract types canonically live
  // in @comis/core. agent production source must import them from @comis/core,
  // not @comis/infra (the runtime-Pino package). The package dropped its
  // @comis/infra dep in this commit; if any production source kept a stale
  // `from "@comis/infra"` import, `pnpm build` would fail (forcing function).
  // This rule guards the regression at the source-grep boundary so a future
  // edit is caught pre-merge instead of pre-publish.
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
          "Replace `import type { ComisLogger | LogFields | ErrorKind } from \"@comis/infra\"` with `... from \"@comis/core\"`. The Pino-free structural ComisLogger contract canonically lives in @comis/core after Phase 28 commit 2.",
        designRef:
          "design §5.2 step 2 / §5.4 step 2 (CORE-PORTS-05 / L12 closure)",
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
      "agent/tsconfig.json must not reference @comis/infra (Phase 28 commit 2 / CORE-PORTS-05). " +
        "If a logger contract type is needed, import it from @comis/core; the runtime Pino " +
        "factory belongs in @comis/daemon's wiring, not @comis/agent.",
    ).toBe(false);
    expect(
      packageJsonContent.includes("@comis/infra"),
      "agent/package.json must not depend on @comis/infra (Phase 28 commit 2 / CORE-PORTS-05). " +
        "agent's logger contract usage is type-only and resolves through @comis/core.",
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Phase 31 commit 3 (MEM-CTX-PORTS-01) — agent has zero memory production
  // imports outside the transient 1-site allowlist closed in commit 4.
  //
  // ContextStorePort + SessionStorePort + row DTOs (Ctx*Row + Session*) all
  // live in @comis/core after Phase 31 commits 1-2. Agent production source
  // imports them from @comis/core. The lone remaining memory import is the
  // value import at model/oauth-credential-store-selector.ts:23 (the encrypted
  // OAuth store factory); plan 31-04 rewrites the selector to consume an
  // injected encryptedStore port, dropping that import too.
  // ---------------------------------------------------------------------------

  describe("Phase 31 -- agent -> memory cut (MEM-CTX-PORTS-01)", () => {
    // Closed in plan 31-04 commit 4 -- the OAuth credential store selector was
    // rewritten to consume a daemon-injected encryptedStore port; the
    // memory value-import moved to daemon's setup-agents.ts. Empty array
    // means the architecture invariant asserts ZERO agent -> memory
    // production imports going forward.
    const PHASE_31_MEMORY_ALLOWLIST: readonly string[] = [];

    it("production source does NOT import @comis/memory (MEM-CTX-PORTS-01 closure)", () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: "@comis/memory",
        allowlistPaths: [...PHASE_31_MEMORY_ALLOWLIST],
      });
      expect(
        violations,
        formatViolations({
          description:
            "@comis/agent production source must not import @comis/memory. ContextStore->ContextStorePort and SessionStore->SessionStorePort plus the 9 Ctx*Row and 3 Session* row DTOs all live in @comis/core after Phase 31 commits 1-2. The lone value-import (createOAuthProfileStoreEncrypted) moved to daemon's setup-agents.ts in commit 4 -- the agent selector now consumes an injected encryptedStore port.",
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            'Replace `from "@comis/memory"` with `from "@comis/core"`. Rename ContextStore->ContextStorePort and SessionStore->SessionStorePort at use sites. For OAuth-store construction, inject an OAuthCredentialStorePort from the daemon composition (setup-agents.ts already owns the createOAuthProfileStoreEncrypted call site).',
          designRef: "design §8.2 (Phase 31) / MEM-CTX-PORTS-01 / MEM-CTX-PORTS-07",
          allowlistRef: "PHASE_31_MEMORY_ALLOWLIST (closed in plan 31-04)",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one agent/src file",
      ).toBeGreaterThan(0);
    });

    it("agent/tsconfig.json and agent/package.json dependencies do NOT reference @comis/memory (MEM-CTX-PORTS-01 closure)", () => {
      const tsconfigPath = resolve(PKG_ROOT, "tsconfig.json");
      const packageJsonPath = resolve(PKG_ROOT, "package.json");
      const tsconfigContent = readFileSync(tsconfigPath, "utf8");
      const packageJsonContent = readFileSync(packageJsonPath, "utf8");

      // tsconfig.json: no reference to ../memory anywhere.
      expect(
        tsconfigContent,
        "agent/tsconfig.json must not reference ../memory (Phase 31 commit 4 / MEM-CTX-PORTS-01). " +
          "The runtime OAuth-store factory moved to daemon composition; agent's production source resolves all memory-domain types through @comis/core.",
      ).not.toMatch(/"path":\s*"\.\.\/memory"/);

      // package.json: `dependencies` block must NOT contain @comis/memory.
      // `devDependencies` retention is permitted per Open Q5 (co-located
      // test files still need memory's factories; the production invariant
      // excludes .test.ts via findForbiddenImports' default suffix filter).
      const pkg = JSON.parse(packageJsonContent) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(
        pkg.dependencies?.["@comis/memory"],
        "agent/package.json `dependencies` must not include @comis/memory (Phase 31 commit 4 / MEM-CTX-PORTS-01). " +
          "devDependencies retention is permitted for co-located test compilation per Open Q5.",
      ).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 28 commit 5 (CORE-PORTS-14 / L4 closure) — binding rules from design
  // §5.3. The OAuth helpers (resolveCodexAuthIdentity, rewriteOAuthError,
  // redactEmailForLog, decodeCodexJwtPayload, resolveCodexStableSubject,
  // resolveCodexAccessTokenExpiry, OAuthErrorCode, RewrittenOAuthError) move
  // to @comis/core/src/security/oauth-helpers.ts. agent production source
  // must import them from @comis/core; the agent-local model/oauth-identity.ts
  // and model/oauth-errors.ts files are deleted in the same commit.
  // ---------------------------------------------------------------------------

  it("does not import resolveCodexAuthIdentity, rewriteOAuthError, redactEmailForLog from its own model/oauth-* files", () => {
    // The agent-local oauth-identity.ts + oauth-errors.ts source files are
    // deleted in Phase 28 commit 5; any production source still importing
    // from them via relative path is a regression that would also fail the
    // build, but the source-grep catches it pre-build with a clearer message.
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: /from\s+"\.\/(oauth-identity|oauth-errors)\.js"|from\s+"\.\.\/model\/(oauth-identity|oauth-errors)\.js"/,
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      "@comis/agent production source must not import from ./oauth-identity.js or ./oauth-errors.js " +
        "(these files were deleted in Phase 28 commit 5 / L4 closure). Import from \"@comis/core\" instead.",
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
        "redactEmailForLog | resolveCodexAccessTokenExpiry) from @comis/core (post-L4-closure single source).",
    ).toBeGreaterThan(0);
    expect(result.checkedFiles, "sanity: helper walked at least one agent/src file").toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Phase 32 ORCH-EXT-09 audit (commit 10): agent/src/bootstrap/ +
  // agent/src/workspace/ were audited for inbound-only helpers. NONE found.
  // Both directories remain agent-owned because their contents are executor
  // prompt assembly (system-prompt-assembler, section-extractor,
  // workspace-loader) and workspace runtime management (workspace-manager,
  // boot-file, data-env, heartbeat-file, onboarding-detector, templates,
  // workspace-resolver, workspace-state) — not inbound message handling.
  // The cross-package consumers (cli/src/commands/agent.ts for workspace
  // lifecycle, daemon/src/wiring/setup-heartbeat.ts for heartbeat empty-
  // detection) reach these surfaces through the @comis/agent barrel, never
  // through cross-package direct paths into agent/src/bootstrap/ or
  // agent/src/workspace/. The orchestrator package references "bootstrap"
  // only via a deps callback (getBootstrapInfo) supplied externally — no
  // module-import edge into agent/src/bootstrap/.
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

  describe("Phase 32 ORCH-EXT-09 -- agent directory ownership (OQ-5 audit)", () => {
    it("bootstrap/ remains agent-owned (executor prompt assembly, not inbound)", () => {
      const bootstrapDir = resolve(SRC_ROOT, "bootstrap");
      expect(
        existsSync(bootstrapDir),
        "packages/agent/src/bootstrap/ must exist (executor prompt assembly stays in agent per Phase 32 ORCH-EXT-09 audit). " +
          "If a future PR moves this directory to @comis/orchestrator, that PR also needs to amend the Phase 32 design doc " +
          "(RES-PIT-17 design-amendment-required) — the OQ-5 audit explicitly concluded that NO file in this directory is " +
          "inbound-only; every file is LLM system-prompt assembly support.",
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
          `${f} must exist in packages/agent/src/bootstrap/ (agent-owned per Phase 32 ORCH-EXT-09).`,
        ).toBe(true);
      }
    });

    it("workspace/ remains agent-owned (executor workspace runtime, not inbound)", () => {
      const workspaceDir = resolve(SRC_ROOT, "workspace");
      expect(
        existsSync(workspaceDir),
        "packages/agent/src/workspace/ must exist (executor workspace runtime stays in agent per Phase 32 ORCH-EXT-09 audit). " +
          "Like bootstrap/, the OQ-5 audit concluded that this directory is filesystem-layout management for ~/.comis/, " +
          "not inbound message handling. A move requires a Phase 32 design amendment first.",
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
          `${f} must exist in packages/agent/src/workspace/ (agent-owned per Phase 32 ORCH-EXT-09).`,
        ).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 32 commit 13 (ORCH-EXT-15 partial) + Phase 35 Plan 35-04 (D-01 #1):
  // hard-forbid `proper-lockfile` from agent production source.
  //
  // Wave 12 (32-12) cut every production import of proper-lockfile by
  // injecting FileLockPort through deps. Wave 13 (32-13) moved proper-lockfile
  // from agent's `dependencies` to `devDependencies`. Phase 35 Plan 35-04
  // deletes the agent/src/index.ts:123 `export { createFileLock } from
  // "@comis/scheduler"` re-export and severs the package-graph edge.
  //
  // @comis/scheduler is NOT promoted to HARD_FORBIDDEN here because agent
  // production source still consumes `computeNextRunAtMs`,
  // `createSystemEventQueue`, and `WakeReasonKind` from scheduler at the
  // value-import level (`session-reset-policy.ts`, `executor/spawn/...`).
  // The L6/L19 closure is specifically about the createFileLock re-export
  // edge — that one is gone; the other scheduler-symbol edges are by-design.
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
            "createFileLock() (from @comis/core, relocated in Phase 35 Plan 35-04 / " +
            "D-01 #1) is the canonical adapter; the daemon composition root " +
            "constructs one instance and threads it through OAuthTokenManagerDeps / " +
            "OAuthCredentialStoreFileConfig / ComisSessionManagerDeps. See " +
            "`packages/daemon/src/wiring/setup-agents.ts` for the wiring pattern.",
          designRef:
            "design §1.3 L24 (closed Phase 32 commit 13) / L6 + L19 (closed Phase 35 Plan 35-04) / FileLockPort injection",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one agent/src file",
      ).toBeGreaterThan(0);
    });
  }
});
