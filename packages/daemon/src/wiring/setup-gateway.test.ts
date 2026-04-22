// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { deriveTrustLevel, handleConfigChatCommand } from "./setup-gateway.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ===========================================================================
// Gateway tests
// ===========================================================================

describe("deriveTrustLevel", () => {
  it('returns "admin" for admin scope', () => {
    expect(deriveTrustLevel(["rpc", "admin"])).toBe("admin");
  });

  it('returns "admin" for wildcard scope', () => {
    expect(deriveTrustLevel(["*"])).toBe("admin");
  });

  it('returns "admin" when admin is the only scope', () => {
    expect(deriveTrustLevel(["admin"])).toBe("admin");
  });

  it('returns "user" for non-admin scopes (fail-closed)', () => {
    expect(deriveTrustLevel(["rpc", "ws"])).toBe("user");
  });

  it('returns "user" for empty scopes', () => {
    expect(deriveTrustLevel([])).toBe("user");
  });

  it('returns "user" for undefined scopes', () => {
    expect(deriveTrustLevel(undefined)).toBe("user");
  });
});

describe("handleConfigChatCommand scope enforcement", () => {
  it("rejects /config show with non-admin scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["show"], rpcCall, ["rpc"]);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rejects /config show with empty scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["show"], rpcCall, []);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rejects /config show with undefined scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["show"], rpcCall, undefined);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rejects /config history with non-admin scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["history"], rpcCall, ["rpc"]);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("allows /config show with admin scope", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ config: {}, sections: [] });
    const result = await handleConfigChatCommand(["show"], rpcCall, ["admin"]);
    expect(result.handled).toBe(true);
    expect(rpcCall).toHaveBeenCalledWith("config.read", { section: undefined });
  });

  it("allows /config show with wildcard scope", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ config: {}, sections: [] });
    const result = await handleConfigChatCommand(["show"], rpcCall, ["*"]);
    expect(result.handled).toBe(true);
    expect(rpcCall).toHaveBeenCalled();
  });

  it("allows /config history with admin scope", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ entries: [] });
    const result = await handleConfigChatCommand(["history"], rpcCall, ["admin"]);
    expect(result.handled).toBe(true);
    expect(rpcCall).toHaveBeenCalledWith("config.history", { limit: 5 });
  });

  it("does not gate /config set (has its own check)", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["set"], rpcCall, ["rpc"]);
    expect(result.handled).toBe(true);
    // set with rpc scope should hit the existing set trust gate, NOT the new show/history gate
    expect(result.response).toContain("admin trust");
  });
});

// ===========================================================================
// Gateway destroySession session:expired emission (source verification)
// ===========================================================================

describe("setupGateway destroySession emits session:expired", () => {
  it("source contains session:expired emission with gateway-reset reason", async () => {
    // The gateway destroySession callback is deeply nested inside setupGateway
    // and requires a full gateway server harness to exercise end-to-end.
    // This structural test verifies the source code contains the expected
    // session:expired emission so regressions are caught.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./setup-gateway.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(source).toContain('container.eventBus.emit("session:expired"');
    expect(source).toContain('"gateway-reset"');
  });
});

// ===========================================================================
// RPC Bridge tests
// ===========================================================================

// Hoisted mocks for RPC bridge
const mockCreateRpcDispatch = vi.hoisted(() => vi.fn());
const mockClassifyRpcError = vi.hoisted(() => vi.fn(() => ({
  hint: "Check RPC target",
  errorKind: "internal" as const,
})));

vi.mock("../rpc/rpc-dispatch.js", () => ({
  createRpcDispatch: mockCreateRpcDispatch,
  classifyRpcError: mockClassifyRpcError,
}));


describe("setupRpcBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupRpcBridge() {
    const mod = await import("./setup-gateway.js");
    return mod.setupRpcBridge;
  }

  // -------------------------------------------------------------------------
  // 1. Returns rpcCall and wireDispatch
  // -------------------------------------------------------------------------

  it("returns rpcCall and wireDispatch functions", async () => {
    const setupRpcBridge = await getSetupRpcBridge();
    const result = setupRpcBridge({ gatewayLogger: createMockLogger() as any });

    expect(typeof result.rpcCall).toBe("function");
    expect(typeof result.wireDispatch).toBe("function");
  });

  // -------------------------------------------------------------------------
  // 2. rpcCall delegates to inner dispatch after wireDispatch
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 3. rpcCall throws before wireDispatch is called
  // -------------------------------------------------------------------------

  it("rpcCall throws before wireDispatch is called (rpcCallInner is undefined)", async () => {
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall } = setupRpcBridge({
      gatewayLogger: createMockLogger() as any,
    });

    // rpcCallInner is undefined, calling it should throw
    await expect(rpcCall("test.method", {})).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // 4. rpcCall wraps errors with classifyRpcError and logs
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 5. rpcCall handles non-Error thrown values
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 6. wireDispatch calls createRpcDispatch with provided deps
  // -------------------------------------------------------------------------

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
