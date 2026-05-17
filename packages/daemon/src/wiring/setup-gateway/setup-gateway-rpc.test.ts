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

  it("returns rpcCall and wireDispatch functions", async () => {
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
