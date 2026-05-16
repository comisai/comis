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
 * Phase C / COV-10: per-(file,line) exemption from the test-naming
 * gate's predicate 2 (≥20 chars) and predicate 3 (use-case shape).
 * Plan 40-10 captures the current state of legacy short descriptions
 * and heuristic-misclassified noun phrases. Each entry MUST cite the
 * concrete violation (min-length or shape) + a deferral target. The
 * shrink-only ratchet (allowlist-shrink.test.ts) enforces this list
 * SHRINKS over time — future plans add tests by renaming legacy
 * descriptions to verbose use-case statements (predicate 2) or by
 * extending VERB_FORMS / heuristic regex (predicate 3).
 */
export interface TestNamingAllowlistEntry {
  readonly file: string;
  readonly line: number;
  readonly kind: "describe" | "it" | "test";
  readonly text: string;
  readonly reason: string;
}

/**
 * 7 v2.1 code-quality allowlists. Phase 37 declares them; Plans 02-05
 * populate fileSizeAllowlist, optionalFieldAllowlist, untypedSqliteAllowlist,
 * and rawThrowAllowlist. Plan 06 populates globalsAllowlist with the single
 * bootstrap.ts:89 env-fallback entry (closed in Phase 39 Plan 03 / PORTS-10).
 * noBackwardCompatAllowlist and coverageWaiver remain empty at Phase 37
 * close — Phase 38 + Phase 40 own them.
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
  // §13.3 fallback (Plan 42-05): closure-extracted helpers shipped (safety-gate,
  // compaction-trigger, executor-error-mapping, session-bootstrap,
  // message-envelope — all state-first per EXEC-SPLIT-06) but the inside-lock
  // withSession callback body resisted further closure extraction without
  // either a 50+-field state shape or breaking the natural orchestrator-edge
  // boundary. Pass-1 (co-equal extractions) + Pass-2 (5 closure-extracted
  // helpers) shipped. EXEC-SPLIT-06 structural test GREEN non-vacuously.
  // Revisit the withSession callback split in a focused follow-up (Phase G/H)
  // — likely seam is sub-decomposing the bridge construction (~210L) and
  // stream-wrapper wiring (~30L) into independent helpers.
  {
    file: "packages/agent/src/executor/pi-executor/pi-executor.ts",
    lines: 1397,
    reason: "Thinned PiExecutor factory + withSession callback (§13.3 fallback per Plan 42-05); 4 co-equal/closure-extracted helpers shipped; inside-lock callback deferred to focused follow-up. EXEC-SPLIT-06 structural test GREEN non-vacuously (5 closure-extracted helpers walked).",
    removedIn: "deferred",
  },
  // Phase 42 closure — §8.2.5 adjacent files decision (EXEC-SPLIT-15).
  // Per-file decisions made at Phase 42 closing commit (Plan 42-06); line counts
  // re-measured at HEAD; all 6 entries converted from phase-E → deferred with
  // explicit reasons. File 6 (executor-post-execution.ts) re-measured at 816L
  // (>810 per §8.2.5 matrix branch), so its default split-attempt branch is
  // foreclosed and the deferred-with-reason fallback applies. Phase 42 SHIPPED
  // with 0 phase-E tags in any allowlist (closure invariant).
  {
    file: "packages/agent/src/bridge/pi-event-bridge.ts",
    lines: 1496,
    reason: "Executor-adjacent file (1,496L re-measured at Phase 42 closing commit; -2L drift from 1,498L design-doc cite); 17 small event handlers; mechanical split by event family deferred to a focused follow-up — engineer-time budget consumed by 4 primary executor splits (EXEC-SPLIT-15 default-defer per §8.2.5)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/model/oauth-token-manager.ts",
    lines: 1441,
    reason: "Executor-adjacent file (1,441L re-measured at Phase 42 closing commit; +3L drift from 1,438L design-doc cite); 5th-largest non-daemon agent file; OAuth surface is mature/stable; splitting requires care to preserve runtime-override priority path (setRuntimeApiKey side effect) (EXEC-SPLIT-15 default-defer per §8.2.5)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    lines: 1715,
    reason: "Executor-adjacent file (1,715L re-measured at Phase 42 closing commit; +7L drift from 1,708L design-doc cite); gated by §7.2.5 SubAgentRunnerDeps audit; Phase 41 closed the audit (Plan 41-06; AUDIT.md exists) but the natural module seams require focused-follow-up care (EXEC-SPLIT-15 default-defer per §8.2.5)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/executor/prompt-assembly.ts",
    lines: 1100,
    reason: "Executor-adjacent file (1,100L re-measured at Phase 42 closing commit; -5L drift from 1,105L design-doc cite); Phase 39 PORTS-11/12/13 closed direct-global retargeting (Plan 39-05); no obvious natural seam at this size; defer pending further audit (EXEC-SPLIT-15 default-defer per §8.2.5)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/executor/tool-deferral.ts",
    lines: 1035,
    reason: "Executor-adjacent file (1,035L re-measured at Phase 42 closing commit; +2L drift from 1,033L design-doc cite); BM25/cosine ranking algorithm conceptually separate from deferral orchestration; split sensible but not urgent (EXEC-SPLIT-15 default-defer per §8.2.5)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/executor/executor-post-execution.ts",
    lines: 816,
    reason: "Executor-adjacent file (816L re-measured at Phase 42 closing commit; +10L drift from 806L design-doc cite); barely above 800L cap but now >810L threshold per §8.2.5 matrix branch — the matrix's split-attempt branch (801-810 + clean seam) is foreclosed by the re-measurement; defer pending Phase B/H global-removal shrinkage or a focused Phase 43-adjacent post-run-cleanup/metrics helper extraction (EXEC-SPLIT-15 §8.2.5 file-6 fallback)",
    removedIn: "deferred",
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
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
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
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "phase-F",
  },
  {
    file: "packages/daemon/src/api/graph-handlers.ts",
    lines: 1028,
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
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "phase-F",
  },
  // skills (0 files remaining — exec-tool.ts + exec-security.ts dropped in Phase 43 plan 02a, web-search-tool.ts + skill-registry.ts dropped in 43-02b, mcp-client.ts dropped in 43-02c per FILE-SPLIT-02 + FILE-SPLIT-11 + FILE-SPLIT-16)
  // core (2 files remaining; api-contracts/workspace.ts split in Plan 43-06 per FILE-SPLIT-14/16)
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
  // cli (0 files remaining; tooling-fill/orchestrator.ts split in Plan 43-05 per FILE-SPLIT-10; commands/config.ts dropped below 800L in Plan 43-05 via config-parsers.ts helper extraction per FILE-SPLIT-10)
  // channels (0 files remaining; telegram-adapter.ts split in Plan 43-04 per FILE-SPLIT-12)
  // memory (1 file remaining; observability-store.ts split in Plan 43-03)
  {
    file: "packages/memory/src/context-store.ts",
    lines: 854,
    reason: "Memory context store; grew from 769→854 lines during Plan 41-04 mapper retargeting (17 inline mapper factories + 7 named mappers added at module top to honor TS-HYG-03). Split in Phase F alongside observability-store per FILE-SPLIT-21 (memory-package decomposition).",
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
    reason: "@allow-throw boundary: background task persistence re-raise (line 147) inside try/catch wrapper; outer caller (executor) catches at PiExecutor boundary which is itself consumed by daemon RPC handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/background/session-resolver.ts",
    lineRanges: [[112, 112]],
    reason: "@allow-throw boundary: session-resolver session-not-found guard; consumed by daemon RPC handlers (subagent-handlers / session-handlers @allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/bootstrap/sections/tool-descriptions.ts",
    lineRanges: [[774, 774], [780, 780]],
    reason: "@allow-throw boundary: bootstrap-time invariant assertion (LEAN_TOOL_DESCRIPTIONS / TOOL_SUMMARIES / NATIVE_TOOLS keys must match); consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/bootstrap/workspace-loader.ts",
    lineRanges: [[149, 149]],
    reason: "@allow-throw boundary: workspace-loader re-raise (non-ENOENT errors); outer caller is daemon bootstrap which catches at daemon.ts entry (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/identity/identity-loader.ts",
    lineRanges: [[52, 52]],
    reason: "@allow-throw boundary: identity-loader re-raise of unexpected fs errors (PathTraversalError is the silent-skip path); consumed at agent bootstrap (daemon.ts catch boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/model/resolve-provider-api-key.ts",
    lineRanges: [[83, 83]],
    reason: "@allow-throw boundary: OAuth credential resolution: explicit-profile request that store cannot satisfy is security-critical hard fail per the inline comment (line 79-81); caller chain is PiExecutor.execute -> gateway routes which lift to user-facing error (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    lineRanges: [[649, 649], [684, 684], [715, 715], [784, 784]],
    reason: "@allow-throw boundary: spawn() consumed exclusively by daemon RPC handlers (subagent-handlers, session-handlers, graph-*); these handlers are @allow-throw boundaries per 41-03-SUMMARY.md Decision 2 (rpc-dispatch.ts:306-321 wraps and converts to JSON-RPC error response). Phase 41 TS-HYG-07.",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/workspace/workspace-manager.ts",
    lineRanges: [[101, 101]],
    reason: "@allow-throw boundary: workspace-manager re-raise of non-EEXIST fs errors (line 101); consumed by daemon bootstrap (daemon.ts catch boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- channels package (8 files; telegram-adapter.ts dropped in Plan 43-04 per FILE-SPLIT-12) -----
  {
    file: "packages/channels/src/discord/discord-resolver.ts",
    lineRanges: [[62, 62]],
    reason: "@allow-throw boundary: media-resolver throw inside fromPromise(); converted to Result.err by ssrfFetcher boundary adapter (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/imessage/imessage-resolver.ts",
    lineRanges: [[59, 59], [75, 75], [83, 83]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/line/line-resolver.ts",
    lineRanges: [[55, 55], [77, 77], [83, 83]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/signal/signal-client.ts",
    lineRanges: [[95, 95], [261, 261]],
    reason: "@allow-throw boundary: signal-client SDK boundary throws; caught by adapter try/catch chain converting to inbound-pipeline errors (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/signal/signal-resolver.ts",
    lineRanges: [[62, 62]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/slack/media-handler.ts",
    lineRanges: [[86, 86], [89, 89], [92, 92], [146, 146]],
    reason: "@allow-throw boundary: Slack media-handler boundary throws; consumed by slack-resolver/adapter try/catch chain converting to ResolvedMedia Result (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/slack/slack-resolver.ts",
    lineRanges: [[72, 72], [86, 86], [91, 91], [96, 96], [102, 102], [113, 113]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // telegram-adapter.ts entry dropped in Plan 43-04 (FILE-SPLIT-12 split): the
  // 3 throw sites now live in telegram-adapter/{telegram-webhook.ts,telegram-
  // outbound.ts}, both of which carry file-level `@allow-throw:` annotations
  // on line 2 (same pattern as Plan 43-02c's mcp-client-discover.ts).
  {
    file: "packages/channels/src/whatsapp/whatsapp-resolver.ts",
    lineRanges: [[94, 94], [100, 100], [106, 106], [126, 126]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- cli package (17 files) -----
  {
    file: "packages/cli/src/client/rpc-client.ts",
    lineRanges: [[295, 295]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary per AGENTS.md §2.1 (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/daemon.ts",
    lineRanges: [[688, 688]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/init.ts",
    lineRanges: [[298, 298]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/reset.ts",
    lineRanges: [[75, 75], [130, 130]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/secrets.ts",
    lineRanges: [[148, 148], [162, 162]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/uninstall.ts",
    lineRanges: [[76, 76]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/output/spinner.ts",
    lineRanges: [[31, 31]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary per AGENTS.md §2.1 (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/sync-tooling/backup.ts",
    lineRanges: [[64, 64]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary per AGENTS.md §2.1 (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/test-helpers.ts",
    lineRanges: [[66, 66]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary per AGENTS.md §2.1 (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/clack-adapter.ts",
    lineRanges: [[40, 40]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/non-interactive.ts",
    lineRanges: [[120, 120], [128, 128], [141, 141], [174, 174], [185, 185], [194, 194], [202, 202], [214, 214], [222, 222], [230, 230], [236, 236], [244, 244], [250, 250], [458, 458], [478, 478], [487, 487]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/state.ts",
    lineRanges: [[61, 61], [443, 443], [526, 526]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/00-welcome.ts",
    lineRanges: [[49, 49]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/01-detect-existing.ts",
    lineRanges: [[302, 302], [401, 401]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/04-credentials.ts",
    lineRanges: [[476, 476]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/09-review.ts",
    lineRanges: [[170, 170]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/10-write-config.ts",
    lineRanges: [[309, 309], [317, 317], [404, 404]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- core package (8 files) -----
  {
    file: "packages/core/src/config/schema-serializer.ts",
    lineRanges: [[63, 63]],
    reason: "@allow-throw boundary: unknown config section guard; consumed via daemon config-handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/context/context.ts",
    lineRanges: [[64, 64]],
    reason: "@allow-throw boundary: getContext() AsyncLocalStorage scope assertion; caller contract per AGENTS.md §2.6 (chose getContext over tryGetContext); request-path scope (RPC/channel boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/hooks/plugin-registry.ts",
    lineRanges: [[109, 109], [116, 116], [123, 123]],
    reason: "@allow-throw boundary: PluginRegistry registration preconditions; consumed at bootstrap entry (daemon.ts catch boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/load-env.ts",
    lineRanges: [[34, 34]],
    reason: "@allow-throw boundary: loadEnv() missing dotenv hard-fail; consumed at daemon bootstrap entry per AGENTS.md §6.2 (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/oauth/oauth-credential-store-file.ts",
    lineRanges: [[182, 182], [186, 186], [195, 195], [211, 211]],
    reason: "@allow-throw boundary: ENOENT re-raise + file-format guards in OAuthCredentialStorePort; consumed by auth-handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/oauth/oauth-credential-store-selector.ts",
    lineRanges: [[93, 93]],
    reason: "@allow-throw boundary: unknown storage-backend guard at composition root; daemon.ts catch boundary per AGENTS.md §6.2 (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/oauth/oauth-device-code.ts",
    lineRanges: [[230, 230], [234, 234], [247, 247], [283, 283], [298, 298], [307, 307], [329, 329], [342, 342]],
    reason: "@allow-throw boundary: OAuth device-code state-machine guards; consumed via auth-handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/workspace/workspace-manager.ts",
    lineRanges: [[102, 102]],
    reason: "@allow-throw boundary: ENOENT re-raise inside writeIfMissing wx-flag fallback; consumed at workspace-init entry (CLI wizard / daemon bootstrap @allow-throw) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- daemon package (35 files) -----
  {
    file: "packages/daemon/src/api/agent-handlers.ts",
    lineRanges: [[87, 87], [95, 95], [98, 98], [167, 167], [265, 265], [273, 273], [290, 290], [295, 295], [300, 300], [365, 365], [416, 416], [429, 429], [466, 466], [471, 471], [475, 475], [479, 479], [530, 530], [535, 535], [542, 542], [546, 546], [559, 559], [564, 564], [571, 571], [575, 575]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/approval-handlers.ts",
    lineRanges: [[98, 98], [110, 110], [129, 129]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/auth-handlers.ts",
    lineRanges: [[151, 151], [197, 197], [239, 239], [249, 249], [253, 253], [290, 290]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/channel-handlers.ts",
    lineRanges: [[171, 171], [199, 199], [207, 207], [212, 212], [220, 220], [225, 225], [263, 263], [268, 268], [276, 276], [281, 281], [319, 319], [324, 324], [332, 332], [337, 337], [342, 342]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/config-handlers.ts",
    lineRanges: [[164, 164], [487, 487], [495, 495], [525, 525], [535, 535], [550, 550], [579, 579], [658, 658], [692, 692], [727, 727], [767, 767], [875, 875], [883, 883], [893, 893], [915, 915], [926, 926], [941, 941], [948, 948], [1071, 1071], [1078, 1078], [1100, 1100], [1134, 1134], [1175, 1175], [1213, 1213], [1216, 1216], [1224, 1224], [1230, 1230], [1257, 1257], [1260, 1260], [1268, 1268], [1277, 1277], [1302, 1302]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/context-handlers.ts",
    lineRanges: [[88, 88], [217, 217], [228, 228], [234, 234], [464, 464], [469, 469], [481, 481]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/cron-handlers.ts",
    lineRanges: [[84, 84], [163, 163]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/daemon-handlers.ts",
    lineRanges: [[73, 73], [83, 83], [90, 90]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/env-handlers.ts",
    lineRanges: [[125, 125], [135, 135], [151, 151], [154, 154], [157, 157], [165, 165], [168, 168], [171, 171], [182, 182], [199, 199], [263, 263], [276, 276], [286, 286]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/graph-handlers.ts",
    lineRanges: [[126, 126], [142, 142], [147, 147], [391, 391], [414, 414], [440, 440], [485, 485], [502, 502], [533, 533], [604, 604], [609, 609], [617, 617], [637, 637], [642, 642], [674, 674], [679, 679], [688, 688], [708, 708], [728, 728], [733, 733], [742, 742], [758, 758], [794, 794], [808, 808], [837, 837], [909, 909], [913, 913], [921, 921], [1005, 1005], [1009, 1009], [1017, 1017]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/heartbeat-handlers.ts",
    lineRanges: [[122, 122], [126, 126], [161, 161], [166, 166], [170, 170], [263, 263], [268, 268], [272, 272]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/mcp-handlers.ts",
    lineRanges: [[123, 123], [191, 191], [197, 197], [230, 230], [341, 341], [355, 355], [370, 370]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/media-handlers.ts",
    lineRanges: [[89, 89], [143, 143], [147, 147], [153, 153], [168, 168], [172, 172], [179, 179], [185, 185], [192, 192], [214, 214], [374, 374], [377, 377], [386, 386], [412, 412], [415, 415], [424, 424], [431, 431], [451, 451], [454, 454], [462, 462], [493, 493], [523, 523], [555, 555], [572, 572], [592, 592], [628, 628], [645, 645], [667, 667]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/memory-handlers.ts",
    lineRanges: [[163, 163], [220, 220], [303, 303], [312, 312], [343, 343]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/message-handlers.ts",
    lineRanges: [[126, 126], [302, 302], [304, 304], [315, 315], [325, 325]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/model-handlers.ts",
    lineRanges: [[122, 122], [140, 140]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/obs-handlers.ts",
    lineRanges: [[138, 138], [477, 477], [517, 517], [535, 535], [558, 558], [619, 619], [845, 845]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/provider-handlers.ts",
    lineRanges: [[199, 199], [225, 225], [230, 230], [235, 235], [273, 273], [278, 278], [286, 286], [294, 294], [305, 305], [324, 324], [363, 363], [368, 368], [373, 373], [438, 438], [443, 443], [451, 451], [457, 457], [492, 492], [497, 497], [505, 505], [536, 536], [541, 541], [549, 549]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/rpc-dispatch.ts",
    lineRanges: [[304, 304], [320, 320]],
    reason: "@allow-throw boundary: RPC dispatcher boundary itself (line 304 unknown-method + line 320 re-throw); the re-throw IS the JSON-RPC error path -- gateway/method-router catches and converts to JSON-RPC error response (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/secrets-handlers.ts",
    lineRanges: [[147, 147], [161, 161], [172, 172], [175, 175], [180, 180], [195, 195], [224, 224], [275, 275], [289, 289], [301, 301], [304, 304], [309, 309], [315, 315], [318, 318], [321, 321], [333, 333], [351, 351], [389, 389], [428, 428], [463, 463], [503, 503], [517, 517], [525, 525], [528, 528], [533, 533], [545, 545], [573, 573]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/session-handlers.ts",
    lineRanges: [[612, 612], [790, 790], [819, 819], [937, 937]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/skill-handlers.ts",
    lineRanges: [[103, 103], [207, 207], [217, 217], [222, 222], [233, 233], [243, 243], [253, 253], [262, 262], [305, 305], [310, 310], [317, 317], [323, 323], [330, 330], [336, 336], [342, 342], [355, 355], [364, 364], [401, 401], [406, 406], [411, 411], [420, 420], [427, 427], [446, 446], [451, 451], [487, 487], [494, 494], [498, 498], [509, 509], [515, 515], [533, 533], [564, 564], [570, 570], [574, 574], [587, 587], [598, 598], [605, 605]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/subagent-handlers.ts",
    lineRanges: [[89, 89], [109, 109], [125, 125], [131, 131]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/token-handlers.ts",
    lineRanges: [[156, 156], [195, 195], [204, 204], [268, 268], [277, 277], [289, 289], [331, 331], [337, 337], [349, 349]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/workspace-handlers.ts",
    lineRanges: [[106, 106], [109, 109], [115, 115], [137, 137], [223, 223], [235, 235], [249, 249], [257, 257], [265, 265], [284, 284], [336, 336], [373, 373], [377, 377], [465, 465], [560, 560], [562, 562], [597, 597], [614, 614], [616, 616]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/daemon.ts",
    lineRanges: [[438, 438], [452, 452], [558, 558], [567, 567], [1435, 1435], [1801, 1801]],
    reason: "@allow-throw boundary: daemon bootstrap composition-root failures (secrets bootstrap, decryption, etc.); hard-fail at startup is the correct contract per AGENTS.md §6.2 (bootstrap() returns Result but daemon.ts is the entry point that catches it and exits) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/monitoring/security-update-source.ts",
    lineRanges: [[99, 99]],
    reason: "@allow-throw boundary: monitoring source boundary re-raise; consumed via monitoring-source aggregator try/catch chain (daemon.ts bootstrap boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/monitoring/system-resources-source.ts",
    lineRanges: [[131, 131]],
    reason: "@allow-throw boundary: monitoring source /proc/meminfo parse guard; consumed via monitoring-source aggregator try/catch chain (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/monitoring/systemd-service-source.ts",
    lineRanges: [[60, 60]],
    reason: "@allow-throw boundary: monitoring source systemctl invocation error; consumed via monitoring-source aggregator try/catch chain (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/daemon-utils.ts",
    lineRanges: [[14, 14], [36, 36], [60, 60]],
    reason: "@allow-throw boundary: channel-adapter / executor registry lookup guards; consumed at daemon bootstrap composition-root (daemon.ts catch boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents.ts",
    lineRanges: [[908, 908], [1085, 1085], [1109, 1109]],
    reason: "@allow-throw boundary: setup-agents wiring guards; consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway-routes.ts",
    lineRanges: [[135, 135], [175, 175]],
    reason: "@allow-throw boundary: gateway-route wiring re-raise; consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway.ts",
    lineRanges: [[136, 136]],
    reason: "@allow-throw boundary: gateway wiring re-raise; consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-heartbeat.ts",
    lineRanges: [[191, 191]],
    reason: "@allow-throw boundary: heartbeat-executor lookup guard; consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-schedulers.ts",
    lineRanges: [[295, 295], [322, 322]],
    reason: "@allow-throw boundary: scheduler wiring guards; consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- gateway package (4 files) -----
  {
    file: "packages/gateway/src/acp/acp-server.ts",
    lineRanges: [[132, 132]],
    reason: "@allow-throw boundary: ACP HTTP server route handler; throws caught by Hono framework error-handler boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/gateway/src/oauth/oauth-callback-route.ts",
    lineRanges: [[154, 154], [250, 250], [269, 269]],
    reason: "@allow-throw boundary: OAuth HTTP callback route; throws caught by Hono error-handler boundary per AGENTS.md §2.1 web-user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/gateway/src/rpc/method-router.ts",
    lineRanges: [[72, 72], [204, 204], [222, 222], [235, 235], [240, 240], [248, 248]],
    reason: "@allow-throw boundary: JSON-RPC method-router; JSONRPCErrorException + scope-check throws caught by json-rpc-2.0 library and converted to JSON-RPC error response (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/gateway/src/web/media-routes.ts",
    lineRanges: [[109, 109], [169, 169]],
    reason: "@allow-throw boundary: gateway HTTP media-routes; throws caught by Hono framework error-handler boundary per AGENTS.md §2.1 web exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- memory package (7 files) -----
  {
    file: "packages/memory/src/credential-mapping-store.ts",
    lineRanges: [[91, 91]],
    reason: "@allow-throw boundary: validation throw inside tryCatch() port wrapper; consumed by daemon RPC handlers (Decision 2 transitive) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/memory-api.ts",
    lineRanges: [[188, 188]],
    reason: "@allow-throw boundary: MemoryApi.clear() scope-required guard; consumed by daemon memory-handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // observability-store.ts entry REMOVED in Plan 43-03: split into
  // observability-store/ subdirectory (FILE-SPLIT-13); the @allow-throw
  // unknown-table guard now lives in observability-store/observability-reset.ts
  // which carries a file-level `// @allow-throw:` annotation. The raw-throw
  // rule excludes annotated files before consulting the allowlist, so no
  // replacement entry is required (net shrink-only change, satisfies the
  // allowlist-shrink ratchet by construction).
  {
    file: "packages/memory/src/row-mapper.ts",
    lineRanges: [[193, 193], [218, 218], [223, 223]],
    reason: "@allow-throw boundary: SQL-injection ALLOWED_TABLES/COLUMNS guard; prevents unsafe table/column names from reaching prepare(); consumed by MemoryApi adapter (daemon RPC @allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/schema.ts",
    lineRanges: [[43, 43]],
    reason: "@allow-throw boundary: initSchema embeddingDimensions DDL precondition; consumed at daemon bootstrap entry (daemon.ts catch boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/secret-store-schema.ts",
    lineRanges: [[81, 81], [114, 114], [120, 120]],
    reason: "@allow-throw boundary: master-key canary mismatch must hard-fail; encryption-correctness assertion zone per AGENTS.md §2.1 analog (security-critical) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/session-store.ts",
    lineRanges: [[106, 106]],
    reason: "@allow-throw boundary: 10MB session-size guard; consumed by daemon session-handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- orchestrator package (5 files) -----
  {
    file: "packages/orchestrator/src/cross-session/announcement-dead-letter.ts",
    lineRanges: [[110, 110], [319, 319]],
    reason: "@allow-throw boundary: atomicWrite (line 110) wraps node:fs/promises (writeFile + rename), callers wrap via try/catch (drain() catch at line 325-330). ENOENT re-raise (line 318) is conventional rethrow inside unlink-cleanup pattern, also caught by drain() outer catch. Phase 41 TS-HYG-07.",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/cross-session/cross-session-sender.ts",
    lineRanges: [[95, 95], [101, 101], [129, 129]],
    reason: "@allow-throw boundary: cross-session-sender validation guards (invalid session key, session-not-found, deadlock-risk); consumed via daemon session-handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/execution/execution-execute.ts",
    lineRanges: [[217, 217]],
    reason: "@allow-throw boundary: re-raise non-TimeoutError from executeLlm to the inbound orchestrator pipeline (executeAndDeliver -> inbound-route); channel-adapter context catches and converts to user-visible degraded response. Boundary adapter pattern per 41-03-SUMMARY.md Decision 2 (channel/RPC inbound boundaries). Phase 41 TS-HYG-07.",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/queue/coalescer.ts",
    lineRanges: [[32, 32]],
    reason: "@allow-throw boundary: coalescer precondition guard (>=1 message required); consumed by inbound-pipeline boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/queue/priority-scheduler.ts",
    lineRanges: [[177, 177]],
    reason: "@allow-throw boundary: priority-scheduler shutdown guard; consumed by inbound-pipeline boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- scheduler package (5 files) -----
  {
    file: "packages/scheduler/src/cron/cron-scheduler.ts",
    lineRanges: [[208, 208]],
    reason: "@allow-throw boundary: cron scheduler boundary error; consumed by setup-schedulers daemon-wiring catch (daemon.ts bootstrap) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/cron/cron-store.ts",
    lineRanges: [[96, 96], [136, 136], [152, 152], [172, 172]],
    reason: "@allow-throw boundary: file-IO + lock-acquisition errors in CronStore; consumed via daemon cron-handlers + setup-schedulers (Decision 2 transitive) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/execution/execution-tracker.ts",
    lineRanges: [[149, 149]],
    reason: "@allow-throw boundary: scheduler-execution state-tracking guard; consumed via daemon scheduler wiring catch (daemon.ts bootstrap boundary) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/heartbeat/quiet-hours.ts",
    lineRanges: [[30, 30], [35, 35]],
    reason: "@allow-throw boundary: quiet-hours time-format validation guards; consumed via setup-heartbeat daemon-wiring (daemon.ts bootstrap) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/tasks/task-store.ts",
    lineRanges: [[49, 49]],
    reason: "@allow-throw boundary: task-store SQLite adapter precondition guards; consumed via daemon heartbeat handlers (@allow-throw per Decision 2) (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- skills package (40 files) -----
  {
    file: "packages/skills/src/platform-tools/tool-helpers.ts",
    lineRanges: [[70, 70], [175, 175], [180, 180], [202, 202], [207, 207], [229, 229], [234, 234]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/platform-tools/tools/obs-query-tool.ts",
    lineRanges: [[224, 224]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/platform-tools/tools/pipeline-tool.ts",
    lineRanges: [[592, 592]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/platform-tools/tools/subagents-tool.ts",
    lineRanges: [[143, 143]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/skills/bridge/credential-injector.ts",
    lineRanges: [[115, 115], [124, 124], [258, 258]],
    reason: "@allow-throw boundary: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/skills/bridge/tool-audit.ts",
    lineRanges: [[71, 71]],
    reason: "@allow-throw boundary: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/skills/bridge/tool-metadata-enforcement.ts",
    lineRanges: [[87, 87], [97, 97]],
    reason: "@allow-throw boundary: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/browser-service.ts",
    lineRanges: [[220, 220], [223, 223]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/cdp.ts",
    lineRanges: [[61, 61]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/chrome-detection.ts",
    lineRanges: [[191, 191], [265, 265]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/playwright-session.ts",
    lineRanges: [[357, 357], [451, 451]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/profiles.ts",
    lineRanges: [[70, 70]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/screenshots.ts",
    lineRanges: [[68, 68], [78, 78]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/edit-tool.ts",
    lineRanges: [[150, 150], [211, 211], [220, 220], [231, 231], [248, 248], [261, 261], [269, 269], [276, 276], [283, 283], [300, 300], [336, 336], [340, 340], [344, 344], [348, 348], [352, 352], [354, 354]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/find-tool.ts",
    lineRanges: [[105, 105]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/grep-tool.ts",
    lineRanges: [[158, 158], [279, 279], [287, 287], [435, 435], [486, 486]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/ls-tool.ts",
    lineRanges: [[92, 92], [158, 158]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/notebook-edit-tool.ts",
    lineRanges: [[137, 137], [145, 145], [160, 160], [166, 166], [175, 175], [186, 186], [195, 195], [201, 201], [206, 206], [213, 213], [223, 223], [233, 233], [248, 248]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/read-tool.ts",
    lineRanges: [[326, 326], [389, 389], [402, 402], [408, 408], [422, 422], [424, 424], [475, 475]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/shared/edit-diff.ts",
    lineRanges: [[228, 228], [230, 230], [270, 270], [306, 306], [310, 310], [318, 318], [322, 322], [354, 354], [372, 372], [376, 376]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/write-tool.ts",
    lineRanges: [[133, 133], [187, 187], [195, 195], [204, 204], [211, 211], [229, 229], [282, 282], [292, 292], [316, 316], [327, 327]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file/apply-patch-tool.ts",
    lineRanges: [[336, 336]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file/path-suggest.ts",
    lineRanges: [[42, 42]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/process-registry.ts",
    lineRanges: [[236, 236], [239, 239]],
    reason: "@allow-throw boundary: builtin tool boundary; throws caught by AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/tool-provisioner.ts",
    lineRanges: [[180, 180], [190, 190], [215, 215], [245, 245]],
    reason: "@allow-throw boundary: builtin tool boundary; throws caught by AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-brave.ts",
    lineRanges: [[146, 146]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-duckduckgo.ts",
    lineRanges: [[190, 190]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-exa.ts",
    lineRanges: [[76, 76]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-grok.ts",
    lineRanges: [[101, 101]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-jina.ts",
    lineRanges: [[67, 67], [92, 92]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-perplexity.ts",
    lineRanges: [[125, 125]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-searxng.ts",
    lineRanges: [[41, 41], [44, 44], [92, 92]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-tavily.ts",
    lineRanges: [[76, 76], [82, 82]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/integrations/image-gen/fal-adapter.ts",
    lineRanges: [[39, 39], [44, 44]],
    reason: "@allow-throw boundary: integration/SDK boundary wrapper; throws caught by AgentTool wrapper at consumer site (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/integrations/image-gen/openai-adapter.ts",
    lineRanges: [[36, 36]],
    reason: "@allow-throw boundary: integration/SDK boundary wrapper; throws caught by AgentTool wrapper at consumer site (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/media/media-temp.ts",
    lineRanges: [[94, 94], [123, 123]],
    reason: "@allow-throw boundary: media-tool boundary; throws caught by AgentTool wrapper (image/video/audio tools) or upstream fromPromise() converter (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/media/ssrf-fetcher.ts",
    lineRanges: [[226, 226], [236, 236], [255, 255], [278, 278], [282, 282], [297, 297]],
    reason: "@allow-throw boundary: media-tool boundary; throws caught by AgentTool wrapper (image/video/audio tools) or upstream fromPromise() converter (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- web package (1 files) -----
  {
    file: "packages/web/src/api/api-client.ts",
    lineRanges: [[171, 171], [175, 175], [212, 212], [231, 231]],
    reason: "@allow-throw boundary: web API client dev-time validation guards; consumed by Lit element error-handler boundary per AGENTS.md §2.1 web-user-facing flows exception (Phase 41 TS-HYG-07).",
    removedIn: "permanent",
  },
  // ----- web package permanent (1 file) -----
  // Phase 41 TS-HYG-12: requireGlobalState helper throws
  // GlobalStateNotInitializedError when a Lit element queries GlobalState
  // before firstUpdated() completes. The throw is the correct boundary
  // signal — Lit catches it at the lifecycle boundary and surfaces it to
  // the element's error handler. AGENTS.md §2.1 web-user-facing flows
  // exception sanctions this; the file also bears the `@allow-throw:`
  // annotation so this entry is defense-in-depth.
  {
    file: "packages/web/src/state/global-state.ts",
    lineRanges: [[168, 168]],
    reason: "GlobalStateNotInitializedError — Lit lifecycle invariant; caught at framework boundary per AGENTS.md §2.1 web-user-facing flows exception (Phase 41 TS-HYG-12).",
    removedIn: "permanent",
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

  // context-store.ts — DRAINED in Plan 41-04 Task 3 (TS-HYG-03).
  // Previously held 8 `{file, symbol}` entries for {Array (inline id-projection
  // and FTS hit shapes), CtxConversationRow, CtxMessageRow, CtxMessagePartRow,
  // CtxSummaryRow, CtxContextItemRow, CtxLargeFileRow, CtxExpansionGrantRow}.
  // All 17 cast sites retargeted to mapper.parseRows / parseOptionalRow with
  // degrade-on-validation-error semantics (preserves ContextStorePort plain-
  // return contract for the 16 production-file consumers in agent + daemon).

  // credential-mapping-store.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // delivery-mirror-adapter.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).
  // Result-returning port; mapper failure flows through err() to the
  // existing try/catch wrapper.

  // delivery-queue-adapter.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // embedding-cache-sqlite.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // hybrid-search.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // identity-link-store.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // memory-api.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // named-graph-store.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // oauth-profile-store-encrypted.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // observability-store.ts — DRAINED in Plan 41-04 Task 2 (TS-HYG-03).
  // Previously held 9 `{file, symbol}` entries for {TokenUsageDbRow,
  // DeliveryDbRow, DiagnosticDbRow, ChannelSnapshotDbRow, ProviderAggDbRow,
  // AgentAggDbRow, SessionAggDbRow, HourlyBucketDbRow, DeliveryStatsDbRow}.
  // Every site retargets to mapper.parseRows / parseOptionalRow with
  // degrade-on-validation-error (observability metrics are non-fatal —
  // see file header for the chosen Option 2 rationale).

  // row-mapper.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).
  // The mapper module's own internal countRows / groupCountRows projections
  // now go through local schemas + createRowMapper (self-closing TS-HYG-01).

  // session-store.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // sqlite-memory-adapter.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).

  // sqlite-secret-store.ts — DRAINED in Plan 41-04 Task 4 (TS-HYG-03).
] as const;
export const optionalFieldAllowlist: readonly OptionalFieldAllowlistEntry[] = [
  // ============================================================================
  // Phase 41 Plan 08 Task 2 — TS-HYG-13 per-declaration audit (final state)
  // ============================================================================
  // NOTE: ChannelManagerDeps (44 optional fields, channel-manager.ts:83) is NOT
  // in this list — it is hard-excluded by the rule itself per HYG-06 because
  // v3 §9.2.5 owns its audit. Re-adding it here is a contract violation.
  //
  // Audit outcome per Plan 41-03-SUMMARY.md Decision 5 (TS-HYG-13):
  //   - Reviewed each interface declaration line-by-line + every construction
  //     site (single composition-root callers for the daemon deps bags, plus
  //     CLI / API / wizard / DTO consumers).
  //   - Classification taxonomy: (a) Genuinely conditional — fields capture
  //     real config-driven variance with documented per-field rationale; KEEP
  //     with specific reason. (b) Clustered-optional — interface mixes 2-3
  //     distinct concerns; KEEP with future-refactor note recommending a
  //     concern-split. (c) Cosmetic over-optional-marking — fields marked `?`
  //     but supplied at every construction site; would DELETE entry + require
  //     fields. ZERO entries classified as (c).
  //   - Final count: 25 (unchanged). Decision 5 explicitly authorizes
  //     "no target floor — the audit decisions ARE the gate". RESEARCH §
  //     "Land-mine 8" reinforces audit-driven shrinkage, not mandate-to-count.
  //     RESEARCH Assumption A5: "most >12-optional-field interfaces will be
  //     audited and kept with documented reason" — confirmed by per-interface
  //     inspection. No entry survived as cosmetic over-optional marking.
  //
  // Why no cosmetic deletions: every audited interface fell into one of three
  // genuine-variance patterns:
  //   1. Dependency-injection bags whose optional fields gate on config
  //      booleans, secret/credential presence, or feature-flag state. The
  //      single construction site at the composition root passes
  //      `undefined` (or omits the key) when the underlying conditional is
  //      false — e.g. setup-agents.ts:641 `authRotation = authProfileManager
  //      ? createAuthRotationAdapter(...) : undefined`. Marking these
  //      required would force the daemon to manufacture placeholders.
  //   2. Wire-protocol / DTO shapes where field absence is semantic
  //      (e.g. SessionEntry's dual `key | sessionKey` from daemon-side RPC
  //      schema migration; AgentDetail.heartbeat.target absent = agent has
  //      no scheduled delivery target). Tightening these would break the
  //      JSON shape contract.
  //   3. Mutually-exclusive directive / option bags where one invocation
  //      sets ONE field (CommandDirectives is the canonical case: a single
  //      `/think medium` or `/model claude-sonnet` sets one key; every
  //      other directive field stays `undefined`).
  //
  // Future refactor flag (cluster-split candidates marked `(b)` below): some
  // large deps bags mix 2-3 concerns and could be split into sub-interfaces
  // for clarity. The architectural test would still pass after the split
  // (each sub-interface stays under the 12-optional threshold). Out of scope
  // for Phase 41 — KISS/YAGNI says defer until a real refactor wave brings
  // the structural improvement.

  // -- (b) Clustered-optional deps bags: split candidates for a future refactor --
  {
    file: "packages/agent/src/executor/pi-executor/pi-executor-types.ts",
    typeName: "PiExecutorDeps",
    optionalCount: 42,
    reason: "(b) Cluster-split candidate: optionals mix 8 concerns (safety controls, adapters/registries, tool wiring, media/prompts, provider compatibility, secret/output guards, delivery/cache, observability ports). Every optional field documented per-line; construction site (setup-agents.ts:645) conditionally supplies values from config + AppContainer. Future refactor: split into PiExecutorSafetyDeps + PiExecutorToolingDeps + PiExecutorProviderDeps + PiExecutorObservabilityDeps. (TS-HYG-13 — Plan 41-08 audit; keep until structural refactor wave; path + count updated post-Phase-42 EXEC-SPLIT-05 split — interface moved to pi-executor-types.ts to break the no-cycles invariant; one optional field consolidated during the move).",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/inbound/inbound-pipeline.ts",
    typeName: "InboundPipelineDeps",
    optionalCount: 40,
    reason: "(b) Cluster-split candidate: optionals mix the 5 inbound-pipeline phases (resolve, preprocess, gate, setup, route) plus auxiliary concerns (voice pipeline, delivery queue, command/approval handling, debounce/group history buffers). Each `?` field is wired only when the corresponding feature is configured (e.g. approvalGate present only when approval workflow enabled). Future refactor: per-phase sub-Deps interfaces. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bootstrap/system-prompt-assembler.ts",
    typeName: "AssemblerParams",
    optionalCount: 34,
    reason: "(b) Cluster-split candidate: prompt-section assembly params — every `?` corresponds to ONE prompt section (skills XML, attribution, language hint, sub-agent role, sender trust, documentation, media directives, SEP, MCP inheritance, runtime info, etc). Each section's `includeIn` set determines whether the corresponding param is read in a given PromptMode; absent params skip the section. Future refactor: group by section family (identity / safety / tooling / media / sub-agent). (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/types.ts",
    typeName: "RequestBodyInjectorConfig",
    optionalCount: 32,
    reason: "(b) Cluster-split candidate: stream-wrapper config combines cache-control breakpoint strategy, beta-header latches, microcompact triggers, tool-deferral hooks, cadence trackers, eviction cooldown. Each callback/getter is wired ONLY when the corresponding feature path is active (e.g. sub-agent spawn sets `skipCacheWrite + cacheWriteTimestamp + parentCacheRetention`; root-agent execution leaves them undefined). Future refactor: split into CacheBreakpointConfig + ToolDeferralConfig + MicroCompactConfig. (TS-HYG-13 — Plan 41-08 audit; file path updated post-Phase-42 EXEC-SPLIT-02 split).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bridge/pi-event-bridge.ts",
    typeName: "PiEventBridgeDeps",
    optionalCount: 30,
    reason: "(b) Cluster-split candidate: event-bridge deps mix runtime callbacks (onAbort, onAbortRetry, onCacheReads, onTurnUsage) + safety controls (contextGuard, providerHealth, compactionSettings) + SEP execution-plan tracking + thinking-block hash diagnostics + drain-state gates. Construction site (pi-executor.ts:1173) supplies subsets based on per-execution feature flags (sepEnabled, capturedBridgeRetention). Future refactor: split runtime callbacks from observability sinks. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-channels.ts",
    typeName: "ChannelsDeps",
    optionalCount: 26,
    reason: "(b) Cluster-split candidate: channel-bootstrap deps span media handling (transcriber, ttsAdapter, audioConverter, imageAnalyzer, fileExtractor — each gated by config presence + native dep availability), session lifecycle (piSessionAdapters, costTrackers), inbound-routing callbacks (onMessageReceived, onMessageProcessed), and per-agent cron tracker maps. Single composition-root caller (daemon.ts:1594) builds optionals from config flags. Future refactor: split media-deps + session-tracking-deps from core channel-deps. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    typeName: "SpawnParams",
    optionalCount: 25,
    reason: "(b) Cluster-split candidate: spawn-call options mix top-level routing (announceChannel*, callerSession/Agent, requesterOrigin), graph-pipeline coordination (graphId, nodeId, graphSharedDir, graphTraceId, graphToolNames, graphNodeDepth, isLeafNode), and execution overrides (model, max_steps, expected_outputs, artifactRefs, objective, domainKnowledge, toolGroups, includeParentHistory, reuseSessionKey). Direct vs graph-driven spawns set different subsets — e.g. graph nodes set graphId+nodeId+graphToolNames, direct chat spawns leave them undefined. Future refactor: split into SpawnRouting + SpawnGraphMeta + SpawnExecutionOverrides. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/non-interactive.ts",
    typeName: "NonInteractiveOptions",
    optionalCount: 25,
    reason: "(b) Cluster-split candidate: CLI flag bag pre-grouped by `// Core / Gateway / Channels / Paths / Behavior` comment dividers — comment structure proves the conceptual clustering already exists. Each group's fields are independently optional (a CI invocation may set only --gateway-port + --gateway-token; another may set --channels + per-platform tokens). Future refactor: split type into the 5 groups already commented in source. Cannot mark required without forcing every CLI invocation to specify every flag. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/executor-post-execution.ts",
    typeName: "PostExecutionBridgeResult",
    optionalCount: 22,
    reason: "(a) Per-turn outcome aggregation: every `?` reflects real variance in what a single execution produced — cache write tokens only when caching active, signature scrubs only when scrubber fired, thinkingTokens only on reasoning-capable models, hashAssertion* only when bridge ran the cross-turn assertion path. Marking required would force the bridge to manufacture zeros at every callsite where the feature was inactive — losing the 'feature inactive' signal that downstream consumers (cost gates, observability) check via `field === undefined`. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents.ts",
    typeName: "SingleAgentDeps",
    optionalCount: 21,
    reason: "(a) Daemon-internal per-agent deps; every `?` field gates on a daemon-global resource being wired (providerHealth, lastKnownModel, embeddingPort, deliveryMirror, geminiCacheManager — each is undefined unless the corresponding subsystem started successfully). The `secretsCrypto?` + `secretsDb?` pair is conditional on `oauth.storage === 'encrypted'` config. Construction site at setup-agents.ts wires from setupMemory/setupSecrets results. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-shutdown.ts",
    typeName: "ShutdownDeps",
    optionalCount: 22,
    reason: "(a) Shutdown handle aggregator; every `?` field is a subsystem that MAY not be running at shutdown time (graphCoordinator absent in single-agent deployments, channelManager absent if no channels configured, heartbeatRunner absent if heartbeats disabled, mediaTempManager absent if media features off, etc). Marking required would force composition-root to fabricate no-op stubs; instead shutdown.ts:withStepTimeout skips absent subsystems. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/execution/execution-pipeline.ts",
    typeName: "ExecutionPipelineDeps",
    optionalCount: 19,
    reason: "(b) Cluster-split candidate: orchestrator's execution-pipeline deps include retry/followup machinery (retryEngine, followupTrigger, followupConfig), media pipeline (parseOutboundMedia, outboundMediaFetch, voiceResponsePipeline), streaming/policy config, command queue, response-prefix templating. Each is optional because feature paths are independently gated. Future refactor: split into ExecutionRetryDeps + ExecutionMediaDeps + ExecutionStreamingDeps. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/executor-tool-assembly.ts",
    typeName: "ToolAssemblyDeps",
    optionalCount: 18,
    reason: "(b) Cluster-split candidate: ToolAssemblyDeps is a documented `Subset of PiExecutorDeps used by the tool assembly pipeline` (file:69) — inherits the parent bag's cluster structure (media/skill/prompt/delivery). The subset cannot be tightened independently of PiExecutorDeps (the daemon wiring passes the same field references through). Future refactor: hold for the parent's cluster-split, then redrive this subset. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/web/src/api/types/agent-types.ts",
    typeName: "AgentDetail",
    optionalCount: 18,
    reason: "(a) Wire-protocol DTO mirroring the `agents.get` RPC response shape. Each `?` field corresponds to a config section that may be absent for any given agent (no heartbeat config → no `heartbeat.target`; no concurrency overrides → no `concurrency`; no broadcastGroups → undefined). The dual flat-and-nested layout is intentional: the web SPA reads each top-level group as a renderable card. Marking required would force the daemon to emit zero-valued placeholders for every absent feature, breaking the 'feature inactive' UI signal. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/graph/graph-coordinator-state.ts",
    typeName: "GraphCoordinatorDeps",
    optionalCount: 16,
    reason: "(b) Cluster-split candidate: graph-coordinator deps span subagent spawning (spawn/kill/getRunStatus surface), per-channel announcement plumbing (sendToChannel, announceToParent), tuning knobs (maxConcurrency, maxResultLength, graphRetentionMs, maxParallelSpawns, maxGlobalSubAgents, spawnStaggerMs, cacheWriteTimeoutMs — each defaulted in factory), and observability/batching extras (logger, batcher, activeRunRegistry, nodeTypeRegistry, preWarm, touchParentSession). Future refactor: split into GraphSpawnDeps + GraphAnnounceDeps + GraphTuningConfig. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/web/src/views/config-editor/schema-form.ts",
    typeName: "SchemaProperty",
    optionalCount: 16,
    reason: "(a) JSON Schema mirror: each `?` field corresponds to ONE JSON Schema keyword (type, description, properties, items, enum, minimum, maximum, minLength, maxLength, pattern, required, default, anyOf, oneOf, allOf, additionalProperties). Any individual JSON Schema declares only the subset of keywords relevant to its node — e.g. a `{ type: 'integer', minimum: 0 }` carries no `pattern` or `items`. This matches the JSON Schema spec semantics; tightening would force the editor to emit empty arrays/objects for every schema node. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/context-engine/types-core.ts",
    typeName: "ContextEngineDeps",
    optionalCount: 15,
    reason: "(b) Cluster-split candidate: ContextEngineDeps mixes pipeline-layer getters (getSessionManager, getCompactionDeps, getRehydrationDeps — each `undefined` removes that layer from the pipeline), observability sinks (eventBus, agentId, sessionKey for log-context), feature callbacks (onContentModified, onAnchorReset, onSignatureReplayScrubbed), and replay-drift / token-anchor / thinking-keep override getters. Future refactor: split into ContextPipelineLayerDeps + ContextObservabilityDeps + ContextRecoveryDeps. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/command-directive-types.ts",
    typeName: "CommandDirectives",
    optionalCount: 14,
    reason: "(a) Mutually-exclusive directive bag: parsing a single slash command (`/think medium`, `/model claude-sonnet`, `/branch xyz`, `/reset`, `/compact verbose`, `/budget 500k`, etc.) sets ONE of the 14 fields; all others are `undefined`. The shape is the AGENT-LOCAL MIRROR of orchestrator's CommandDirectives (intentional duplication to break a packaging cycle — see file header lines 1-32). Marking required would force every parse to populate all 14 directives. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/sessions.ts",
    typeName: "SessionEntry",
    optionalCount: 14,
    reason: "(a) Dual-naming wire-compat shape (file:30 — 'Supports both canonical field names and daemon RPC field names'): `key|sessionKey`, `user|userId`, `channel|channelId`, `lastActive|updatedAt` carry the legacy + canonical names so the CLI renderer can fall back via nullish coalescing (file:125 `s.sessionKey ?? s.key ?? '-'`). Tightening either side would break the RPC-shape migration safety net. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/types.ts",
    typeName: "WizardState",
    optionalCount: 14,
    reason: "(a) Immutable state accumulator (per file:128 JSDoc: 'All fields are optional because they get filled as steps execute'). Each wizard step's `execute(state)` reads only the fields populated by prior steps and returns a new state with its own field populated. Marking required would force INITIAL_STATE to fabricate placeholders for every field; the file explicitly documents this as the intended pattern. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/commands/types.ts",
    typeName: "CommandDirectives",
    optionalCount: 14,
    reason: "(a) Mutually-exclusive directive bag (orchestrator side of the agent-local-mirror pair documented in command-directive-types.ts:1-32). Slash-command parser sets ONE field per invocation; all others stay `undefined`. Identical optional-field structure to agent's mirror by maintenance contract — both must move in lockstep. Marking required would force every slash-command parse to emit all 14 fields. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    typeName: "SubAgentRunnerDeps",
    optionalCount: 13,
    reason: "(a) Audited in Plan 41-06 (TS-HYG-10) with documented when-absent behavior in packages/agent/AUDIT.md per field: logger (no-op silent diagnostics), memoryAdapter (no completion-summary persistence), batcher (per-spawn announcements not coalesced), deadLetterQueue (failed announcements dropped after retry budget), activeRunRegistry/sessionResolver (no abort-on-kill capability), resultCondenser/condenserModel/condenserApiKey (raw subagent output passes through unmodified), narrativeCaster (no tagged narrative wrapping), dataDir (defaults to process cwd for subagent-results), lifecycleHooks (no prepare-spawn rollback hooks). Boundary value: 13 optionals exceeds 12-threshold by exactly 1; future refactor would require removing one rarely-used field. (TS-HYG-13 — Plan 41-08 audit; see also TS-HYG-10 architecture-test in packages/agent/src/__tests__/architecture.test.ts).",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/daemon-types.ts",
    typeName: "DaemonOverrides",
    optionalCount: 13,
    reason: "(a) Test injection bag (per file:111 JSDoc 'Overrides for dependency injection during testing'). Every `?` field is `typeof <productionFactory>` — production passes NONE of them; integration tests override the subset they want to fake (e.g. `timers: createFakeTimers()` for the .unref() preservation assertion at packages/daemon/src/__tests__). Marking required would force production daemon.ts to explicitly pass every production factory back through itself — pointless ceremony. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/platform-tools/registry.ts",
    typeName: "PlatformToolBuildContext",
    optionalCount: 13,
    reason: "(a) Tool-specific predicate signals (per file:95 JSDoc): each `?` corresponds to ONE platform tool's wiring requirement (approvalGate for tools needing approval, imageGenProvider for image_generate, backgroundTaskManager for background_tasks, toolCapabilityPort for capability index, contextEngineVersion for unified_context (gated on 'dag'), builtinToolsBrowserEnabled + browserSanitizeImage + browserPersistMedia + browserWorkspaceDir for the browser tool). Each descriptor's `conditional(ctx)` predicate inspects only the field it needs; marking all required would force unrelated tools to receive `undefined`-equivalent fabricated values. (TS-HYG-13 — Plan 41-08 audit).",
    removedIn: "phase-D",
  },
] as const;
// ============================================================================
// globalsAllowlist (Plan 37-06 → CLOSED at Phase 39 Plan 09)
//
// One entry per current callable-global site outside the bootstrap-allowlist
// paths in BOOTSTRAP_PATH_PATTERNS (test/support/globals-classifier.ts).
//
// Phase 39 closure state (PORTS-17 — final drain): every Phase-B PORTS retarget
// entry has been drained. Production source files in packages/{shared,core,
// agent,channels,cli,daemon,gateway,memory,orchestrator,scheduler,skills}/src/
// either consume ClockPort/EnvPort/TimerPort via injected Deps (Pattern A),
// indirect through @comis/core/runtime/system-time.ts sanctioned helpers
// (Pattern B), or live in a sanctioned root exempt from the classifier rule
// (BOOTSTRAP_PATH_PATTERNS). No retarget entry outlives its closure (PORTS-19).
//
// The 15 remaining entries below are NOT Phase 39 retarget debt — they are
// permanent architectural carve-outs for the web SPA browser bundle:
// packages/web/src/api/ is a leaf seam that WEB-CONTRACTS-15 forbids from
// importing any @comis/* workspace package (the SPA must work without a
// pnpm install). The direct setTimeout / setInterval / clearTimeout /
// Date.now calls in api-client.ts and rpc-client.ts are the right shape for
// a browser-resident bundle, and their classifier hits are sanctioned by
// the WEB-CONTRACTS-15 boundary contract rather than expected to drain.
//
// Drift history (kept for forensic audit): RESEARCH.md anticipated ~360+1
// entries; live tree at Phase 37 close held 1588 entries (the bootstrap.ts:89
// env fallback marker + 1587 Phase-B closure entries). Phase 39 closed all of
// them across Plans 03-08, including the env-fallback marker in Plan 03
// (PORTS-10). The +1226 drift was documented per RESEARCH.md Pitfall §1.
//
// Future regressions: any new outside-sanctioned-root direct-global call in
// packages/*/src/ MUST either retarget through the appropriate port at the
// composition root or be added here as a carve-out with a real reason. If
// you're adding an entry, the planner has missed an architectural decision —
// surface it before committing.
// ============================================================================
export const globalsAllowlist: readonly GlobalsAllowlistEntry[] = [
  // ============================================================================
  // Phase B — PORTS-11/12/13 closure (direct global calls retargeted to ports).
  // Final state at Phase 39 Plan 09 close: zero retarget entries remain;
  // only the WEB-CONTRACTS-15 web/api seam carve-outs (below) are kept.
  // Grouped by package, then sorted by file/line for stable diffs.
  // ============================================================================
  // ---- agent ----
  // Phase 39 Plan 05 Task 1: packages/agent/src/background/background-task-manager.ts
  // retargeted to ClockPort/TimerPort via injected deps. Drained 15 entries.
  // Phase 39 Plan 05 Task 2: agent/executor cohort retargeted to ClockPort/EnvPort/TimerPort.
  // Drained 75 globals entries across 22 files. Remaining 2 entries in cache-break-diff-writer.ts
  // are new Date(arg) parsing calls (not clock reads); kept as allowlist entries.
  // Phase 39 Plan 05 Task 3: safety/circuit-breaker.ts retargeted to ClockPort. Drained 3 entries.
  // Phase 39 Plan 05 Task 1: packages/agent/src/session/session-reset-policy.ts
  // retargeted to TimerPort via injected deps. Drained 2 entries.
  // Phase 39 Plan 05 Task 1: packages/agent/src/spawn/sub-agent-runner.ts
  // retargeted to ClockPort/TimerPort via injected deps. Drained 25 entries.
  // ---- channels ----
  // ---- cli ----
  // ---- core ----
  // ---- daemon ----
  // Phase 39 Plan 05 Task 1: setup-background-tasks.ts setInterval retargeted to
  // deps.timers.setInterval. Drained 1 entry.
  // Phase 39 Plan 05 Task 1: setup-cross-session.ts line numbers bumped due to
  // ClockPort/TimerPort thread-through into createSubAgentRunner. Underlying
  // globals here are out of scope for this task (daemon wiring helpers
  // retargeted in later plans).
  // Phase 39 Plan 05 Task 1: setup-schedulers.ts line numbers bumped +4 due to
  // ClockPort/TimerPort thread-through. Underlying globals here are out of
  // scope for this plan (daemon wiring helpers retargeted in later plans);
  // kept as allowlist entries pointing at the new line numbers.
  // ---- gateway ----
  // ---- memory ----
  // ---- orchestrator ----
  // ---- scheduler ----
  // ---- shared ----
  // Phase 39 Plan 08 (PORTS-14/15/16): packages/shared/src/timeout.ts
  // setTimeout/clearTimeout entries DRAINED. `withTimeout` no longer reads
  // either global — it takes a `scheduleTimeout: (cb, ms) => () => void`
  // callback that every consumer constructs from its TimerPort (Pattern A)
  // or `systemScheduleTimeout` from `@comis/core/runtime` (Pattern B).
  // The callback signature is a bare structural type, so `@comis/shared`
  // imports zero port types and remains the PORTS-16 leaf.
  // ---- skills ----
  // ---- web ----
  
  {
    file: "packages/web/src/api/api-client.ts",
    line: 439,
    global: "Date.now",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/api-client.ts",
    line: 440,
    global: "Date.now",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 105,
    global: "clearInterval",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 109,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 116,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 123,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 131,
    global: "setInterval",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 138,
    global: "setTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 150,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 157,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 161,
    global: "setTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 183,
    global: "setTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 229,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 299,
    global: "setTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 320,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — WEB-CONTRACTS-15 forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
] as const;
export const noBackwardCompatAllowlist: readonly NoBackwardCompatAllowlistEntry[] = [
  {
    file: "packages/core/src/config/migrate.ts",
    line: 1,
    reason: "Streaming-config schema migration (defaultPacingMinMs/Max + coalesceMaxChars -> defaultDeliveryTiming/coalescer). @migration-since: 2026-04-22; remove-after: v2.2. Operator-side migration is still realistic; remove when no production config still uses the pre-migration shape.",
  },
] as const;
export const coverageWaiver: readonly CoverageWaiverEntry[] = [
  {
    file: "packages/agent/src/executor/cache-detection/cache-state-types.ts",
    reason: "Pure type-only module (Phase 42 EXEC-SPLIT-09 split). 8 public interfaces + 1 union type; no runtime values to test. Type-level surface is verified by the parity test (cache-break-detection.parity.test.ts) and by the consumers that compile-check the imports.",
  },
  {
    file: "packages/agent/src/executor/cache-detection/index.ts",
    reason: "Barrel re-export module (Phase 42 EXEC-SPLIT-09 split). Re-exports 18 canonical public symbols from 4 leaf modules without aliases or transformation; surface is verified by the parity test (cache-break-detection.parity.test.ts).",
  },
  // -- Phase 42 EXEC-SPLIT-02 (request-body/) --
  // The Rule-3 split of request-body-injector.ts produced 22 modules. The 4
  // module-aligned test neighbors (factory.test.ts, cache-breakpoints.test.ts,
  // breakpoint-placement.test.ts, tool-result-clearing.test.ts) cover ~95% of
  // the surface. The remaining 18 modules are waived below because they are
  // either pure types, barrels, or factory-pipeline phase extractions whose
  // behavior is exercised end-to-end by factory.test.ts (the renamed-and-
  // shrunk 6,800L integration suite — was request-body-injector.test.ts).
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/index.ts",
    reason: "Barrel re-export module (Phase 42 EXEC-SPLIT-02 split). Re-exports 15 canonical public symbols + RequestBodyInjectorConfig type from sibling leaf modules without aliases; surface is verified by the parity test (request-body-injector.parity.test.ts) and stream-wrappers/index.test.ts.",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/types.ts",
    reason: "Pure type-only module (Phase 42 EXEC-SPLIT-02 split). Hosts RequestBodyInjectorConfig (32 optional fields); no runtime values to test. Type-level surface is verified by the parity test + compile-time imports.",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/cache-control-block.ts",
    reason: "Phase 42 EXEC-SPLIT-02 internal leaf. Hosts CACHEABLE_BLOCK_TYPES + addCacheControlToLastBlock. Public symbols are tested via cache-breakpoints.test.ts (re-exports the canonical names).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/cadence-tracker.ts",
    reason: "Phase 42 EXEC-SPLIT-02 module-state extraction (sessionCadenceTracker + threshold constants + clearSessionCadenceTracker). State mutated by the factory; behavior covered by factory.test.ts (sticky-on / promotion-on-slow-cadence flows).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/context-window.ts",
    reason: "Phase 42 EXEC-SPLIT-02 module-state extraction (sessionBetaHeaderLatches + CONTEXT_1M_BETA + parseHeaderList + clearSessionBetaHeaderLatches). State mutated by the factory; behavior covered by factory.test.ts (sticky-on beta header latches flow).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/service-tier.ts",
    reason: "Phase 42 EXEC-SPLIT-02 leaf injector — Concern 3 (service_tier flag for Responses API + fastMode). Behavior covered by factory.test.ts (service_tier integration tests inside createRequestBodyInjector).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/store-flag.ts",
    reason: "Phase 42 EXEC-SPLIT-02 leaf injector — Concern 4 (store flag for Responses API + storeCompletions) + isResponsesApiProvider helper. Behavior covered by factory.test.ts (store integration tests inside createRequestBodyInjector).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/token-estimation.ts",
    reason: "Phase 42 EXEC-SPLIT-02 single-function leaf (estimateBlockTokens). Behavior covered by factory.test.ts (TTL estimation cleanup + gap closure: single TTL estimation pass).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/tool-cache.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (rendered tool cache + per-tool memoization). Behavior covered by factory.test.ts (Rendered tool cache, all-deferred tool hash skip, per-tool content-addressed memoization).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/microcompact.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (runTimeBasedMicrocompact + runTokenCeilingMicrocompact). Behavior covered by factory.test.ts (Time-based microcompact, token-ceiling microcompact, selective tool-type clearing, dual-category tool clearing, fence-aware microcompaction).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/prefix-stability.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (runPrefixStabilityDiagnostic). Behavior covered by factory.test.ts (prefix stability diagnostic describe inside skipCacheWrite shared-prefix marker placement).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/breakpoint-orchestration.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (runCacheBreakpointPhase — Concern 1: multi-block system prompt, defer_loading, graph-context, placement, cache fence callback). Behavior covered by factory.test.ts (createRequestBodyInjector, Multi-block system prompt injection, breakpoint cap increase, breakpoint strategy config, Rendered tool cache, defer_loading injection, skipCacheWrite for sub-agent spawns, Per-model kill switch, zone-aware retention).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/cadence-tracking.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (trackRecentZoneCadence — post-payload cadence promote/demote). Behavior covered by factory.test.ts (zone-aware retention describe: recent-zone promotion on slow cadence + demotion on fast cadence).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/marker-upgrade.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (upgradeSdkMarkers — SDK 5m → 1h upgrade when retention is long). Behavior covered by factory.test.ts (zone-aware retention, TTL estimation cleanup describe).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/skip-cache-write-marker.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (placeSkipCacheWriteMarker — shared-prefix marker for sub-agent spawns). Behavior covered by factory.test.ts (skipCacheWrite for sub-agent spawns, skipCacheWrite shared-prefix marker placement).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/kill-switch.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (applyKillSwitch — strip all cache_control when retention=none). Behavior covered by factory.test.ts (Per-model kill switch strips ALL cache_control markers).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/ttl-split-estimation.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (estimateTtlSplit — per-TTL token attribution via onTtlSplitEstimate). Behavior covered by factory.test.ts (TTL estimation cleanup, gap closure: single TTL estimation pass).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/tool-deferral-injection.ts",
    reason: "Phase 42 EXEC-SPLIT-02 factory phase (injectToolDeferral — defer_loading injection + server-side tool_search swap). Behavior covered by factory.test.ts (createRequestBodyInjector — defer_loading injection).",
  },
  // -- Phase 42 EXEC-SPLIT-07 (prompt-runner/) --
  {
    file: "packages/agent/src/executor/prompt-runner/index.ts",
    reason: "Barrel re-export module (Phase 42 EXEC-SPLIT-07 split). Re-exports 4 canonical public symbols (runPrompt + 3 interfaces) from sibling leaf modules without aliases; surface is verified by the parity test (executor-prompt-runner.parity.test.ts) and by the EXEC-SPLIT-08 dependency-direction structural test.",
  },
  {
    file: "packages/agent/src/executor/prompt-runner/prompt-runner-types.ts",
    reason: "Pure type-only module (Phase 42 EXEC-SPLIT-07 split). Hosts 3 public interfaces (PromptRunnerBridge, RunPromptParams, PromptRunResult); no runtime values to test. Type-level surface is verified by the parity test (executor-prompt-runner.parity.test.ts) + compile-time imports.",
  },
  {
    file: "packages/agent/src/executor/prompt-runner/failure-path.ts",
    reason: "Phase 42 EXEC-SPLIT-07 Rule 3 sub-module of output-escalation.ts (failure-path overflow recovery + error classification + timeout ghost-cost emission + OutputGuard error scan). Was extracted to keep output-escalation.ts under the 500L cap. Each downstream symbol is independently tested (overflow-recovery.test.ts, error-classifier.test.ts, executor-response-filter.test.ts); end-to-end failure-path semantics are exercised by the integration suite.",
  },
  // -- Phase 42 EXEC-SPLIT-05 (pi-executor/) --
  {
    file: "packages/agent/src/executor/pi-executor/index.ts",
    reason: "Barrel re-export module (Phase 42 EXEC-SPLIT-05 split). Re-exports 3 canonical public values (createPiExecutor + createBeforeToolCallGuard + mergeSessionStats) + 1 type (PiExecutorDeps) from sibling leaf modules without aliases; surface is verified by the parity test (pi-executor.parity.test.ts) and by the EXEC-SPLIT-06 closure-extraction structural test.",
  },
  {
    file: "packages/agent/src/executor/pi-executor/pi-executor-types.ts",
    reason: "Pure type-only module (Phase 42 EXEC-SPLIT-05 split). Hosts PiExecutorDeps interface (42 optional fields); no runtime values to test. Extracted to a dedicated file to break the cyclic-import detected by no-cycles.test.ts when the closure-extracted helpers (safety-gate, compaction-trigger, etc.) import the type. Type-level surface is verified by the parity test (pi-executor.parity.test.ts) + the cluster-split allowlist entry that tracks the structural state.",
  },
] as const;

