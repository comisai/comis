// SPDX-License-Identifier: Apache-2.0
// @comis/daemon - production daemon entry point
//
// Test-only root re-exports policy:
// The four `createXxx`/`createYyy`/etc. re-exports below all have real
// in-repo test consumers — each line carries a per-consumer breadcrumb.
// They survive the BC-shim sweep because:
//   1. Tests live under test/**, which the public-export-consumers AST
//      walker explicitly excludes — so the entries appear as "orphans"
//      to the walker but ARE consumed (Path B preserve-with-docs).
//   2. The test/support/public-api-policy.ts entry for `@comis/daemon`
//      tracks these four symbols + their consumer file paths.
// Do NOT delete these re-exports without retargeting the consumers
// listed in test/support/public-api-policy.ts.

// Daemon entry point and types for integration test harness
export { main } from "./daemon.js";
export type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";

// Announcement dead-letter queue (canonical surface lives in
// packages/orchestrator/src/cross-session/; re-exported here so the
// daemon's public API contract stays stable for the
// resilience-e2e-dead-letter integration test).
// Consumer: test/integration/resilience-e2e-dead-letter.test.ts:22
export { createAnnouncementDeadLetterQueue } from "@comis/orchestrator";
export type { AnnouncementDeadLetterQueue, DeadLetterEntry } from "@comis/orchestrator";

// Auth handlers: encrypted OAuth-profile management (auth.set / auth.list /
// auth.logout) — re-exported so the auth-set-encrypted integration test can
// drive the real admin-gated auth.set handler against a mock
// OAuthCredentialStorePort, proving the round-trip + residency invariant
// (no plaintext token bytes in responses/logs/audit) without spinning up a
// full daemon or opening a real secrets.db.
// Consumer: test/integration/auth-set-encrypted.test.ts
export { createAuthHandlers } from "./api/auth-handlers.js";
export type { AuthHandlerDeps } from "./api/auth-handlers.js";

// Memory handlers: memory + memory-diagnostic RPC handlers —
// re-exported so the recall-diagnostics isolation integration test can drive
// the actual admin-gated memory.observations / memory.entities /
// memory.recall_stats / memory.recall_trace handlers against the REAL wired
// scoped stores, proving the cross-scope-leak negative + the EoP admin-reject
// through the RPC layer (not just the adapter).
// Consumer: test/integration/security/recall-diagnostics-isolation.test.ts
export { createMemoryHandlers } from "./api/memory-handlers.js";
export type { MemoryHandlerDeps } from "./api/memory-handlers.js";

// Agent management RPC handlers — re-exported so the multi-account
// integration test can drive the actual `agents.update` RPC handler against a
// shared `agents` map, mirroring the daemon-runtime container.config.agents
// pattern at daemon.ts:594/634.
// Consumer: test/integration/oauth-multi-account.test.ts:80,580
export { createAgentHandlers } from "./api/agent-handlers.js";
export type { AgentHandlerDeps } from "./api/agent-handlers.js";

// MCP management RPC handlers — re-exported so the MCP
// install persistence integration test
// (test/integration/mcp-persistence.test.ts) can drive the actual
// `mcp.connect` / `mcp.disconnect` RPC handlers against a real
// persistToConfig + appendConfigAuditWithOutcome pipeline pointed at a
// tmpdir config path. Mirrors the createAgentHandlers re-export above.
//
// Module-level reset helpers from persist-to-config.ts are also surfaced
// here because the persistToConfig writer holds two PROCESS-WIDE
// singletons (sigusr1Timer + pendingConfigMutations fence) that MUST be
// reset in beforeEach so a prior test's armed SIGUSR2 timer / pending
// fence does not leak into the next test (per the module-level state
// docs at packages/daemon/src/api/shared/persist-to-config.ts:12-43).
export { createMcpHandlers } from "./api/mcp-handlers.js";
export type { McpHandlerDeps } from "./api/mcp-handlers.js";
// mcp.oauth_login / mcp.oauth_logout RPC handlers.
export { createMcpOauthHandlers } from "./api/mcp-oauth-handlers.js";
export type { McpOauthHandlerDeps } from "./api/mcp-oauth-handlers.js";
// Extracted single-writer for integrations.mcp.servers.
// Consumers: the bundle-install helper and boot-path orchestrator both reach
// the helper through this barrel re-export so neither needs a direct
// daemon-internal import.
export { persistMcpServers, type PersistMcpResult } from "./api/shared/persist-mcp-servers.js";
export {
  _resetSigusr1Timer,
  _resetMutationFence,
} from "./api/shared/persist-to-config.js";
// Test seam: 500ms trailing-edge coalescer holds
// closure-captured state across all persistMcpServers calls in a daemon
// process. Integration tests call this in `beforeEach` to clear pending
// added/removed maps and cancel any armed timer, mirroring the
// _resetSigusr1Timer / _resetMutationFence pattern at persist-to-config.ts.
// Consumer: test/integration/mcp-config-refresh.test.ts.
export { _resetConfigMutatedCoalescer } from "./api/mcp-config-mutated-coalescer.js";

