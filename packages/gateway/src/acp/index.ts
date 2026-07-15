// SPDX-License-Identifier: Apache-2.0
// ACP (Agent Client Protocol): client integration via ndJson/stdio
export { createAcpAgent, startAcpServer } from "./acp-server.js";
export type { AcpServerDeps, AcpAgentHandle } from "./acp-server.js";

export { createAcpSessionMap } from "./acp-session-map.js";
export type { AcpSessionMap, AcpSessionKey } from "./acp-session-map.js";

// Local 256-slot FIFO drop-oldest queue the activity bridge drains.
export { createAcpBoundedQueue, DEFAULT_ACP_QUEUE_CAPACITY } from "./acp-bounded-queue.js";
export type { AcpBoundedQueue, AcpBoundedQueueOptions } from "./acp-bounded-queue.js";

// The three ACP bridges the composition root constructs per ACP session
// (activity → session/update, SEP plan → plan panel, approval → requestPermission).
export { createAcpActivityBridge } from "./acp-activity-bridge.js";
export type {
  AcpActivityBridge,
  CreateAcpActivityBridgeDeps,
} from "./acp-activity-bridge.js";

export { createAcpPlanBridge } from "./acp-plan-bridge.js";
export type { CreateAcpPlanBridgeDeps } from "./acp-plan-bridge.js";

export { createAcpApprovalBridge } from "./acp-approval-bridge.js";
export type {
  AcpApprovalBridge,
  CreateAcpApprovalBridgeDeps,
} from "./acp-approval-bridge.js";
