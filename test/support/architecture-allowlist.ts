// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture-test allowlist for `@comis/*` monorepo (Phase 27 baseline).
 *
 * Each entry corresponds to a known §1.3 source/boundary violation in the
 * design doc (`.planning/design/architecture-redesign-v3-2026-05-08.md`).
 * The allowlist is SHRINK-ONLY (per design §15.5 + CONTEXT.md D-04):
 * every subsequent v2.0 phase REMOVES entries by closing the underlying
 * violation; new entries are forbidden. `allowlist-shrink.test.ts` (Plan
 * 06) gates this programmatically via a base..head git-ref comparison.
 *
 * The `removedIn` template-literal type forces a compile error if a
 * stale phase reference is left behind after the phase ships -- e.g.
 * `removedIn: "phase-foo"` fails `tsc --noEmit`. This is load-bearing
 * (CONTEXT.md D-03) -- do NOT loosen the type to `string`.
 *
 * Final state (Phase 36 GUARDRAILS-01): the ALLOWLIST array is the EMPTY
 * closed set. Every Phase-27 seeded L-violation (L1, L4, L5, L6, L9, L10,
 * L11, L12, L13, L14, L16, L17, L18, L19, L20, L21, L22, L23, L24, L26)
 * has closed across Phases 27-36; the legacy closure comments below
 * remain for forensic traceability. Reintroducing a non-empty allowlist
 * requires a new phase commit with a fresh L-ID and a corresponding
 * test/architecture/allowlist-shrink.test.ts shrink violation (which by
 * design will REJECT the addition — the shrink-only gate is forward-only).
 *
 * NOT seeded:
 *   - L7, L8: resolved before Phase 27 baseline.
 *   - L25:    design/test requirement, not a source-level violation.
 *   - L27-L30: acceptance criteria, tracked separately.
 *
 * @module
 */

/**
 * One allowlist entry. Every field is required and immutable. Stale
 * phase refs in `removedIn` fail tsc; missing fields fail tsc.
 */
export interface AllowlistEntry {
  readonly id: `L${number}`;
  readonly area: string;
  readonly reason: string;
  readonly removedIn: `phase-${number}` | "permanent";
  readonly evidence: readonly string[];
}

/**
 * The seeded allowlist for Phase 27. Re-extending this array (adding
 * entries that did not exist on `origin/main`) is rejected by the
 * shrink-test gate. Removing entries is encouraged and is the normal
 * way phases close §1.3 violations.
 */
