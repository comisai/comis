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

// Context handlers: DAG context engine RPC handlers
// Consumer: test/integration/context-dag-integration.test.ts:52-53
export { createContextHandlers } from "./api/context-handlers.js";
export type { ContextHandlerDeps } from "./api/context-handlers.js";

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
// Re-exported so the architecture-tier negative +
// positive control table at
// test/architecture/mcp-plaintext-secret-false-positives.test.ts can pin
// the heuristic shape against real-world token samples WITHOUT
// duplicating the prefix list / length-floor / entropy-floor constants.
// Consumer:
// test/architecture/mcp-plaintext-secret-false-positives.test.ts (static
// import via @comis/daemon, alongside the daemon-side mcp.connect
// integration tests in packages/daemon/src/api/mcp-handlers.test.ts).
export { looksLikePlaintextSecret } from "./api/mcp-handlers.js";
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
export { setupSkillBundles, buildSkillRegistriesForBundles } from "./wiring/setup-skill-bundles.js";
export type { SetupSkillBundlesDeps } from "./wiring/setup-skill-bundles.js";

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
