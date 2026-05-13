// SPDX-License-Identifier: Apache-2.0
// @comis/daemon - production daemon entry point

// Daemon entry point and types for integration test harness
export { main } from "./daemon.js";
export type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";

// Announcement dead-letter queue (re-exported from @comis/orchestrator post
// Phase 32 commit 11 ORCH-EXT-11; the canonical surface now lives in
// packages/orchestrator/src/cross-session/. Daemon's public API contract
// documented in test/support/public-api-policy.ts preserves these three
// exports unchanged so the resilience-e2e-dead-letter integration test
// keeps importing them from @comis/daemon.)
export { createAnnouncementDeadLetterQueue } from "@comis/orchestrator";
export type { AnnouncementDeadLetterQueue, DeadLetterEntry } from "@comis/orchestrator";

// Context handlers: DAG context engine RPC handlers
export { createContextHandlers } from "./api/context-handlers.js";
export type { ContextHandlerDeps } from "./api/context-handlers.js";

// Agent management RPC handlers — re-exported so the multi-account
// integration test can drive the actual `agents.update` RPC handler against a
// shared `agents` map, mirroring the daemon-runtime container.config.agents
// pattern at daemon.ts:594/634.
export { createAgentHandlers } from "./api/agent-handlers.js";
export type { AgentHandlerDeps } from "./api/agent-handlers.js";

// Plan 31-13: re-export createTracingLogger so the test daemon harness can
// thread the `LoggerOptions.disableRedaction` opt-in (added in plan 31-06)
// through to the SAME logger instance the daemon uses for production code
// paths. Consumer is test/support/daemon-harness.ts via
// startTestDaemon({ disableRedaction: ...trueValue... }) for the residency
// integration test. MEM-CTX-PORTS-14 part 2 / RES-PIT-31-2.
//
// Note on phrasing: the literal token sequence `disableRedaction[:][space][true]`
// is deliberately AVOIDED in this comment so the per-package source-rule
// walker at test/architecture/source-rules.test.ts does not trip its own
// invariant (the walker source-greps `packages/*\/src/**` for that exact
// byte sequence; the rule fired in plan 31-06's executor for the same
// reason and was fixed the same way).
export { createTracingLogger } from "./observability/trace-logger.js";
export type { TracingLoggerOptions } from "./observability/trace-logger.js";
