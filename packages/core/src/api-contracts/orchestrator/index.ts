// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestrator contract aggregator.
 *
 * Re-aggregates 5 handler-family slices into ORCHESTRATOR_CONTRACTS. The
 * spread order is load-bearing for codegen byte-stability — `API_CONTRACTS_ORDERED`
 * is compared against a snapshot in `contract-codegen-drift.test.ts`.
 *
 * Family files (mirrors `packages/daemon/src/api/` factory file naming):
 *   - cron-handlers.ts        ( 9 methods — cron.* + scheduler.wake)
 *   - graph-handlers.ts       (12 methods — graph.*)
 *   - heartbeat-handlers.ts   ( 4 methods — heartbeat.*)
 *   - subagent-handlers.ts    ( 7 methods — subagent.*)
 *   - autonomy-handlers.ts    ( 3 methods — lease.revoke + run.kill +
 *                               autonomy.evict)
 *   - replay-handlers.ts      ( 1 method  — orchestrate.replay)
 *
 *   - task-handlers.ts        ( 4 methods — tasks.status/list/cancel/reset)
 *
 * Total: 40 contracts. The bidirectional 1:1 architecture test treats the
 * spread order as documentation only (unordered set).
 *
 * @module
 */
import { CRON_HANDLERS_CONTRACTS } from "./cron-handlers.js";
import { GRAPH_HANDLERS_CONTRACTS } from "./graph-handlers.js";
import { HEARTBEAT_HANDLERS_CONTRACTS } from "./heartbeat-handlers.js";
import { SUBAGENT_HANDLERS_CONTRACTS } from "./subagent-handlers.js";
import { AUTONOMY_HANDLERS_CONTRACTS } from "./autonomy-handlers.js";
import { REPLAY_HANDLERS_CONTRACTS } from "./replay-handlers.js";
import { TASK_HANDLERS_CONTRACTS } from "./task-handlers.js";

// Each contract must remain individually exported (per-domain *.test.ts files
// import them by name); use `export *` to preserve the entire surface.
export * from "./cron-handlers.js";
export * from "./graph-handlers.js";
export * from "./heartbeat-handlers.js";
export {
  SubagentListContract,
  SubagentWaitContract,
  SubagentKillContract,
  SubagentSteerContract,
  SubagentPauseContract,
  SubagentResumeContract,
  SubagentStatusContract,
  SUBAGENT_HANDLERS_CONTRACTS,
} from "./subagent-handlers.js";
export * from "./autonomy-handlers.js";
export * from "./replay-handlers.js";
export {
  TasksStatusContract,
  TasksListContract,
  TasksCancelContract,
  TasksResetContract,
} from "./task-handlers.js";

export const ORCHESTRATOR_CONTRACTS = [
  ...CRON_HANDLERS_CONTRACTS,
  ...GRAPH_HANDLERS_CONTRACTS,
  ...HEARTBEAT_HANDLERS_CONTRACTS,
  ...SUBAGENT_HANDLERS_CONTRACTS,
  ...AUTONOMY_HANDLERS_CONTRACTS,
  ...REPLAY_HANDLERS_CONTRACTS,
  ...TASK_HANDLERS_CONTRACTS,
] as const;
