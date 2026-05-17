// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon cross-session-subsystem wiring.
 *
 * Barrel re-export of the canonical public API. No aliases — every export
 * keeps its canonical name.
 *
 * Decomposition:
 *   - setup-cross-session-runtime.ts — setupCrossSession orchestrator + sendToChannel + announceToParent + crossSessionSender + announcement batcher + result condenser + sub-agent runner construction
 *   - setup-cross-session-graph.ts   — buildExecuteSubAgent + resolveGraphCacheRetention + SUB_AGENT_TOOL_DENYLIST + MIN_SUB_AGENT_STEPS
 *   - setup-cross-session-events.ts  — registerProxyTypingListeners (typing:proxy_start/stop + TTL sweep + shutdown)
 *
 * @module
 */

export type { CrossSessionResult } from "./setup-cross-session-runtime.js";
export { setupCrossSession } from "./setup-cross-session-runtime.js";
export {
  resolveGraphCacheRetention,
  MIN_SUB_AGENT_STEPS,
  SUB_AGENT_TOOL_DENYLIST,
} from "./setup-cross-session-graph.js";