export const ALLOWLIST: readonly AllowlistEntry[] = [
  // L1: closed in Phase 32 commit 5 (ORCH-EXT-12) — channels/package.json
  // dropped @comis/agent from dependencies; channels/tsconfig.json dropped
  // { "path": "../agent" } from references. The 8 channels/src/shared/
  // helpers that previously imported @comis/agent (inbound-gate,
  // channel-manager, inbound-pipeline, inbound-route, inbound-resolve,
  // execution-execute, execution-pipeline, execution-filter) all moved to
  // @comis/orchestrator in Phase 32 commits 3-4. channels/src/__tests__/
  // architecture.test.ts promoted @comis/agent to HARD_FORBIDDEN_PACKAGES.
  // L4: closed in Phase 28 commit 5 (CORE-PORTS-14) — OAuth helpers consolidated
  // in @comis/core/src/security/oauth-helpers.ts; gateway no longer references
  // @comis/agent (package.json dep + tsconfig reference dropped).
  // L5: closed in Phase 31 commit 12 (MEM-CTX-PORTS-03 / MEM-CTX-PORTS-02) —
  // ContextStorePort + SessionStorePort moved to core/src/ports/; row DTOs at
  // core/src/ports/{context-store,session-store}-types.ts; agent + cli
  // retargeted to @comis/core; memory dropped from agent.dependencies (kept
  // in devDependencies for tests) and from cli.dependencies entirely.
  // L6: CLOSED Phase 35 (D-01 #1) — agent → @comis/scheduler `createFileLock`
  // re-export edge severed.
  //
  // Phase 35 Plan 35-02 relocated `createFileLock()` to
  // `@comis/core/src/runtime/file-lock.ts` (byte-equivalent copy with
  // `proper-lockfile` now a core dependency). Phase 35 Plan 35-04 then:
  //   1. retargeted every CLI import site from @comis/agent → @comis/core
  //      (Task 2 — 11 source/test files);
  //   2. deleted the `export { createFileLock } from "@comis/scheduler"`
  //      re-export from `packages/agent/src/index.ts:123` (Task 3);
  //   3. deleted `packages/scheduler/src/execution/execution-lock.ts` and
  //      the scheduler-side re-export, so scheduler no longer exposes any
  //      FileLockPort factory at all.
  //
  // The `agent/package.json:dependencies['@comis/scheduler']` and
  // `agent/tsconfig.json:references['../scheduler']` entries are still
  // present at the package level because agent's production source consumes
  // `computeNextRunAtMs`, `createSystemEventQueue`, and `WakeReasonKind` from
  // scheduler. The original L6 finding was specifically about the
  // `createFileLock` re-export edge — that edge is gone.
  // L9: closed in Phase 29 (PUB-EXPORTS-01 + PUB-EXPORTS-02) — cli/src/index.ts
  // shrunk to the documented external-API surface { withClient, credentialsStep,
  // RpcClient }. The 18 register*Command factories and 8 output utilities remain
  // accessible to the bin via ./commands/*.js / ./output/*.js direct source paths.
  // L10: closed in Phase 29 (PUB-EXPORTS-03) — agent/src/index.ts no longer
  // exports createSessionLifecycle as createSessionManager / SessionLifecycle
  // as SessionManager; the 3 channels consumers (channel-manager.ts,
  // inbound-pipeline.ts, channel-manager.test.ts) retargeted to the canonical
  // SessionLifecycle name.
  // L11: closed in Phase 29 (PUB-EXPORTS-04) — skills/src/index.ts no longer
  // re-exports extractMcpServerName from @comis/shared; every consumer
  // (4 sites in packages/agent/src/) imports directly from @comis/shared.
  // L12: CLOSED Phase 35 Plan 35-05 (WEB-CONTRACTS-03) — cli → @comis/infra
  // edge fully severed.
  //
  // Phase 28 commit 2 (CORE-PORTS-05) relocated the Pino-free structural
  // ComisLogger CONTRACT to @comis/core. Phase 35 Plan 35-02 then shipped
  // the concrete adapters (createConsoleLogger + isDocker) in @comis/core.
  // Phase 35 Plan 35-05 (this plan) retargets the 3 CLI import sites
  // (wizard/steps/04-credentials.ts, wizard/steps/11-daemon-start.ts,
  // commands/auth.ts) from @comis/infra → @comis/core; drops
  // "@comis/infra": "workspace:*" from packages/cli/package.json; drops
  // { "path": "../infra" } from packages/cli/tsconfig.json; and promotes
  // @comis/infra to HARD_FORBIDDEN_PACKAGES in
  // packages/cli/src/__tests__/architecture.test.ts. Top-level
  // defense-in-depth: test/architecture/cli-no-agent-no-infra.test.ts.
  // L13: closed in Phase 30 plan 01 (CONFIG-DELIV-01) — config-section
  // metadata consolidated under SECTION_REGISTRY in
  // packages/core/src/config/section-registry.ts; schema-serializer.ts,
  // field-metadata.ts, and managed-sections.ts now derive their views
  // from the single source of truth (CONFIG-DELIV-02 parity test gates).
  // L14: closed in Phase 30 plan 06 (CONFIG-DELIV-07) — hook-runner-global
  // module deleted; HookRunner is now injected via the explicit
  // DeliveryService factory's deps. The L14 source-rule was deleted in
  // plan 07 because recreating the symbol would require a new module
  // that fails type-check (no import to resolve).
  // L16: closed in Phase 28 commit 6B (CORE-PORTS-07) — every off-union
  // errorKind literal in production source migrated to the closed 9-member
  // ErrorKind union (config|network|auth|validation|timeout|resource|
  // dependency|internal|platform). L16_BASELINE_VIOLATIONS in
  // test/architecture/log-payload-checker.test.ts shrunk to 0; the walker
  // gates immediately on any new off-union literal (D-01 immediate-fail).
  // L17: CLOSED Phase 35 Plan 35-04 (WEB-CONTRACTS-02) — all CLI agent-import
  // sites retargeted to @comis/core; agent re-exports of the relocated symbols
  // (createFileLock, selectOAuthCredentialStore, loginOpenAICodexOAuth,
  // OAuthError, createModelCatalog + CatalogEntry types, ensureWorkspace,
  // resolveWorkspaceDir, isRemoteEnvironment, runOAuthTlsPreflight) deleted
  // atomically with Task 3. `grep -rln 'from "@comis/agent"' packages/cli/src/`
  // returns 0. `packages/cli/src/__tests__/architecture.test.ts` updated to
  // promote `@comis/agent` to HARD_FORBIDDEN_PACKAGES (no L17 allowlist
  // exemption remains in the CLI architecture suite).
  // L18: CLOSED Phase 36 GUARDRAILS-01/GUARDRAILS-02 (this commit) —
  // package-only graph edges (tsconfig refs without source-import
  // counterpart, or vice versa). The dual-graph alignment test in
  // test/architecture/architecture-graph.test.ts now treats TARGET_GRAPH
  // as the closed §2.2 set with DRIFT_ALLOWLIST empty (since Phase 35
  // Plan 35-05); the L18 cite text was retired in this commit, replaced
  // with "(none — closed set per GUARDRAILS-02)".
  // L19: CLOSED Phase 35 (D-01 #1) — paired with L6.
  //
  // L19's "value-import" concern was the `export { createFileLock } from
  // "@comis/scheduler"` line at `packages/agent/src/index.ts:123` (the
  // re-export technically counts as a value-import in the agent module
  // graph). Phase 35 Plan 35-04 deletes that re-export atomically with L6,
  // so both invariants close in the same commit.
  // L20: closed in Phase 30 plan 01 (CONFIG-DELIV-02) — schema-serializer
  // and field-metadata views both derive their section subsets from
  // SECTION_REGISTRY; the 46-snapshot parity test
  // (packages/core/src/config/section-registry-parity.test.ts) gates
  // future divergence.
  // L21: closed in Phase 28 commit 6C (CORE-PORTS-15 + CORE-PORTS-16) —
  // RewrittenOAuthError narrowed: `errorKind: string` mirror renamed to
  // `logErrorKind: ErrorKind` (always "auth"); the OAuth domain discriminator
  // lives solely on `code: OAuthErrorCode`. The architecture rule in
  // packages/core/src/__tests__/architecture.test.ts ("OAuth rewritten errors
  // expose code … and logErrorKind … with no string-typed errorKind field")
  // gates future regressions.
  // L22: closed in Phase 32 commit 5 (ORCH-EXT-20) — orchestrator's
  // per-package architecture test now actively enforces "imports from
  // @comis/channels public exports only" (no @comis/channels/dist/*,
  // no @comis/channels/src/*, no relative paths into channels). The
  // it.todo() placeholder from Phase 32 commit 1 was replaced with a
  // real findForbiddenImports-based test against ../channels and the
  // two subpath patterns.
  // L23: closed in Phase 28 commit 6A (CORE-PORTS-06) — production source
  // migrated to safePath(base, ...segments) from @comis/core. The canonical
  // safe-path.ts impl remains in L23_ALLOWLIST (in test/architecture/source-rules.test.ts).
  // L24: closed in Phase 32 commit 13 (ORCH-EXT-15 — partial) — Wave 12 (32-12)
  // cut every production-source import of proper-lockfile by injecting
  // FileLockPort through deps (session-write-lock.ts, oauth-credential-
  // store-file.ts, oauth-token-manager.ts now consume the port). Wave 13
  // (this commit, OQ-6 option-a) moved proper-lockfile from
  // agent/package.json:dependencies to devDependencies (only the Phase 28
  // contract test agent/src/model/__tests__/oauth-lock-contract.test.ts
  // dynamic-imports it now). @types/proper-lockfile remains in
  // devDependencies. packages/agent/src/__tests__/architecture.test.ts
  // promotes "proper-lockfile" to HARD_FORBIDDEN_PACKAGES so any future
  // production-source re-import fails CI immediately.
  // L26: closed in Phase 30 plans 03-06 (CONFIG-DELIV-04/05/06/07) — the
  // free-standing deliverToChannel function with the `deps?` optional shape
  // was deleted; the only legitimate caller pattern is now
  // `deps.deliveryService.deliverToChannel(...)` on a service constructed
  // via createDeliveryService(deps: DeliveryServiceDeps) (deps REQUIRED).
  // The CONFIG-DELIV-08 source-rules `no-free-deliverToChannel` and
  // `no-deps-optional-in-delivery` permanently enforce the closure in
  // test/architecture/source-rules.test.ts.
] as const;

// ============================================================================
// Phase 37 (HYG-01, HYG-02) — v2.1 Code-Quality Allowlist Schema
// ============================================================================

/**
 * v2.1 code-quality phase tags. Distinct from `AllowlistEntry.removedIn`
 * (which uses numeric phases like "phase-29"). Phase 37 introduces this
 * separate union because the template-literal type `'phase-${number}'`
 * structurally rejects letter-tagged phases at type-check time — a stale
 * `removedIn: "phase-Z"` fails `tsc --noEmit` (D-AL-01 / Phase 27 D-03).
 *
 * "deferred" indicates an entry deliberately taken out of the v2.1 closure
 * path (WEB-DECOMP-09 quarter-passes-without-Phase-G trigger). Valid
 * terminal state, not a temporary tag.
 */
export type CodeQualityPhase =
  | "phase-A"
  | "phase-B"
  | "phase-C"
  | "phase-D"
  | "phase-E"
  | "phase-F"
  | "phase-G"
  | "phase-H"
  | "deferred";

