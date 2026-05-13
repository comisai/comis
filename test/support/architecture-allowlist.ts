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
export const fileSizeAllowlist: readonly FileSizeAllowlistEntry[] = [] as const;
export const rawThrowAllowlist: readonly RawThrowAllowlistEntry[] = [] as const;
export const untypedSqliteAllowlist: readonly UntypedSqliteAllowlistEntry[] = [] as const;
export const optionalFieldAllowlist: readonly OptionalFieldAllowlistEntry[] = [] as const;
export const globalsAllowlist: readonly GlobalsAllowlistEntry[] = [] as const;
export const noBackwardCompatAllowlist: readonly NoBackwardCompatAllowlistEntry[] = [] as const;
export const coverageWaiver: readonly CoverageWaiverEntry[] = [] as const;
