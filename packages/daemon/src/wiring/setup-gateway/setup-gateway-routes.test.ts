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

import { describe, it, expect, vi } from "vitest";

// Mock the heavy collaborators so `setupGateway` reaches its `mountGatewayRoutes`
// call without a full gateway-server harness. `mountGatewayRoutes` is a spy, so
// the forwarding test asserts the wrapper THREADS `googlechatIngress` into it
// (the new hop); the real mount behavior is covered by the sibling
// `../setup-gateway-routes.test.ts`.
vi.mock("../setup-gateway-routes.js", () => ({ mountGatewayRoutes: vi.fn() }));
vi.mock("@comis/gateway", () => ({
  createTokenStore: vi.fn(() => ({})),
  WsConnectionManager: vi.fn(),
  createGatewayServer: vi.fn(),
}));
vi.mock("./setup-gateway-admin.js", () => ({ buildGreetingGenerator: vi.fn(() => ({})) }));
vi.mock("./setup-gateway-rpc.js", () => ({
  buildRpcAdapterDeps: vi.fn(() => ({})),
  buildDynamicRouterAndRegister: vi.fn(() => ({ server: {} })),
}));
vi.mock("../../api/mcp-server-handlers.js", () => ({ buildMcpServerForClient: vi.fn() }));

import { setupGateway, type GatewayDeps, type GatewayResult } from "./setup-gateway-routes.js";
import { mountGatewayRoutes } from "../setup-gateway-routes.js";

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
    expect(Object.keys(witness).length).toBe(25);
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

  it("threads googlechatIngress from setupGateway into mountGatewayRoutes", async () => {
    const googlechatIngress = { __googlechatIngress: true };
    const gatewayHandle = {
      app: { route: vi.fn(), use: vi.fn() },
      start: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = {
      container: { config: {}, eventBus: {} },
      gwConfig: { enabled: true, web: { enabled: false }, host: "127.0.0.1", port: 0 },
      webhooksConfig: undefined,
      agents: {},
      defaultAgentId: "default",
      configPaths: [],
      defaultConfigPaths: [],
      gatewayLogger: logger,
      memoryAdapter: {},
      memoryApi: {},
      cachedPort: {},
      sessionStore: {},
      getExecutor: vi.fn(),
      assembleToolsForAgent: vi.fn(),
      preprocessMessageText: vi.fn(),
      rpcCall: vi.fn(),
      costTrackers: new Map(),
      workspaceDirs: new Map(),
      _createGatewayServer: vi.fn(() => gatewayHandle),
      instanceId: "test-instance",
      startupStartMs: Date.now(),
      resolvedTokens: [],
      daemonVersion: "0.0.0-test",
      googlechatIngress,
    } as unknown as GatewayDeps;

    await setupGateway(deps);

    // The wrapper must pass the threaded ingress straight through to the mount
    // impl; without the pass-through the value never reaches app.route.
    expect(mountGatewayRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ googlechatIngress }),
    );
  });
});