/** File-size violation: file exceeds 800-line cap. Closed by file splits. */
export interface FileSizeAllowlistEntry {
  readonly file: string; // path relative to repo root
  readonly lines: number; // line count at allowlist-creation date (informational)
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/** Raw-throw violation: `throw new Error(...)` / `throw err;` outside boundary modules. */
export interface RawThrowAllowlistEntry {
  readonly file: string;
  readonly lineRanges: ReadonlyArray<readonly [number, number]>; // tolerant of ±1 line drift
  readonly reason: string;
  readonly removedIn: CodeQualityPhase | "permanent"; // "permanent" reserved for @allow-throw boundary adapters
}

/** Untyped SQLite cast: `.all(...) as Type[]` or `.get(...) as Type` outside the Phase D mapper module. */
export interface UntypedSqliteAllowlistEntry {
  readonly file: string;
  readonly symbol: string; // e.g., "TokenUsageDbRow"
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/** Optional-field bloat: interface/type literal with >12 optional fields lacking an audit-stamp. */
export interface OptionalFieldAllowlistEntry {
  readonly file: string;
  readonly typeName: string;
  readonly optionalCount: number;
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/** Direct global call outside sanctioned bootstrap/runtime adapter roots. */
export interface GlobalsAllowlistEntry {
  readonly file: string;
  readonly line: number;
  readonly global:
    | "Date.now"
    | "new Date"
    | "process.env"
    | "setTimeout"
    | "setInterval"
    | "clearTimeout"
    | "clearInterval";
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/**
 * Phase H production-source historical-reference markers permitted to
 * mention compatibility / legacy text. Permanent — no removedIn field.
 * Phase 38 (BC-REM) populates this; max 2-3 entries per BC-REM-22.
 */
export interface NoBackwardCompatAllowlistEntry {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * Phase C: files genuinely test-impractical. Permanent — no removedIn
 * field (D-AL-02). Phase 40 (COV) populates this with permanent reasons.
 */
export interface CoverageWaiverEntry {
  readonly file: string;
  readonly reason: string;
}

/**
 * 7 v2.1 code-quality allowlists. Phase 37 declares them; Plans 02-05
 * populate fileSizeAllowlist, optionalFieldAllowlist, untypedSqliteAllowlist,
 * and rawThrowAllowlist. Plan 06 populates globalsAllowlist with the single
 * HYG-12 marker entry (core/bootstrap.ts:89). noBackwardCompatAllowlist and
 * coverageWaiver remain empty at Phase 37 close — Phase 38 + Phase 40 own them.
 *
 * Shrink-only ratchet: test/architecture/allowlist-shrink.test.ts (extended
 * in Plan 06 to cover all 8 arrays) compares base..head and rejects any
 * entry addition.
 */
export const fileSizeAllowlist: readonly FileSizeAllowlistEntry[] = [
  // ============================================================================
  // Phase G — Web view + component decomposition (26 files) — closes Phase 44 (WEB-DECOMP)
  // ============================================================================
  {
    file: "packages/web/src/views/setup-wizard.ts",
    lines: 1887,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/skills.ts",
    lines: 1854,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/chat-console.ts",
    lines: 1786,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/message-center.ts",
    lines: 1772,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/config-editor.ts",
    lines: 1697,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/agents/agent-editor.ts",
    lines: 1629,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/scheduler.ts",
    lines: 1594,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/memory-inspector.ts",
    lines: 1577,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/observe-view.ts",
    lines: 1553,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/models.ts",
    lines: 1431,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/components/graph/ic-node-editor.ts",
    lines: 1392,
    reason: "Graph component; decomposed in Phase G via <component>-controller.ts extraction (WEB-DECOMP-04)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/agents/workspace-manager.ts",
    lines: 1345,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/channel-detail.ts",
    lines: 1247,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/components/graph/ic-graph-canvas.ts",
    lines: 1197,
    reason: "Graph component; decomposed in Phase G via <component>-controller.ts extraction (WEB-DECOMP-04)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/dashboard.ts",
    lines: 1140,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/mcp-management.ts",
    lines: 1133,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/session-detail.ts",
    lines: 1089,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/agents/agent-list.ts",
    lines: 1081,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/pipelines/pipeline-list.ts",
    lines: 1064,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/pipelines/pipeline-builder.ts",
    lines: 1028,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/agents/agent-detail.ts",
    lines: 1003,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/media-test.ts",
    lines: 948,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/components/scheduler/ic-cron-editor.ts",
    lines: 865,
    reason: "Graph component; decomposed in Phase G via <component>-controller.ts extraction (WEB-DECOMP-04)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/pipelines/pipeline-monitor.ts",
    lines: 859,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/app.ts",
    lines: 813,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },
  {
    file: "packages/web/src/views/security.ts",
    lines: 808,
    reason: "Lit web view; decomposed in Phase G via <view>-controller.ts extraction (WEB-DECOMP-01)",
    removedIn: "phase-G",
  },

  // ============================================================================
  // Phase E — Executor splits (4 primary + 6 adjacent = 10 files) — closes Phase 42 (EXEC-SPLIT)
  // ============================================================================
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body-injector.ts",
    lines: 2120,
    reason: "Executor stream-wrapper; split in Phase E into request-body/ subdirectory per EXEC-SPLIT-02",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/executor/pi-executor.ts",
    lines: 1641,
    reason: "Core executor; split in Phase E into pi-executor/ subdirectory per EXEC-SPLIT-05",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/executor/executor-prompt-runner.ts",
    lines: 1370,
    reason: "Prompt runner; split in Phase E into prompt-runner/ subdirectory per EXEC-SPLIT-07",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/executor/cache-break-detection.ts",
    lines: 970,
    reason: "Cache-break detection; split in Phase E into cache-detection/ subdirectory per EXEC-SPLIT-09",
    removedIn: "phase-E",
  },
  // Phase E adjacent (6 agent files; reason cites the generic EXEC-SPLIT-15 group)
  {
    file: "packages/agent/src/bridge/pi-event-bridge.ts",
    lines: 1498,
    reason: "Executor-adjacent file; Phase E may split or carry removedIn: deferred per EXEC-SPLIT-15",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/model/oauth-token-manager.ts",
    lines: 1438,
    reason: "Executor-adjacent file; Phase E may split or carry removedIn: deferred per EXEC-SPLIT-15",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    lines: 1708,
    reason: "Executor-adjacent file; Phase E may split or carry removedIn: deferred per EXEC-SPLIT-15",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/executor/prompt-assembly.ts",
    lines: 1105,
    reason: "Executor-adjacent file; Phase E may split or carry removedIn: deferred per EXEC-SPLIT-15",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/executor/tool-deferral.ts",
    lines: 1033,
    reason: "Executor-adjacent file; Phase E may split or carry removedIn: deferred per EXEC-SPLIT-15",
    removedIn: "phase-E",
  },
  {
    file: "packages/agent/src/executor/executor-post-execution.ts",
    lines: 806,
    reason: "Executor-adjacent file; Phase E may split or carry removedIn: deferred per EXEC-SPLIT-15",
    removedIn: "phase-E",
  },

