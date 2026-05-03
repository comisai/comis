// SPDX-License-Identifier: Apache-2.0
// @comis/daemon - production daemon entry point

// Daemon entry point and types for integration test harness
export { main } from "./daemon.js";
export type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";

// Sub-agent runner: spawn lifecycle, limits, disk sweep
export { createSubAgentRunner, ANNOUNCE_PARENT_TIMEOUT_MS } from "./sub-agent-runner.js";
export type { SubAgentRunnerDeps, SubAgentRun, SpawnParams, SubAgentRunnerLogger } from "./sub-agent-runner.js";

// Sub-agent result processor (extracted from sub-agent-runner)
export { sweepResultFiles, buildAnnouncementMessage, deliverFailureNotification } from "./sub-agent-result-processor.js";

// Announcement dead-letter queue
export { createAnnouncementDeadLetterQueue } from "./announcement-dead-letter.js";
export type { AnnouncementDeadLetterQueue, DeadLetterEntry } from "./announcement-dead-letter.js";

// Context handlers: DAG context engine RPC handlers
export { createContextHandlers } from "./rpc/context-handlers.js";
export type { ContextHandlerDeps } from "./rpc/context-handlers.js";

// Agent management RPC handlers (Phase 9 plan 09-07: re-exported so the
// multi-account integration test can drive the actual `agents.update` RPC
// handler against a shared `agents` map, mirroring the daemon-runtime
// container.config.agents pattern at daemon.ts:594/634).
export { createAgentHandlers } from "./rpc/agent-handlers.js";
export type { AgentHandlerDeps } from "./rpc/agent-handlers.js";
