// SPDX-License-Identifier: Apache-2.0
/**
 * RPC leaf tests for the deferred RPC bridge (`setupRpcBridge`) plus the
 * source guard that the execution-request log-field redaction helper is
 * still wired into the executeAgent adapter.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";

// Hoisted mocks for RPC bridge
const mockCreateRpcDispatch = vi.hoisted(() => vi.fn());
const mockClassifyRpcError = vi.hoisted(() => vi.fn(() => ({
  hint: "Check RPC target",
  errorKind: "internal" as const,
})));

vi.mock("../../api/rpc-dispatch.js", () => ({
  createRpcDispatch: mockCreateRpcDispatch,
  classifyRpcError: mockClassifyRpcError,
}));

describe("setupRpcBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupRpcBridge() {
    const mod = await import("./setup-gateway-rpc.js");
    return mod.setupRpcBridge;
  }

  // 30s timeout: the first dynamic `await import("./setup-gateway-rpc.js")`
  // in the test suite pays the full one-time cost of loading the SUT +
  // transitive deps (@comis/observability, @comis/core, @comis/agent,
  // @comis/skills, etc.) under vitest's transformer. Subsequent tests in
  // the file reuse the cached module so they run in ms. The 5s default
  // is too tight under parallel-test-pool load — 15s was still tail-end
  // flaky in the parallel pool, so this bumps to 30s for a comfortable
  // margin without slowing down isolated runs (which complete in 6-7s).
  it("returns rpcCall and wireDispatch functions", { timeout: 30000 }, async () => {
    const setupRpcBridge = await getSetupRpcBridge();
    const result = setupRpcBridge({ gatewayLogger: createMockLogger() as any });

    expect(typeof result.rpcCall).toBe("function");
    expect(typeof result.wireDispatch).toBe("function");
  });

  it("rpcCall delegates to inner dispatch after wireDispatch is called", async () => {
    const mockInner = vi.fn(async () => ({ success: true }));
    mockCreateRpcDispatch.mockReturnValue(mockInner);

    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall, wireDispatch } = setupRpcBridge({
      gatewayLogger: createMockLogger() as any,
    });

    wireDispatch({ some: "deps" } as any);

    const result = await rpcCall("test.method", { key: "value" });

    expect(mockCreateRpcDispatch).toHaveBeenCalledWith({ some: "deps" });
    expect(mockInner).toHaveBeenCalledWith("test.method", { key: "value" });
    expect(result).toEqual({ success: true });
  });

  it("rpcCall throws before wireDispatch is called (rpcCallInner is undefined)", async () => {
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall } = setupRpcBridge({
      gatewayLogger: createMockLogger() as any,
    });

    // rpcCallInner is undefined, calling it should throw
    await expect(rpcCall("test.method", {})).rejects.toThrow();
  });

  it("rpcCall wraps errors with classifyRpcError and logs via gatewayLogger.debug", async () => {
    const mockInner = vi.fn(async () => { throw new Error("Not found"); });
    mockCreateRpcDispatch.mockReturnValue(mockInner);
    mockClassifyRpcError.mockReturnValue({
      hint: "Check method name",
      errorKind: "validation",
    });

    const gatewayLogger = createMockLogger();
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall, wireDispatch } = setupRpcBridge({ gatewayLogger: gatewayLogger as any });

    wireDispatch({} as any);

    await expect(rpcCall("bad.method", { x: 1 })).rejects.toThrow("Not found");

    expect(mockClassifyRpcError).toHaveBeenCalledWith("Not found");
    expect(gatewayLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "bad.method",
        err: "Not found",
        hint: "Check method name",
        errorKind: "validation",
      }),
      "[rpcCall] failed",
    );
  });

  it("rpcCall handles non-Error thrown values", async () => {
    const mockInner = vi.fn(async () => { throw "string error"; });
    mockCreateRpcDispatch.mockReturnValue(mockInner);

    const gatewayLogger = createMockLogger();
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall, wireDispatch } = setupRpcBridge({ gatewayLogger: gatewayLogger as any });

    wireDispatch({} as any);

    await expect(rpcCall("test.method", {})).rejects.toBe("string error");

    expect(mockClassifyRpcError).toHaveBeenCalledWith("string error");
    expect(gatewayLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: "string error" }),
      "[rpcCall] failed",
    );
  });

  it("wireDispatch calls createRpcDispatch with provided deps", async () => {
    const dispatchDeps = {
      heartbeatRunner: { start: vi.fn() },
      rpcHandlers: new Map(),
    };

    mockCreateRpcDispatch.mockReturnValue(vi.fn(async () => ({})));

    const setupRpcBridge = await getSetupRpcBridge();
    const { wireDispatch } = setupRpcBridge({ gatewayLogger: createMockLogger() as any });

    wireDispatch(dispatchDeps as any);

    expect(mockCreateRpcDispatch).toHaveBeenCalledWith(dispatchDeps);
  });
});

describe("buildRpcAdapterDeps getConfig non-secret allowlist (WR-03)", () => {
  // Minimal container.config carrying an apiKey-shaped secret in the `agents`
  // section (the real leak: per-agent auth/model profiles) plus a non-secret
  // gateway section and the two scalar allowlist fields. Only the fields the
  // getConfig handler reads need to be real — the rest of AppConfig is absent.
  function makeContainerConfig() {
    return {
      tenantId: "tenant-a",
      logLevel: "info",
      gateway: {
        enabled: true,
        host: "127.0.0.1",
        port: 4766,
        // A secret adjacent to the allowlisted gateway projection — bearer
        // tokens live on the raw gateway object and must NEVER egress even
        // when `gateway` is allowlisted (the handler returns the projection).
        tokens: [{ token: "tok-GATEWAY-SECRET", scopes: ["admin"] }],
      },
      agents: {
        default: {
          name: "Comis",
          provider: "anthropic",
          model: "claude",
          // apiKey-shaped value reachable when the section is returned verbatim.
          modelFailover: { authProfiles: [{ keyName: "ANTHROPIC_API_KEY", provider: "anthropic" }] },
          apiKey: "sk-LEAK-TOKEN",
        },
      },
    };
  }

  async function makeGetConfig(config: ReturnType<typeof makeContainerConfig>) {
    const mod = await import("./setup-gateway-rpc.js");
    const container = {
      config,
      eventBus: { emit: vi.fn() },
    } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"];
    const deps = mod.buildRpcAdapterDeps({
      container,
      gwConfig: config.gateway as never,
      agents: config.agents as never,
      defaultAgentId: "default",
      gatewayLogger: createMockLogger() as never,
      memoryApi: {} as never,
      sessionStore: {} as never,
      getExecutor: (() => ({})) as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (t: string) => t) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map() as never,
      activeExecutions: new Map() as never,
    });
    return deps.getConfig;
  }

  it("does not egress apiKey-shaped values when getConfig requests the agents section", async () => {
    const getConfig = await makeGetConfig(makeContainerConfig());

    const res = await getConfig({ section: "agents" });
    const serialized = JSON.stringify(res);

    // RED on the verbatim passthrough: the `agents` section flows out wholesale.
    expect(serialized).not.toContain("sk-LEAK-TOKEN");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("apiKey");
    // The non-allowlisted section must not be echoed back as its own key.
    expect((res as Record<string, unknown>).agents).toBeUndefined();
  });

  it("does not return the security section verbatim when getConfig requests it", async () => {
    const config = makeContainerConfig() as Record<string, unknown>;
    // security.secrets is the encrypted-store config block; never egress it.
    config.security = { secrets: { masterKeyPath: "/etc/comis/master.key", password: "pw-LEAK" } };
    const getConfig = await makeGetConfig(config as ReturnType<typeof makeContainerConfig>);

    const res = await getConfig({ section: "security" });
    const serialized = JSON.stringify(res);

    expect(serialized).not.toContain("pw-LEAK");
    expect(serialized).not.toContain("master.key");
    expect((res as Record<string, unknown>).security).toBeUndefined();
  });

  it("still returns the allowlisted gateway section as a non-secret projection", async () => {
    const getConfig = await makeGetConfig(makeContainerConfig());

    const res = await getConfig({ section: "gateway" });
    const gateway = (res as { gateway?: Record<string, unknown> }).gateway;

    // Allowlisted section is returned (regression guard) but only as the
    // {enabled,host,port} projection — never the raw object with tokens.
    expect(gateway).toEqual({ enabled: true, host: "127.0.0.1", port: 4766 });
    expect(JSON.stringify(res)).not.toContain("tok-GATEWAY-SECRET");
  });

  it("returns the safe default object unchanged for the no-section request", async () => {
    const getConfig = await makeGetConfig(makeContainerConfig());

    const res = await getConfig({});

    expect(res).toEqual({
      tenantId: "tenant-a",
      logLevel: "info",
      gateway: { enabled: true, host: "127.0.0.1", port: 4766 },
    });
  });
});

describe("setup-gateway-rpc source guard", () => {
  it("wires buildExecutionRequestedLogFields into the executeAgent log call and removes the raw-message logger pattern", async () => {
    // The executeAgent adapter that consumes buildExecutionRequestedLogFields
    // lives in setup-gateway-rpc.ts (buildRpcAdapterDeps body).
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./setup-gateway-rpc.ts", import.meta.url).pathname,
      "utf-8",
    );
    // Forward proof: helper is wired in.
    expect(source).toContain("buildExecutionRequestedLogFields(");
    // Backward proof: offending raw-message log call is gone.
    expect(source).not.toContain("message: rawMsg.slice(");
    // Cleanup proof: dead field reference gone.
    expect(source).not.toContain("messageTruncated");
  });
});