  // ============================================================================
  // Phase F — Long-file splits outside agent/executor/ (21 files) — closes Phase 43 (FILE-SPLIT)
  // ============================================================================
  // daemon (8 files: daemon.ts + 4 wiring/setup-*.ts + 3 api/*-handlers.ts)
  {
    file: "packages/daemon/src/daemon.ts",
    lines: 2600,
    reason: "Daemon entrypoint; split in Phase F per FILE-SPLIT-01",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/api/config-handlers.ts",
    lines: 1328,
    reason: "Daemon RPC handler group; split in Phase F per FILE-SPLIT-02",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents.ts",
    lines: 1149,
    reason: "Daemon wiring module; split in Phase F per FILE-SPLIT-03",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/wiring/setup-channels.ts",
    lines: 1111,
    reason: "Daemon wiring module; split in Phase F per FILE-SPLIT-04",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/api/session-handlers.ts",
    lines: 1085,
    reason: "Daemon RPC handler group; split in Phase F per FILE-SPLIT-05",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/api/graph-handlers.ts",
    lines: 1062,
    reason: "Daemon RPC handler group; split in Phase F per FILE-SPLIT-06",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway.ts",
    lines: 973,
    reason: "Daemon wiring module; split in Phase F per FILE-SPLIT-07",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/wiring/setup-cross-session.ts",
    lines: 931,
    reason: "Daemon wiring module; split in Phase F per FILE-SPLIT-08",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/api/obs-handlers.ts",
    lines: 881,
    reason: "Daemon RPC handler group; split in Phase F per FILE-SPLIT-09",
    removedIn: "phase-F",
  },
  // skills (5 files)
  {
    file: "packages/skills/src/tools/builtin/exec-tool.ts",
    lines: 1625,
    reason: "Built-in tool; split in Phase F per FILE-SPLIT-10",
    removedIn: "phase-F",
  },
  {
    file: "packages/skills/src/tools/builtin/exec-security.ts",
    lines: 1153,
    reason: "Built-in tool security layer; split in Phase F per FILE-SPLIT-11",
    removedIn: "phase-F",
  },
  {
    file: "packages/skills/src/skills/integrations/mcp-client.ts",
    lines: 1041,
    reason: "MCP integration client; split in Phase F per FILE-SPLIT-12",
    removedIn: "phase-F",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-tool.ts",
    lines: 957,
    reason: "Built-in web-search tool; split in Phase F per FILE-SPLIT-13",
    removedIn: "phase-F",
  },
  {
    file: "packages/skills/src/skills/registry/skill-registry.ts",
    lines: 812,
    reason: "Skill registry; split in Phase F per FILE-SPLIT-14",
    removedIn: "phase-F",
  },
  // core (3 files)
  {
    file: "packages/core/src/api-contracts/workspace.ts",
    lines: 1152,
    reason: "API contract module; split in Phase F per FILE-SPLIT-15",
    removedIn: "phase-F",
  },
  {
    file: "packages/core/src/api-contracts/orchestrator.ts",
    lines: 1129,
    reason: "API contract module; split in Phase F per FILE-SPLIT-16",
    removedIn: "phase-F",
  },
  {
    file: "packages/core/src/config/schema-agent.ts",
    lines: 936,
    reason: "Config schema module; split in Phase F per FILE-SPLIT-17",
    removedIn: "phase-F",
  },
  // cli (2 files)
  {
    file: "packages/cli/src/tooling-fill/orchestrator.ts",
    lines: 1064,
    reason: "CLI tooling-fill orchestrator; split in Phase F per FILE-SPLIT-18",
    removedIn: "phase-F",
  },
  {
    file: "packages/cli/src/commands/config.ts",
    lines: 807,
    reason: "CLI command module; split in Phase F per FILE-SPLIT-19",
    removedIn: "phase-F",
  },
  // channels (1 file)
  {
    file: "packages/channels/src/telegram/telegram-adapter.ts",
    lines: 852,
    reason: "Channel adapter; split in Phase F per FILE-SPLIT-20",
    removedIn: "phase-F",
  },
  // memory (1 file)
  {
    file: "packages/memory/src/observability-store.ts",
    lines: 802,
    reason: "Memory observability store; split in Phase F per FILE-SPLIT-21",
    removedIn: "phase-F",
  },
] as const;
export const rawThrowAllowlist: readonly RawThrowAllowlistEntry[] = [
  // ============================================================================
  // Phase D — TypeScript hygiene (TS-HYG-07/08 retrofits to Result.err /
  // @allow-throw / assertNever)
  // ============================================================================
  // NOTE: files under packages/{shared,core}/src/security/, packages/*/src/safety/,
  // or ending with /error-mapper.ts are NOT in this list — the rule excludes them
  // structurally via isInExceptionZone(). Files containing the literal
  // `@allow-throw:` substring are also excluded (forward-looking — none today).
  //
  // Seeded from live regex scan of packages/*/src/ at Plan 05 close. One entry
  // per file (file-level allowlist key per PATTERNS.md key shape table). The
  // lineRanges array records the THROW line numbers at seed time; informational —
  // the rule filters on `{file}` only (consolidated entries are forward-looking
  // for Plan 06's shrink-test which keys on {file, lineRanges[0][0]}).
  //
  // Live-inventory drift (Plan 05): RESEARCH.md anticipated 110-130 files; the
  // live tree has 139 files / 613 raw-throw hits outside exception zones. Per
  // RESEARCH.md Pitfall §1 / plan pre-authorized procedure: report drift in
  // SUMMARY and proceed with the live count.
  // ----- agent package (8 files) -----
  {
    file: "packages/agent/src/background/background-task-persistence.ts",
    lineRanges: [[147, 147]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/background/session-resolver.ts",
    lineRanges: [[112, 112]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bootstrap/sections/tool-descriptions.ts",
    lineRanges: [[774, 774], [780, 780]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bootstrap/workspace-loader.ts",
    lineRanges: [[149, 149]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/identity/identity-loader.ts",
    lineRanges: [[52, 52]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/model/resolve-provider-api-key.ts",
    lineRanges: [[83, 83]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    lineRanges: [[645, 645], [679, 679], [709, 709], [777, 777]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/workspace/workspace-manager.ts",
    lineRanges: [[101, 101]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- channels package (9 files) -----
  {
    file: "packages/channels/src/discord/discord-resolver.ts",
    lineRanges: [[62, 62]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/imessage/imessage-resolver.ts",
    lineRanges: [[59, 59], [75, 75], [83, 83]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/line/line-resolver.ts",
    lineRanges: [[55, 55], [77, 77], [83, 83]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/signal/signal-client.ts",
    lineRanges: [[95, 95], [261, 261]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/signal/signal-resolver.ts",
    lineRanges: [[62, 62]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/slack/media-handler.ts",
    lineRanges: [[86, 86], [89, 89], [92, 92], [146, 146]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/slack/slack-resolver.ts",
    lineRanges: [[72, 72], [86, 86], [91, 91], [96, 96], [102, 102], [113, 113]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/telegram/telegram-adapter.ts",
    lineRanges: [[125, 125], [503, 503], [551, 551]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/channels/src/whatsapp/whatsapp-resolver.ts",
    lineRanges: [[94, 94], [100, 100], [106, 106], [126, 126]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- cli package (17 files) -----
  {
    file: "packages/cli/src/client/rpc-client.ts",
    lineRanges: [[295, 295]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/daemon.ts",
    lineRanges: [[688, 688]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/init.ts",
    lineRanges: [[298, 298]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/reset.ts",
    lineRanges: [[75, 75], [130, 130]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/secrets.ts",
    lineRanges: [[148, 148], [162, 162]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/uninstall.ts",
    lineRanges: [[76, 76]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/output/spinner.ts",
    lineRanges: [[31, 31]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/sync-tooling/backup.ts",
    lineRanges: [[64, 64]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/test-helpers.ts",
    lineRanges: [[66, 66]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/clack-adapter.ts",
    lineRanges: [[40, 40]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/non-interactive.ts",
    lineRanges: [[120, 120], [128, 128], [141, 141], [174, 174], [185, 185], [194, 194], [202, 202], [214, 214], [222, 222], [230, 230], [236, 236], [244, 244], [250, 250], [458, 458], [478, 478], [487, 487]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/state.ts",
    lineRanges: [[61, 61], [443, 443], [526, 526]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/steps/00-welcome.ts",
    lineRanges: [[49, 49]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/steps/01-detect-existing.ts",
    lineRanges: [[302, 302], [401, 401]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/steps/04-credentials.ts",
    lineRanges: [[476, 476]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/steps/09-review.ts",
    lineRanges: [[170, 170]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/steps/10-write-config.ts",
    lineRanges: [[309, 309], [317, 317], [404, 404]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- core package (8 files) -----
  {
    file: "packages/core/src/config/schema-serializer.ts",
    lineRanges: [[63, 63]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/context/context.ts",
    lineRanges: [[64, 64]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/hooks/plugin-registry.ts",
    lineRanges: [[109, 109], [116, 116], [123, 123]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/load-env.ts",
    lineRanges: [[34, 34]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/oauth/oauth-credential-store-file.ts",
    lineRanges: [[182, 182], [186, 186], [195, 195], [211, 211]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/oauth/oauth-credential-store-selector.ts",
    lineRanges: [[93, 93]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/oauth/oauth-device-code.ts",
    lineRanges: [[230, 230], [234, 234], [247, 247], [283, 283], [298, 298], [307, 307], [329, 329], [342, 342]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/core/src/workspace/workspace-manager.ts",
    lineRanges: [[102, 102]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- daemon package (35 files) -----
  {
    file: "packages/daemon/src/api/agent-handlers.ts",
    lineRanges: [[87, 87], [95, 95], [98, 98], [167, 167], [265, 265], [273, 273], [290, 290], [295, 295], [300, 300], [365, 365], [416, 416], [429, 429], [466, 466], [471, 471], [475, 475], [479, 479], [530, 530], [535, 535], [542, 542], [546, 546], [559, 559], [564, 564], [571, 571], [575, 575]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/approval-handlers.ts",
    lineRanges: [[98, 98], [110, 110], [129, 129]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/auth-handlers.ts",
    lineRanges: [[151, 151], [197, 197], [239, 239], [249, 249], [253, 253], [290, 290]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/channel-handlers.ts",
    lineRanges: [[171, 171], [199, 199], [207, 207], [212, 212], [220, 220], [225, 225], [263, 263], [268, 268], [276, 276], [281, 281], [319, 319], [324, 324], [332, 332], [337, 337], [342, 342]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/config-handlers.ts",
    lineRanges: [[164, 164], [487, 487], [495, 495], [525, 525], [535, 535], [550, 550], [579, 579], [658, 658], [692, 692], [727, 727], [767, 767], [875, 875], [883, 883], [893, 893], [915, 915], [926, 926], [941, 941], [948, 948], [1071, 1071], [1078, 1078], [1100, 1100], [1134, 1134], [1175, 1175], [1213, 1213], [1216, 1216], [1224, 1224], [1230, 1230], [1257, 1257], [1260, 1260], [1268, 1268], [1277, 1277], [1302, 1302]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/context-handlers.ts",
    lineRanges: [[88, 88], [217, 217], [228, 228], [234, 234], [464, 464], [469, 469], [481, 481]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/cron-handlers.ts",
    lineRanges: [[84, 84], [163, 163]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/daemon-handlers.ts",
    lineRanges: [[73, 73], [83, 83], [90, 90]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/env-handlers.ts",
    lineRanges: [[125, 125], [135, 135], [151, 151], [154, 154], [157, 157], [165, 165], [168, 168], [171, 171], [182, 182], [199, 199], [263, 263], [276, 276], [286, 286]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/graph-handlers.ts",
    lineRanges: [[160, 160], [176, 176], [181, 181], [425, 425], [448, 448], [474, 474], [519, 519], [536, 536], [567, 567], [638, 638], [643, 643], [651, 651], [671, 671], [676, 676], [708, 708], [713, 713], [722, 722], [742, 742], [762, 762], [767, 767], [776, 776], [792, 792], [828, 828], [842, 842], [871, 871], [943, 943], [947, 947], [955, 955], [1039, 1039], [1043, 1043], [1051, 1051]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/heartbeat-handlers.ts",
    lineRanges: [[122, 122], [126, 126], [161, 161], [166, 166], [170, 170], [263, 263], [268, 268], [272, 272]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/mcp-handlers.ts",
    lineRanges: [[123, 123], [191, 191], [197, 197], [230, 230], [341, 341], [355, 355], [370, 370]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/media-handlers.ts",
    lineRanges: [[89, 89], [143, 143], [147, 147], [153, 153], [168, 168], [172, 172], [179, 179], [185, 185], [192, 192], [214, 214], [374, 374], [377, 377], [386, 386], [412, 412], [415, 415], [424, 424], [431, 431], [451, 451], [454, 454], [462, 462], [493, 493], [523, 523], [555, 555], [572, 572], [592, 592], [628, 628], [645, 645], [667, 667]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/memory-handlers.ts",
    lineRanges: [[163, 163], [220, 220], [303, 303], [312, 312], [343, 343]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/message-handlers.ts",
    lineRanges: [[126, 126], [302, 302], [304, 304], [315, 315], [325, 325]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/model-handlers.ts",
    lineRanges: [[122, 122], [140, 140]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/obs-handlers.ts",
    lineRanges: [[138, 138], [477, 477], [517, 517], [535, 535], [558, 558], [619, 619], [845, 845]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/provider-handlers.ts",
    lineRanges: [[199, 199], [225, 225], [230, 230], [235, 235], [273, 273], [278, 278], [286, 286], [294, 294], [305, 305], [324, 324], [363, 363], [368, 368], [373, 373], [438, 438], [443, 443], [451, 451], [457, 457], [492, 492], [497, 497], [505, 505], [536, 536], [541, 541], [549, 549]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/rpc-dispatch.ts",
    lineRanges: [[304, 304], [320, 320]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/secrets-handlers.ts",
    lineRanges: [[147, 147], [161, 161], [172, 172], [175, 175], [180, 180], [195, 195], [224, 224], [275, 275], [289, 289], [301, 301], [304, 304], [309, 309], [315, 315], [318, 318], [321, 321], [333, 333], [351, 351], [389, 389], [428, 428], [463, 463], [503, 503], [517, 517], [525, 525], [528, 528], [533, 533], [545, 545], [573, 573]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/session-handlers.ts",
    lineRanges: [[612, 612], [790, 790], [819, 819], [937, 937]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/skill-handlers.ts",
    lineRanges: [[103, 103], [207, 207], [217, 217], [222, 222], [233, 233], [243, 243], [253, 253], [262, 262], [305, 305], [310, 310], [317, 317], [323, 323], [330, 330], [336, 336], [342, 342], [355, 355], [364, 364], [401, 401], [406, 406], [411, 411], [420, 420], [427, 427], [446, 446], [451, 451], [487, 487], [494, 494], [498, 498], [509, 509], [515, 515], [533, 533], [564, 564], [570, 570], [574, 574], [587, 587], [598, 598], [605, 605]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/subagent-handlers.ts",
    lineRanges: [[89, 89], [109, 109], [125, 125], [131, 131]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/token-handlers.ts",
    lineRanges: [[156, 156], [195, 195], [204, 204], [268, 268], [277, 277], [289, 289], [331, 331], [337, 337], [349, 349]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/api/workspace-handlers.ts",
    lineRanges: [[106, 106], [109, 109], [115, 115], [137, 137], [223, 223], [235, 235], [249, 249], [257, 257], [265, 265], [284, 284], [336, 336], [373, 373], [377, 377], [465, 465], [560, 560], [562, 562], [597, 597], [614, 614], [616, 616]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/daemon.ts",
    lineRanges: [[438, 438], [452, 452], [558, 558], [567, 567], [1435, 1435], [1801, 1801]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/monitoring/security-update-source.ts",
    lineRanges: [[99, 99]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/monitoring/system-resources-source.ts",
    lineRanges: [[131, 131]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/monitoring/systemd-service-source.ts",
    lineRanges: [[60, 60]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/daemon-utils.ts",
    lineRanges: [[14, 14], [36, 36], [60, 60]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents.ts",
    lineRanges: [[908, 908], [1085, 1085], [1109, 1109]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway-routes.ts",
    lineRanges: [[135, 135], [175, 175]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway.ts",
    lineRanges: [[136, 136]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-heartbeat.ts",
    lineRanges: [[191, 191]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-schedulers.ts",
    lineRanges: [[295, 295], [322, 322]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- gateway package (4 files) -----
  {
    file: "packages/gateway/src/acp/acp-server.ts",
    lineRanges: [[132, 132]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/gateway/src/oauth/oauth-callback-route.ts",
    lineRanges: [[154, 154], [250, 250], [269, 269]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/gateway/src/rpc/method-router.ts",
    lineRanges: [[72, 72], [204, 204], [222, 222], [235, 235], [240, 240], [248, 248]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/gateway/src/web/media-routes.ts",
    lineRanges: [[109, 109], [169, 169]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- memory package (7 files) -----
  {
    file: "packages/memory/src/credential-mapping-store.ts",
    lineRanges: [[91, 91]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/memory-api.ts",
    lineRanges: [[188, 188]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    lineRanges: [[795, 795]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/row-mapper.ts",
    lineRanges: [[193, 193], [218, 218], [223, 223]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/schema.ts",
    lineRanges: [[43, 43]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/secret-store-schema.ts",
    lineRanges: [[81, 81], [114, 114], [120, 120]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/session-store.ts",
    lineRanges: [[106, 106]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- orchestrator package (5 files) -----
  {
    file: "packages/orchestrator/src/cross-session/announcement-dead-letter.ts",
    lineRanges: [[108, 108], [316, 316]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/cross-session/cross-session-sender.ts",
    lineRanges: [[95, 95], [101, 101], [129, 129]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/execution/execution-execute.ts",
    lineRanges: [[215, 215]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/queue/coalescer.ts",
    lineRanges: [[32, 32]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/queue/priority-scheduler.ts",
    lineRanges: [[177, 177]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- scheduler package (5 files) -----
  {
    file: "packages/scheduler/src/cron/cron-scheduler.ts",
    lineRanges: [[208, 208]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/scheduler/src/cron/cron-store.ts",
    lineRanges: [[96, 96], [136, 136], [152, 152], [172, 172]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/scheduler/src/execution/execution-tracker.ts",
    lineRanges: [[149, 149]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/scheduler/src/heartbeat/quiet-hours.ts",
    lineRanges: [[30, 30], [35, 35]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/scheduler/src/tasks/task-store.ts",
    lineRanges: [[49, 49]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- skills package (40 files) -----
  {
    file: "packages/skills/src/platform-tools/tool-helpers.ts",
    lineRanges: [[70, 70], [175, 175], [180, 180], [202, 202], [207, 207], [229, 229], [234, 234]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/platform-tools/tools/obs-query-tool.ts",
    lineRanges: [[224, 224]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/platform-tools/tools/pipeline-tool.ts",
    lineRanges: [[592, 592]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/platform-tools/tools/subagents-tool.ts",
    lineRanges: [[143, 143]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/skills/bridge/credential-injector.ts",
    lineRanges: [[115, 115], [124, 124], [258, 258]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/skills/bridge/tool-audit.ts",
    lineRanges: [[71, 71]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/skills/bridge/tool-metadata-enforcement.ts",
    lineRanges: [[87, 87], [97, 97]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/skills/integrations/mcp-client.ts",
    lineRanges: [[293, 293], [305, 305], [314, 314], [322, 322]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/browser/browser-service.ts",
    lineRanges: [[220, 220], [223, 223]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/browser/cdp.ts",
    lineRanges: [[61, 61]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/browser/chrome-detection.ts",
    lineRanges: [[191, 191], [265, 265]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/browser/playwright-session.ts",
    lineRanges: [[357, 357], [451, 451]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/browser/profiles.ts",
    lineRanges: [[70, 70]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/browser/screenshots.ts",
    lineRanges: [[68, 68], [78, 78]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/exec-tool.ts",
    lineRanges: [[166, 166]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/edit-tool.ts",
    lineRanges: [[150, 150], [211, 211], [220, 220], [231, 231], [248, 248], [261, 261], [269, 269], [276, 276], [283, 283], [300, 300], [336, 336], [340, 340], [344, 344], [348, 348], [352, 352], [354, 354]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/find-tool.ts",
    lineRanges: [[105, 105]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/grep-tool.ts",
    lineRanges: [[158, 158], [279, 279], [287, 287], [435, 435], [486, 486]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/ls-tool.ts",
    lineRanges: [[92, 92], [158, 158]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/notebook-edit-tool.ts",
    lineRanges: [[137, 137], [145, 145], [160, 160], [166, 166], [175, 175], [186, 186], [195, 195], [201, 201], [206, 206], [213, 213], [223, 223], [233, 233], [248, 248]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/read-tool.ts",
    lineRanges: [[326, 326], [389, 389], [402, 402], [408, 408], [422, 422], [424, 424], [475, 475]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/shared/edit-diff.ts",
    lineRanges: [[228, 228], [230, 230], [270, 270], [306, 306], [310, 310], [318, 318], [322, 322], [354, 354], [372, 372], [376, 376]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/write-tool.ts",
    lineRanges: [[133, 133], [187, 187], [195, 195], [204, 204], [211, 211], [229, 229], [282, 282], [292, 292], [316, 316], [327, 327]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file/apply-patch-tool.ts",
    lineRanges: [[336, 336]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/file/path-suggest.ts",
    lineRanges: [[42, 42]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/process-registry.ts",
    lineRanges: [[236, 236], [239, 239]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/tool-provisioner.ts",
    lineRanges: [[180, 180], [190, 190], [215, 215], [245, 245]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-brave.ts",
    lineRanges: [[146, 146]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-duckduckgo.ts",
    lineRanges: [[190, 190]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-exa.ts",
    lineRanges: [[76, 76]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-grok.ts",
    lineRanges: [[101, 101]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-jina.ts",
    lineRanges: [[67, 67], [92, 92]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-perplexity.ts",
    lineRanges: [[125, 125]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-searxng.ts",
    lineRanges: [[41, 41], [44, 44], [92, 92]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-tavily.ts",
    lineRanges: [[76, 76], [82, 82]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-tool.ts",
    lineRanges: [[631, 631], [650, 650]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/integrations/image-gen/fal-adapter.ts",
    lineRanges: [[39, 39], [44, 44]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/integrations/image-gen/openai-adapter.ts",
    lineRanges: [[36, 36]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/media/media-temp.ts",
    lineRanges: [[94, 94], [123, 123]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/media/ssrf-fetcher.ts",
    lineRanges: [[226, 226], [236, 236], [255, 255], [278, 278], [282, 282], [297, 297]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
  // ----- web package (1 files) -----
  {
    file: "packages/web/src/api/api-client.ts",
    lineRanges: [[171, 171], [175, 175], [212, 212], [231, 231]],
    reason: "Raw throw in production source; Phase D TS-HYG-07/08 retrofits to Result.err per design §7.2.3",
    removedIn: "phase-D",
  },
] as const;
export const untypedSqliteAllowlist: readonly UntypedSqliteAllowlistEntry[] = [
  // ============================================================================
  // Phase D — TypeScript hygiene (TS-HYG-01..04 closes via RowMapper<TRow>)
  // ============================================================================
  // Every entry below records one `{file, symbol}` cast site in
  // packages/memory/src/ that currently uses the unsafe
  // `.all(...) as Type[]` / `.get(...) as Type` form. Phase D TS-HYG-01..04
  // introduces the typed `RowMapper<TRow>` factory and retargets every
  // site to `mapper.parseRows(...)` / `mapper.parseOptionalRow(...)`;
  // each retarget closes one entry in this list atomically.
  //
  // The `symbol` field captures the FIRST `\w+` after `as ` per the rule's
  // regex (e.g. `.get(...) as Row | undefined` records symbol "Row"; the
  // union pipe truncation is intentional). For `as Array<{...}>` casts the
  // symbol is "Array" (the angle-bracketed generic body does not match
  // `\w+`).
  //
  // The allowlist key is `{file, symbol}` (per PATTERNS.md key-shape table):
  // multiple raw cast sites in the same file that target the same `symbol`
  // collapse into one entry. The live grep yielded 61 raw cast sites
  // collapsing to 35 unique pairs across 14 files.

  // context-store.ts — 8 unique symbols (CtxConversationRow, CtxMessageRow,
  // CtxMessagePartRow, CtxSummaryRow, CtxContextItemRow, CtxLargeFileRow,
  // CtxExpansionGrantRow, Array (inline anonymous row shapes for id-projection
  // and parent/child queries)).
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "Array",
    reason: "Inline anonymous row projections (id-list / parent-child id queries); Phase D TS-HYG-03 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxContextItemRow",
    reason: "context-store .all() row cast; Phase D TS-HYG-03 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxConversationRow",
    reason: "context-store .all() row cast; Phase D TS-HYG-03 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxExpansionGrantRow",
    reason: "context-store .get() row cast; Phase D TS-HYG-03 retargets to mapper.parseOptionalRow",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxLargeFileRow",
    reason: "context-store .get() row cast; Phase D TS-HYG-03 retargets to mapper.parseOptionalRow",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxMessagePartRow",
    reason: "context-store .all() row cast; Phase D TS-HYG-03 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxMessageRow",
    reason: "context-store .all() row cast; Phase D TS-HYG-03 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/context-store.ts",
    symbol: "CtxSummaryRow",
    reason: "context-store .get() / .all() row cast; Phase D TS-HYG-03 retargets to mapper.parseRows / mapper.parseOptionalRow",
    removedIn: "phase-D",
  },

  // credential-mapping-store.ts — 1 symbol.
  {
    file: "packages/memory/src/credential-mapping-store.ts",
    symbol: "CredentialMappingRow",
    reason: "credential-mapping-store .get() / .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows / mapper.parseOptionalRow",
    removedIn: "phase-D",
  },

  // delivery-mirror-adapter.ts — 1 symbol.
  {
    file: "packages/memory/src/delivery-mirror-adapter.ts",
    symbol: "DeliveryMirrorDbRow",
    reason: "delivery-mirror-adapter .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // delivery-queue-adapter.ts — 1 symbol (Array anonymous row shape).
  {
    file: "packages/memory/src/delivery-queue-adapter.ts",
    symbol: "Array",
    reason: "delivery-queue-adapter anonymous row projection (status/count); Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // embedding-cache-sqlite.ts — 1 symbol.
  {
    file: "packages/memory/src/embedding-cache-sqlite.ts",
    symbol: "BatchCacheRow",
    reason: "embedding-cache-sqlite .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // hybrid-search.ts — 3 symbols.
  {
    file: "packages/memory/src/hybrid-search.ts",
    symbol: "Array",
    reason: "hybrid-search anonymous row projection (id-only query); Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/hybrid-search.ts",
    symbol: "FtsSearchRow",
    reason: "hybrid-search FTS .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/hybrid-search.ts",
    symbol: "VecSearchRow",
    reason: "hybrid-search vector .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // identity-link-store.ts — 1 symbol.
  {
    file: "packages/memory/src/identity-link-store.ts",
    symbol: "IdentityLinkRow",
    reason: "identity-link-store .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // memory-api.ts — 2 symbols.
  {
    file: "packages/memory/src/memory-api.ts",
    symbol: "Array",
    reason: "memory-api anonymous row projection (id-only retention/eviction queries); Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/memory-api.ts",
    symbol: "MemoryRow",
    reason: "memory-api .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // named-graph-store.ts — 2 symbols.
  {
    file: "packages/memory/src/named-graph-store.ts",
    symbol: "Array",
    reason: "named-graph-store anonymous row projection (list query); Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/named-graph-store.ts",
    symbol: "NamedGraphRow",
    reason: "named-graph-store .get() row cast; Phase D TS-HYG-02 retargets to mapper.parseOptionalRow",
    removedIn: "phase-D",
  },

  // oauth-profile-store-encrypted.ts — 1 symbol.
  {
    file: "packages/memory/src/oauth-profile-store-encrypted.ts",
    symbol: "OAuthProfileRow",
    reason: "oauth-profile-store-encrypted .get() / .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows / mapper.parseOptionalRow",
    removedIn: "phase-D",
  },

  // observability-store.ts — 9 symbols.
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "AgentAggDbRow",
    reason: "observability-store agent-aggregate .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "ChannelSnapshotDbRow",
    reason: "observability-store channel-snapshot .all() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "DeliveryDbRow",
    reason: "observability-store delivery-row .all() cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "DeliveryStatsDbRow",
    reason: "observability-store delivery-stats .get() cast; Phase D TS-HYG-02 retargets to mapper.parseOptionalRow",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "DiagnosticDbRow",
    reason: "observability-store diagnostic .all() cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "HourlyBucketDbRow",
    reason: "observability-store hourly-bucket .all() cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "ProviderAggDbRow",
    reason: "observability-store provider-aggregate .all() cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "SessionAggDbRow",
    reason: "observability-store session-aggregate .get() cast (Row | undefined truncates to Row); Phase D TS-HYG-02 retargets to mapper.parseOptionalRow",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/observability-store.ts",
    symbol: "TokenUsageDbRow",
    reason: "observability-store token-usage .all() cast; Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },

  // row-mapper.ts — 1 symbol (the Phase D mapper module itself currently
  // contains an internal anonymous row-projection cast; closes when the
  // module finishes its own TS-HYG-01 refactor).
  {
    file: "packages/memory/src/row-mapper.ts",
    symbol: "Array",
    reason: "row-mapper internal anonymous row projection (group-by aggregate); Phase D TS-HYG-01 closes when the mapper module finishes its own refactor",
    removedIn: "phase-D",
  },

  // session-store.ts — 1 symbol.
  {
    file: "packages/memory/src/session-store.ts",
    symbol: "SessionRow",
    reason: "session-store .get() row cast; Phase D TS-HYG-02 retargets to mapper.parseOptionalRow",
    removedIn: "phase-D",
  },

  // sqlite-memory-adapter.ts — 2 symbols.
  {
    file: "packages/memory/src/sqlite-memory-adapter.ts",
    symbol: "Array",
    reason: "sqlite-memory-adapter anonymous row projection (id-only tenant query); Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
  {
    file: "packages/memory/src/sqlite-memory-adapter.ts",
    symbol: "MemoryRow",
    reason: "sqlite-memory-adapter .get() row cast; Phase D TS-HYG-02 retargets to mapper.parseRows / mapper.parseOptionalRow",
    removedIn: "phase-D",
  },

  // sqlite-secret-store.ts — 1 symbol (Array<{...}> anonymous decrypt-batch
  // and list-secrets row shapes; both target Array generic).
  {
    file: "packages/memory/src/sqlite-secret-store.ts",
    symbol: "Array",
    reason: "sqlite-secret-store anonymous row shapes (decrypt-all batch, secret-list); Phase D TS-HYG-02 retargets to mapper.parseRows",
    removedIn: "phase-D",
  },
] as const;
export const optionalFieldAllowlist: readonly OptionalFieldAllowlistEntry[] = [
  // ============================================================================
  // Phase D — TypeScript hygiene (TS-HYG-13 closes via per-declaration audit)
  // ============================================================================
  // NOTE: ChannelManagerDeps (44 optional fields, channel-manager.ts:83) is NOT
  // in this list — it is hard-excluded by the rule itself per HYG-06 because
  // v3 §9.2.5 owns its audit. Re-adding it here is a contract violation.
  {
    file: "packages/agent/src/executor/pi-executor.ts",
    typeName: "PiExecutorDeps",
    optionalCount: 43,
    reason: "Executor deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/inbound/inbound-pipeline.ts",
    typeName: "InboundPipelineDeps",
    optionalCount: 40,
    reason: "Inbound pipeline deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bootstrap/system-prompt-assembler.ts",
    typeName: "AssemblerParams",
    optionalCount: 34,
    reason: "System-prompt assembler params; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body-injector.ts",
    typeName: "RequestBodyInjectorConfig",
    optionalCount: 32,
    reason: "Stream-wrapper config; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bridge/pi-event-bridge.ts",
    typeName: "PiEventBridgeDeps",
    optionalCount: 30,
    reason: "Event-bridge deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-channels.ts",
    typeName: "ChannelsDeps",
    optionalCount: 26,
    reason: "Channels wiring deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    typeName: "SpawnParams",
    optionalCount: 25,
    reason: "Sub-agent spawn params; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/non-interactive.ts",
    typeName: "NonInteractiveOptions",
    optionalCount: 25,
    reason: "CLI non-interactive options (type alias); Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/executor-post-execution.ts",
    typeName: "PostExecutionBridgeResult",
    optionalCount: 22,
    reason: "Executor post-execution result; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-shutdown.ts",
    typeName: "ShutdownDeps",
    optionalCount: 22,
    reason: "Shutdown wiring deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents.ts",
    typeName: "SingleAgentDeps",
    optionalCount: 21,
    reason: "Single-agent wiring deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/execution/execution-pipeline.ts",
    typeName: "ExecutionPipelineDeps",
    optionalCount: 19,
    reason: "Execution pipeline deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/executor-tool-assembly.ts",
    typeName: "ToolAssemblyDeps",
    optionalCount: 18,
    reason: "Tool-assembly deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-tool.ts",
    typeName: "WebSearchConfig",
    optionalCount: 18,
    reason: "Web-search built-in config; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/web/src/api/types/agent-types.ts",
    typeName: "AgentDetail",
    optionalCount: 18,
    reason: "Web agent-detail API type; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/graph/graph-coordinator-state.ts",
    typeName: "GraphCoordinatorDeps",
    optionalCount: 16,
    reason: "Graph coordinator deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/web/src/views/config-editor/schema-form.ts",
    typeName: "SchemaProperty",
    optionalCount: 16,
    reason: "Schema-form property type; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/context-engine/types-core.ts",
    typeName: "ContextEngineDeps",
    optionalCount: 15,
    reason: "Context-engine deps bag; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/command-directive-types.ts",
    typeName: "CommandDirectives",
    optionalCount: 14,
    reason: "Executor command-directives shape; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/sessions.ts",
    typeName: "SessionEntry",
    optionalCount: 14,
    reason: "CLI sessions list entry; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/types.ts",
    typeName: "WizardState",
    optionalCount: 14,
    reason: "CLI wizard state (type alias); Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/commands/types.ts",
    typeName: "CommandDirectives",
    optionalCount: 14,
    reason: "Orchestrator command-directives shape (same name as agent peer; independent decl); Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    typeName: "SubAgentRunnerDeps",
    optionalCount: 13,
    reason: "Sub-agent runner deps bag (boundary: 13 optionals, strict >12 threshold); Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/daemon-types.ts",
    typeName: "DaemonOverrides",
    optionalCount: 13,
    reason: "Daemon overrides type; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/platform-tools/registry.ts",
    typeName: "PlatformToolBuildContext",
    optionalCount: 13,
    reason: "Platform-tool build context; Phase D TS-HYG-13 audit per design §7.2.5",
    removedIn: "phase-D",
  },
] as const;
export const globalsAllowlist: readonly GlobalsAllowlistEntry[] = [] as const;
export const noBackwardCompatAllowlist: readonly NoBackwardCompatAllowlistEntry[] = [] as const;
export const coverageWaiver: readonly CoverageWaiverEntry[] = [] as const;
