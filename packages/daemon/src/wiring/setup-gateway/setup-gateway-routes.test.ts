// SPDX-License-Identifier: Apache-2.0
/**
 * Routes leaf neighbor test for the setup-gateway/ split. The
 * `setupGateway` top-level orchestrator requires a full gateway-server
 * harness (real config + RPC dispatch + token store + executor pipeline)
 * to exercise end-to-end, so this neighbor test pins the symbol-export
 * shape and the deps/result interface key sets for compile-time
 * regression coverage. The end-to-end RPC bridge contract is tested in
 * the parity snapshot which the per-commit gate runs.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { setupGateway, type GatewayDeps, type GatewayResult } from "./setup-gateway-routes.js";

describe("setup-gateway-routes", () => {
  it("setupGateway: exported as a callable function", () => {
    expect(typeof setupGateway).toBe("function");
    expect(setupGateway.length).toBeGreaterThanOrEqual(1);
  });

  it("GatewayDeps witness pins the full dependency surface", () => {
    const witness: Record<keyof GatewayDeps, true> = {
      container: true,
      gwConfig: true,
      webhooksConfig: true,
      agents: true,
      defaultAgentId: true,
      configPaths: true,
      defaultConfigPaths: true,
      gatewayLogger: true,
      embeddingQueue: true,
      memoryAdapter: true,
      memoryApi: true,
      cachedPort: true,
      sessionStore: true,
      getExecutor: true,
      sessionResolver: true,
      assembleToolsForAgent: true,
      preprocessMessageText: true,
      rpcCall: true,
      costTrackers: true,
      workspaceDirs: true,
      _createGatewayServer: true,
      instanceId: true,
      startupStartMs: true,
      piSessionAdapters: true,
      resolvedTokens: true,
      suspendedAgents: true,
    };
    expect(Object.keys(witness).length).toBe(26);
  });

  it("GatewayResult witness pins the server-handle output keys", () => {
    const witness: Record<keyof GatewayResult, true> = {
      gatewayHandle: true,
      activeExecutions: true,
      getActiveConnectionCount: true,
      wsConnections: true,
    };
    expect(Object.keys(witness).length).toBe(4);
  });
});