// Test seam for the exactly-once chaos test
// (test/integration/durable-resume-e2e.test.ts) arms a crash-injection hook in
// the REAL wrapOutwardSend so a live autonomy-originated send crashes in the
// invariant-#12 window (between markUnknown and commit), leaving a genuine
// unknown_after_send row for the post-restart recovery to reconcile. INERT in
// production (never armed); mirrors the _resetSigusr1Timer test-seam pattern.
export {
  __setOutwardSendCrashHookForTest,
  OUTWARD_SEND_CRASH_SENTINEL,
  type OutwardSendCrashHookMode,
} from "./api/outward-ledger-wrap.js";

// Bundle-install helper + boot orchestrator surfaced through the daemon barrel
// so the skill-bundle-install integration test
// (test/integration/skill-bundle-install.test.ts) can drive the
// atomic-install reject path + the boot re-merge idempotence path
// against the REAL persistToConfig + audit JSONL pipeline pointed at a
// tmpdir config path. Mirrors the createMcpHandlers / persistMcpServers
// re-export pattern above.
export { applyBundleInstall } from "./skills/bundle-install-helper.js";
export type {
  ApplyBundleInstallArgs,
  ApplyBundleInstallResult,
} from "./skills/bundle-install-helper.js";

// The single skill-import orchestration. Surfaced through the barrel so the RPC
// retrofit consumes ONE path (Phase-A always runs pre-write) and the
// ground-truth integration test (test/integration/skill-import-commit.test.ts)
// drives stage→commit against a REAL provenance store + REAL discovery.
// `commitStagedImport` + the commit-marker/sweep helpers stay module-local (the
// daemon boot + runSkillImport consume them via relative imports). Mirrors the
// applyBundleInstall test-driven re-export precedent above.
export { runSkillImport } from "./skills/import-commit.js";
export type { RunSkillImportOpts, SkillImportDeps } from "./skills/import-commit.js";
// sweepOrphanedImports / defaultSweepDeps are NOT barrel-exported: the daemon
// boot consumes them via the relative `./skills/import-boot-sweep.js` path.
export { setupSkillBundles, buildSkillRegistriesForBundles } from "./wiring/setup-skill-bundles.js";
export type { SetupSkillBundlesDeps } from "./wiring/setup-skill-bundles.js";

// Resolve-seam learned-skill promote/demote loop body + the in-process
// decay-aware trend tracker, surfaced through the daemon barrel so the
// source-agnostic characterization
// (test/integration/mental-model-readonly-lifecycle.test.ts) can drive the REAL
// transition path — a hand-authored (no-synthesis) mental_models doc promotes via
// promoteByName EXACTLY as a synthesized skill — instead of a store-only fallback.
// Both are name-keyed and (tenant, agent)-scoped via the LearningScope/skillGaugeKey
// they consume (no new data path / secret / cross-tenant widening). Mirrors the
// skill-bundle-install test-driven re-export precedent above.
export { applySkillOutcomeTransitions } from "./wiring/setup-learning-skill-transitions.js";
export { createSkillTrendTracker } from "./wiring/setup-learning-skill-trend.js";

// Re-export createTracingLogger so the test daemon harness can thread the
// `LoggerOptions.disableRedaction` opt-in through to the SAME logger
// instance the daemon uses for production code paths. Consumer is
// test/support/daemon-harness.ts via
// startTestDaemon({ disableRedaction: ...trueValue... }) for the
// integration test.
//
// Note on phrasing: the literal token sequence `disableRedaction[:][space][true]`
// is deliberately AVOIDED in this comment so the per-package source-rule
// walker at test/architecture/source-rules.test.ts does not trip its own
// invariant (the walker source-greps `packages/*\/src/**` for that exact
// byte sequence).
// Consumer: test/support/daemon-harness.ts:434-442 (DYNAMIC require)
export { createTracingLogger } from "./observability/trace-logger.js";
export type { TracingLoggerOptions } from "./observability/trace-logger.js";

