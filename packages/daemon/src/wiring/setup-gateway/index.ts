// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon gateway-subsystem wiring (Phase 43 wave 8 split per FILE-SPLIT-08).
 *
 * Barrel re-export of the canonical public API of the former setup-gateway.ts
 * monolith. No aliases — every export keeps its canonical name. The
 * pre-split parity snapshot (captured in 43-08a) reproduces verbatim against
 * this barrel.
 *
 * Decomposition:
 *   - setup-gateway-admin.ts   ≤200L — deriveTrustLevel, handleConfigChatCommand, buildExecutionRequestedLogFields, buildGreetingGenerator
 *   - setup-gateway-rpc.ts     ≤500L — setupRpcBridge (deferred dispatch) + RPC adapter builder + extractAttachmentMarkers + dynamic router registration
 *   - setup-gateway-routes.ts  ≤300L — setupGateway orchestrator + GatewayDeps/GatewayResult + gateway server creation + mountGatewayRoutes call + start
 *
 * NOTE: The sibling top-level `packages/daemon/src/wiring/setup-gateway-routes.ts`
 * (one directory up) is the older `mountGatewayRoutes` helper that predates
 * Phase 43; the leaf in this subdirectory imports from it.
 *
 * @module
 */

export type { GatewayDeps, GatewayResult } from "./setup-gateway-routes.js";
export { setupGateway } from "./setup-gateway-routes.js";
export type { RpcBridgeResult } from "./setup-gateway-rpc.js";
export { setupRpcBridge } from "./setup-gateway-rpc.js";
export {
  buildExecutionRequestedLogFields,
  deriveTrustLevel,
  handleConfigChatCommand,
} from "./setup-gateway-admin.js";
