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
export const rawThrowAllowlist: readonly RawThrowAllowlistEntry[] = [] as const;
export const untypedSqliteAllowlist: readonly UntypedSqliteAllowlistEntry[] = [] as const;
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