/**
 * COV-10 test-naming allowlist — see TestNamingAllowlistEntry doc.
 * Plan 40-10 captures the current state (434 entries: ~85% predicate-2
 * (min-length), ~15% predicate-3 (use-case shape heuristic miss)). The
 * shrink ratchet (allowlist-shrink.test.ts) enforces this list shrinks
 * over time — adding entries requires PR-review citing the reason.
 */
export const testNamingAllowlist: readonly TestNamingAllowlistEntry[] = [
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 23, kind: "test", text: "yfinance", reason: "Plan-40-10 captured (min-length=8; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 24, kind: "test", text: "@scope/pkg", reason: "Plan-40-10 captured (min-length=10); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 25, kind: "test", text: "pandas-datareader", reason: "Plan-40-10 captured (min-length=17; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 26, kind: "test", text: "yfinance.cache", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 27, kind: "test", text: "Pillow", reason: "Plan-40-10 captured (min-length=6; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 31, kind: "test", text: "; rm -rf /", reason: "Plan-40-10 captured (min-length=10; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 32, kind: "test", text: "eval()", reason: "Plan-40-10 captured (min-length=6; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 33, kind: "test", text: "package with spaces", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 34, kind: "test", text: "", reason: "Plan-40-10 captured (min-length=0; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 35, kind: "test", text: "-leading-dash", reason: "Plan-40-10 captured (min-length=13; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 36, kind: "test", text: "@/no-name", reason: "Plan-40-10 captured (min-length=9; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/channels.test.ts", line: 420, kind: "it", text: "accepts response", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/channels.test.ts", line: 451, kind: "it", text: "accepts request", reason: "Plan-40-10 captured (min-length=15); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/daemon.test.ts", line: 94, kind: "it", text: "scopes are correct", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/observability.test.ts", line: 437, kind: "it", text: "obs.delivery.stats: response shape", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/observability.test.ts", line: 565, kind: "it", text: "obs.getCacheStats: response shape", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 117, kind: "it", text: "cron-handlers + graph-handlers: all rpc-scoped per setup-gateway-api.ts:130-157 + 317-321", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 227, kind: "it", text: "method name", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 565, kind: "it", text: "response", reason: "Plan-40-10 captured (min-length=8; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 598, kind: "it", text: "request requires id", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 728, kind: "it", text: "response", reason: "Plan-40-10 captured (min-length=8; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 845, kind: "it", text: "response", reason: "Plan-40-10 captured (min-length=8; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 891, kind: "it", text: "response", reason: "Plan-40-10 captured (min-length=8; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 227, kind: "it", text: "method name", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 293, kind: "it", text: "method name", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 362, kind: "it", text: "method name", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 439, kind: "it", text: "method name", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 493, kind: "it", text: "method name", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/core/src/config/layered.test.ts", line: 31, kind: "it", text: "merges flat objects", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 42, kind: "it", text: "rejects zero values", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 54, kind: "it", text: "parses valid input", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 104, kind: "it", text: "allows empty object", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 240, kind: "it", text: "rejects zero values", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-agent.test.ts", line: 722, kind: "it", text: "rejects empty id", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 169, kind: "it", text: "rejects non-integer", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 199, kind: "it", text: "accepts 'pipeline'", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 204, kind: "it", text: "accepts 'dag'", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 220, kind: "it", text: "defaults to 10", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 314, kind: "it", text: "defaults to 15", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 458, kind: "it", text: "defaults to 5", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 497, kind: "it", text: "defaults to 2", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 521, kind: "it", text: "defaults to 8", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 550, kind: "it", text: "defaults to 0.75", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 579, kind: "it", text: "defaults to 8", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 608, kind: "it", text: "defaults to 4", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 637, kind: "it", text: "defaults to 2", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 666, kind: "it", text: "defaults to 0", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 695, kind: "it", text: "defaults to 20000", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 724, kind: "it", text: "defaults to 1200", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 753, kind: "it", text: "defaults to 2000", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 782, kind: "it", text: "defaults to 4000", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 811, kind: "it", text: "defaults to 10", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 840, kind: "it", text: "defaults to 120000", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 869, kind: "it", text: "defaults to 25000", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 898, kind: "it", text: "defaults to 15", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 927, kind: "it", text: "defaults to 200000", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-gateway.test.ts", line: 187, kind: "it", text: "rejects empty id", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/config/schema-queue.test.ts", line: 163, kind: "it", text: "rejects empty name", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/config/section-registry-parity.test.ts", line: 38, kind: "it", text: "getConfigSections()", reason: "Plan-40-10 captured (min-length=19; use-case-shape heuristic miss); shrink in follow-on plan. Line shifted from 51 → 38 by Phase 43 Plan 01 stableStringify extraction (inline function removed in favor of test/support/stable-stringify.ts import per FILE-SPLIT-17)." },
  { file: "packages/core/src/config/section-registry-parity.test.ts", line: 98, kind: "it", text: "MANAGED_SECTIONS — 5-entry array", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan. Line shifted from 111 → 98 by Phase 43 Plan 01 stableStringify extraction (inline function removed in favor of test/support/stable-stringify.ts import per FILE-SPLIT-17)." },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 70, kind: "it", text: "renders bold", reason: "Plan-40-10 captured (min-length=12); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 74, kind: "it", text: "renders italic", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 78, kind: "it", text: "renders inline code", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 86, kind: "it", text: "renders links", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 95, kind: "it", text: "renders headings", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 99, kind: "it", text: "renders h2 heading", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 103, kind: "it", text: "renders blockquotes", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 133, kind: "it", text: "renders inline code", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 154, kind: "it", text: "renders blockquotes", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 216, kind: "it", text: "renders blockquotes", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 258, kind: "it", text: "renders inline code", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 363, kind: "it", text: "renders lists", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 392, kind: "it", text: "renders lists", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 126, kind: "it", text: "parses h1 heading", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 223, kind: "it", text: "parses ordered list", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 363, kind: "it", text: "parses inline code", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 377, kind: "it", text: "parses links", reason: "Plan-40-10 captured (min-length=12); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/markdown-tables.test.ts", line: 134, kind: "it", text: "handles empty cells", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/permanent-errors.test.ts", line: 6, kind: "it", text: "exports 7 patterns", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/retry-engine.test.ts", line: 139, kind: "it", text: "handles nested tags", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/retry-engine.test.ts", line: 430, kind: "it", text: "resets on success", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 163, kind: "it", text: "preserves autolinks", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 181, kind: "it", text: "decodes &amp; to &", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 185, kind: "it", text: "decodes &lt; to <", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 189, kind: "it", text: "decodes &gt; to >", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 26, kind: "it", text: "wraps config.go", reason: "Plan-40-10 captured (min-length=15); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 32, kind: "it", text: "wraps utils.py", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 38, kind: "it", text: "wraps README.md", reason: "Plan-40-10 captured (min-length=15); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 44, kind: "it", text: "wraps script.sh", reason: "Plan-40-10 captured (min-length=15); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 50, kind: "it", text: "wraps main.rs", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 56, kind: "it", text: "wraps handler.pl", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 62, kind: "it", text: "wraps index.ts", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 68, kind: "it", text: "wraps app.js", reason: "Plan-40-10 captured (min-length=12); shrink in follow-on plan" },
  { file: "packages/core/src/domain/credential-mapping.test.ts", line: 151, kind: "it", text: "rejects empty id", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/core/src/domain/credential-mapping.test.ts", line: 171, kind: "it", text: "rejects null input", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/domain/execution-graph.test.ts", line: 66, kind: "it", text: "rejects empty task", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/domain/memory-entry.test.ts", line: 80, kind: "it", text: "accepts tags array", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/domain/normalized-message.test.ts", line: 211, kind: "it", text: "rejects null input", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/domain/session-key.test.ts", line: 119, kind: "it", text: "rejects null input", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/domain/session-key.test.ts", line: 137, kind: "it", text: "formats basic key", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/event-bus/bus.test.ts", line: 30, kind: "it", text: "off removes handler", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/hooks/hook-strategies.test.ts", line: 40, kind: "it", text: "rejects wrong types", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/hooks/integration.test.ts", line: 248, kind: "it", text: "config-driven plugin enablement (schema validation)", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/logging/console-logger.test.ts", line: 64, kind: "it", text: ".level is settable", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 179, kind: "it", text: "strips BOM (U+FEFF)", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 206, kind: "test", text: "<!-- normal comment -->", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 214, kind: "test", text: "<div style=\"color: red\">", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 236, kind: "test", text: "cat /home/user/.env", reason: "Plan-40-10 captured (min-length=19; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 238, kind: "test", text: "cat README.md", reason: "Plan-40-10 captured (min-length=13; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/security/injection-rate-limiter.test.ts", line: 158, kind: "it", text: "custom warnThreshold and auditThreshold", reason: "Plan-40-10 captured (use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/security/profile-id.test.ts", line: 84, kind: "test", text: "openai-codex", reason: "Plan-40-10 captured (min-length=12; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/core/src/security/safe-path.test.ts", line: 28, kind: "it", text: "rejects bare ..", reason: "Plan-40-10 captured (min-length=15); shrink in follow-on plan" },
  { file: "packages/core/src/security/secret-crypto.test.ts", line: 107, kind: "it", text: "parses hex string", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/security/secret-crypto.test.ts", line: 123, kind: "it", text: "rejects short key", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/core/src/security/secrets-audit.test.ts", line: 181, kind: "it", text: "skips PATH and HOME", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/core/src/security/secrets-audit.test.ts", line: 212, kind: "it", text: "skips empty values", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tool-helpers.test.ts", line: 287, kind: "it", text: "returns valid value", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tools/sessions-history-tool.test.ts", line: 65, kind: "it", text: "throws on RPC error", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tools/sessions-list-tool.test.ts", line: 50, kind: "it", text: "throws on RPC error", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tools/sessions-send-tool.test.ts", line: 83, kind: "it", text: "throws on RPC error", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tools/sessions-spawn-tool.test.ts", line: 93, kind: "it", text: "throws on RPC error", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tools/unified-memory-tool.test.ts", line: 69, kind: "it", text: "passes custom limit", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/platform-tools/tools/unified-session-tool.test.ts", line: 57, kind: "it", text: "passes custom limit", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/skills/bridge/schema-validator.test.ts", line: 37, kind: "it", text: "rejects null params", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/skills/prompt/processor.test.ts", line: 22, kind: "it", text: "escapes ampersand", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/skills/src/skills/prompt/sanitizer.test.ts", line: 73, kind: "it", text: "removes soft hyphen", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/skills/registry/discovery.test.ts", line: 199, kind: "it", text: "skips node_modules", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/browser-service.test.ts", line: 117, kind: "it", text: "rejects data: URLs", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/browser-service.test.ts", line: 131, kind: "it", text: "rejects empty URL", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/cdp.test.ts", line: 259, kind: "it", text: "finds target by id", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/chrome-detection.test.ts", line: 207, kind: "it", text: "finds brave-browser", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/chrome-detection.test.ts", line: 220, kind: "it", text: "finds snap chromium", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/chrome-detection.test.ts", line: 476, kind: "it", text: "sends SIGTERM first", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/config.test.ts", line: 59, kind: "it", text: "accepts valid port", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/config.test.ts", line: 112, kind: "it", text: "overrides headless", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/config.test.ts", line: 117, kind: "it", text: "overrides noSandbox", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 25, kind: "it", text: "matches valid names", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 26, kind: "test", text: "my-profile", reason: "Plan-40-10 captured (min-length=10; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 27, kind: "test", text: "test123", reason: "Plan-40-10 captured (min-length=7); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 28, kind: "test", text: "ab", reason: "Plan-40-10 captured (min-length=2; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 29, kind: "test", text: "a0", reason: "Plan-40-10 captured (min-length=2; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 33, kind: "test", text: "", reason: "Plan-40-10 captured (min-length=0; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 34, kind: "test", text: "a", reason: "Plan-40-10 captured (min-length=1; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 35, kind: "test", text: "A-B", reason: "Plan-40-10 captured (min-length=3; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 36, kind: "test", text: "-start", reason: "Plan-40-10 captured (min-length=6); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 37, kind: "test", text: "end-", reason: "Plan-40-10 captured (min-length=4; use-case-shape heuristic miss); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 38, kind: "test", text: "with spaces", reason: "Plan-40-10 captured (min-length=11); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 39, kind: "test", text: "with!special", reason: "Plan-40-10 captured (min-length=12); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/exec-tool.test.ts", line: 87, kind: "it", text: "stderr is captured", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/exec-tool.test.ts", line: 231, kind: "it", text: "mkfs is rejected", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/exec-tool.test.ts", line: 1294, kind: "it", text: "stderr is captured", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan. Phase 43 plan 02a shifted line 1292 → 1294 via source-grep target retargeting (FILE-SPLIT-02)." },
  { file: "packages/skills/src/tools/builtin/file-tools/notebook-edit-tool.test.ts", line: 409, kind: "it", text: "delete cell by ID", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/file-tools/shared/edit-diff.test.ts", line: 83, kind: "it", text: "applies single edit", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/file-tools/shared/file-encoding.test.ts", line: 108, kind: "it", text: "restores CR endings", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/file/apply-patch-similarity.test.ts", line: 54, kind: "it", text: "strips BOM", reason: "Plan-40-10 captured (min-length=10); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/file/apply-patch-similarity.test.ts", line: 67, kind: "it", text: "converts en dash", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/file/apply-patch-similarity.test.ts", line: 71, kind: "it", text: "converts em dash", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/file/safe-path-wrapper.test.ts", line: 46, kind: "it", text: "has 2 entries", reason: "Plan-40-10 captured (min-length=13); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/output-cleaner.test.ts", line: 105, kind: "it", text: "strips NUL bytes", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/output-cleaner.test.ts", line: 118, kind: "it", text: "preserves tabs", reason: "Plan-40-10 captured (min-length=14); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/truncate.test.ts", line: 44, kind: "it", text: "handles empty input", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/web-fetch-visibility.test.ts", line: 126, kind: "it", text: "removes meta tags", reason: "Plan-40-10 captured (min-length=17); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/web-fetch-visibility.test.ts", line: 252, kind: "it", text: "handles empty HTML", reason: "Plan-40-10 captured (min-length=18); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/builtin/web-shared.test.ts", line: 87, kind: "it", text: "is 2MB", reason: "Plan-40-10 captured (min-length=6); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/integrations/image-gen/fal-adapter.test.ts", line: 25, kind: "it", text: "id is fal", reason: "Plan-40-10 captured (min-length=9); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/integrations/image-gen/openai-adapter.test.ts", line: 21, kind: "it", text: "id is openai", reason: "Plan-40-10 captured (min-length=12); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/media/media-store.test.ts", line: 184, kind: "it", text: "rejects invalid IDs", reason: "Plan-40-10 captured (min-length=19); shrink in follow-on plan" },
  { file: "packages/skills/src/tools/media/mime-detection.test.ts", line: 149, kind: "it", text: "trims whitespace", reason: "Plan-40-10 captured (min-length=16); shrink in follow-on plan" },
] as const;