// Startup invariant collector — re-exported so the
// acceptance gate integration test can call emitStartupInvariants against
// a mock logger without spinning up the full daemon.
// Consumer: test/integration/incident-replay-2026-05-24.test.ts
export { emitStartupInvariants } from "./wiring/setup-startup-invariants.js";
export type { StartupInvariantsDeps, StartupInvariants } from "./wiring/setup-startup-invariants.js";

// Obs-explain assembler + reader DI seam — re-exported so the RE-PROVE
// scenario (test/live) can call the FROZEN assembler over a fixture
// reader without a deep daemon-internal dist path. Read-only; the admin gate
// stays on bindObsExplainHandlers (obs-explain.ts:188) — this exports ONLY the
// gate-free assembler the live-scenario tests + the obs_explain MCP tool already call with
// no _trustLevel, NEVER the admin-gated handler.
// Consumer: test/live/scenarios/prove/diagnosis-reprove.test.ts
export { assembleIncidentReportFromSources } from "./api/obs-handlers/obs-explain.js";
export { makeRealReader } from "./api/obs-handlers/obs-explain-readers.js";
export type { IncidentSourceReader } from "./api/obs-handlers/obs-explain-readers.js";
// Public sessionKey → real session `.jsonl` resolver (pointer discipline).
// Re-exported so the CLI support-bundle seam resolves a session file the ONE
// authoritative way — never a hand-built flat `<dataDir>/sessions/<id>` path.
export { resolveSessionFilePath } from "./api/obs-handlers/obs-explain-readers.js";

// Fleet-health assembler RE-PROVE seam — mirrors the obs-explain
// precedent above. Re-exported from the TOP-LEVEL barrel so the keyless fleet
// RE-PROVE scenario (test/live) can `import { assembleFleetHealthReport } from
// "@comis/daemon"` — the live config aliases ONLY the top-level @comis/daemon ->
// daemon/dist/index.js (no obs-handlers subpath alias). The gate-free assembler
// only; the admin gate stays on bindFleetHealthHandlers (fleet-health.ts).
// Consumer: test/live/scenarios/prove/fleet-reprove.test.ts
export { assembleFleetHealthReport } from "./api/obs-handlers/fleet-health.js";

// pi-ai image shim: `createPiImageAdapter` +
// `registerComisImageProviders` + `resolveImageApiKey` + the typed cross-plan
// `ImageGenError` live in `./api/pi-image-adapter.js`. They are daemon-internal
// — consumed via relative imports (`wiring/setup-image-provider`,
// `wiring/main-helpers`) — and intentionally NOT on the public barrel until a
// cross-package consumer exists (public-export-consumers gate). A future-phase
// transport that genuinely needs one cross-package re-exports it here then.

// DENYLISTED_RPC_METHODS (RE-PROVE seam) — the cap-socket's
// method-precise closed-door set (the `skills_manage`/admin-management methods the
// endpoint's pre-check throws on BEFORE `validate()`). Re-exported from the
// top-level barrel so the `comis-agent-same-gate` / `comis-agent-no-admin`
// arch-tests DERIVE the denylisted-method set from the SAME source the endpoint
// uses (no hand-maintained literal that drifts). Pure additive `export` — the
// const + its `SUB_AGENT_TOOL_DENYLIST` soundness loop are unchanged; the daemon
// runtime behavior is unaffected. @comis/core cannot import this (it would be
// a package cycle), so the cross-check lives in the architecture-suite arch-test.
// Consumer: test/architecture/comis-agent-same-gate.test.ts + comis-agent-no-admin.test.ts
export { DENYLISTED_RPC_METHODS } from "./wiring/setup-capability-endpoint.js";

// CAPABILITY_ACTION_CLASS (RE-PROVE seam) — the closed capability→action-class
// map (`read`|`mutate`) the durable audit trail's `classification` reads. Typed
// `Record<AgentCapability,…>`, so a new cap-union member is a compile-visible gap
// at its definition. Re-exported from the top-level barrel so the
// tool-invoke-cap-map arch-test PINS a cap's classification against the SAME
// runtime map the emitter uses (no drifting hand-copied literal). Pure additive
// `export` — the emitter behavior is unchanged. Consumer:
// test/architecture/tool-invoke-cap-map.test.ts
export { CAPABILITY_ACTION_CLASS } from "./api/shared/emit-capability-audit.js";
