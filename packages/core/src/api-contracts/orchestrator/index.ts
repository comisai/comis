// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestrator contract aggregator.
 *
 * Re-aggregates 5 handler-family slices into ORCHESTRATOR_CONTRACTS. The
 * spread order is load-bearing for codegen byte-stability — `API_CONTRACTS_ORDERED`
 * is compared against a snapshot in `contract-codegen-drift.test.ts`.
 *
 * Family files (mirrors `packages/daemon/src/api/` factory file naming):
 *   - cron-handlers.ts        ( 8 methods — cron.* + scheduler.wake)
 *   - graph-handlers.ts       (12 methods — graph.*)
 *   - heartbeat-handlers.ts   ( 4 methods — heartbeat.*)
 *   - subagent-handlers.ts    ( 3 methods — subagent.*)
 *   - autonomy-handlers.ts    ( 3 methods — lease.revoke + run.kill +
 *                               autonomy.evict)
 *
 * Total: 30 contracts. The bidirectional 1:1 architecture test treats the
 * spread order as documentation only (unordered set).
 *
 * @module
 */
import { CRON_HANDLERS_CONTRACTS } from "./cron-handlers.js";
import { GRAPH_HANDLERS_CONTRACTS } from "./graph-handlers.js";
import { HEARTBEAT_HANDLERS_CONTRACTS } from "./heartbeat-handlers.js";
import { SUBAGENT_HANDLERS_CONTRACTS } from "./subagent-handlers.js";
import { AUTONOMY_HANDLERS_CONTRACTS } from "./autonomy-handlers.js";

// Each contract must remain individually exported (per-domain *.test.ts files
// import them by name); use `export *` to preserve the entire surface.
export * from "./cron-handlers.js";
export * from "./graph-handlers.js";
export * from "./heartbeat-handlers.js";
export * from "./subagent-handlers.js";
export * from "./autonomy-handlers.js";

export const ORCHESTRATOR_CONTRACTS = [
  ...CRON_HANDLERS_CONTRACTS,
  ...GRAPH_HANDLERS_CONTRACTS,
  ...HEARTBEAT_HANDLERS_CONTRACTS,
  ...SUBAGENT_HANDLERS_CONTRACTS,
  ...AUTONOMY_HANDLERS_CONTRACTS,
] as const;
