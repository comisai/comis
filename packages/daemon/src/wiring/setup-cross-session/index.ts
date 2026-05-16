// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon cross-session-subsystem wiring (Phase 43 wave 8 split per FILE-SPLIT-08).
 *
 * Barrel re-export of the canonical public API of the former
 * setup-cross-session.ts monolith. No aliases — every export keeps its
 * canonical name. The pre-split parity snapshot (captured in 43-08a)
 * reproduces verbatim against this barrel.
 *
 * Decomposition:
 *   - setup-cross-session-runtime.ts  ≤450L — setupCrossSession orchestrator + sendToChannel + announceToParent + crossSessionSender + announcement batcher + result condenser + sub-agent runner construction
 *   - setup-cross-session-graph.ts    ≤500L — buildExecuteSubAgent + resolveGraphCacheRetention + SUB_AGENT_TOOL_DENYLIST + MIN_SUB_AGENT_STEPS
 *   - setup-cross-session-events.ts   ≤200L — registerProxyTypingListeners (typing:proxy_start/stop + TTL sweep + shutdown)
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
