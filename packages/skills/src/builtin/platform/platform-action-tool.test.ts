// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { Type } from "typebox";
import { createPlatformActionTool, type PlatformActionDescriptor } from "./platform-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

/**
 * Minimal test schema matching the platform action tool pattern.
 */
const TestParams = Type.Object({
  action: Type.Union([
    Type.Literal("read"),
    Type.Literal("delete"),
    Type.Literal("update"),
  ]),
  id: Type.Optional(Type.String()),
  _confirmed: Type.Optional(Type.Boolean()),
});

/**
 * Create a base descriptor for testing.
 */
function baseDescriptor(overrides?: Partial<PlatformActionDescriptor>): PlatformActionDescriptor {
  return {
    name: "test_action",
    label: "Test Actions",
    description: "Test platform actions",
    parameters: TestParams,
    rpcMethod: "test.action",
    gatedActions: [
      { action: "delete", gateKey: "test.delete", hint: "Confirm deletion." },
    ],
    ...overrides,
  };
}

describe("createPlatformActionTool", () => {
  it("produces a tool with correct name, label, description, and parameters from descriptor", () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));
    const descriptor = baseDescriptor();
    const tool = createPlatformActionTool(descriptor, mockRpcCall);

    expect(tool.name).toBe("test_action");
    expect(tool.label).toBe("Test Actions");
    expect(tool.description).toBe("Test platform actions");
    expect(tool.parameters).toBe(TestParams); // same reference, not cloned
  });

  it("gated action returns requiresConfirmation when gate triggers", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));
    const tool = createPlatformActionTool(baseDescriptor(), mockRpcCall);

    const result = await tool.execute("call-1", {
      action: "delete",
      id: "item-42",
    });

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string; hint: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("test.delete");
    expect(parsed.hint).toBe("Confirm deletion.");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("gated action bypasses gate when _confirmed is true", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ deleted: true }));
    const tool = createPlatformActionTool(baseDescriptor(), mockRpcCall);

    const result = await tool.execute("call-2", {
      action: "delete",
      id: "item-42",
      _confirmed: true,
    });

    const parsed = parseResult(result) as { deleted: boolean };
    expect(parsed.deleted).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("test.action", {
      action: "delete",
      id: "item-42",
      _confirmed: true,
    });
  });

  it("non-gated action delegates to rpcCall with correct method and params", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ data: "test-result" }));
    const tool = createPlatformActionTool(baseDescriptor(), mockRpcCall);

    const result = await tool.execute("call-3", {
      action: "read",
      id: "item-7",
    });

    const parsed = parseResult(result) as { data: string };
    expect(parsed.data).toBe("test-result");
    expect(mockRpcCall).toHaveBeenCalledWith("test.action", {
      action: "read",
      id: "item-7",
    });
  });

  it("calls logger.debug before and after RPC when logger is provided", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
    };
    const descriptor = baseDescriptor({ logger: mockLogger });
    const tool = createPlatformActionTool(descriptor, mockRpcCall);

    await tool.execute("call-4", { action: "read", id: "item-1" });

    expect(mockLogger.debug).toHaveBeenCalledTimes(2);
    // First call: before RPC
    expect(mockLogger.debug).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toolName: "test_action", action: "read" }),
      expect.stringContaining("action requested"),
    );
    // Second call: after RPC
    expect(mockLogger.debug).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toolName: "test_action", action: "read" }),
      expect.stringContaining("action completed"),
    );
  });

  it("does not call logger when not provided in descriptor", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));
    const tool = createPlatformActionTool(baseDescriptor(), mockRpcCall);

    // Should not throw even without logger
    const result = await tool.execute("call-5", { action: "read" });
    const parsed = parseResult(result) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("re-throws errors from rpcCall preserving structured error format", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("[invalid_action] Unknown action: nope");
    });
    const tool = createPlatformActionTool(baseDescriptor(), mockRpcCall);

    await expect(
      tool.execute("call-6", { action: "read" }),
    ).rejects.toThrow("[invalid_action] Unknown action: nope");
  });

  it("wraps non-Error throws into Error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw "raw string error";
    });
    const tool = createPlatformActionTool(baseDescriptor(), mockRpcCall);

    await expect(
      tool.execute("call-7", { action: "read" }),
    ).rejects.toThrow("raw string error");
  });

  it("supports multiple gated actions in a single descriptor", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));
    const descriptor = baseDescriptor({
      gatedActions: [
        { action: "delete", gateKey: "test.delete", hint: "Confirm delete." },
        { action: "update", gateKey: "test.update", hint: "Confirm update." },
      ],
    });
    const tool = createPlatformActionTool(descriptor, mockRpcCall);

    // "delete" should be gated
    const deleteResult = await tool.execute("call-8a", { action: "delete" });
    const deleteParsed = parseResult(deleteResult) as { requiresConfirmation: boolean; actionType: string };
    expect(deleteParsed.requiresConfirmation).toBe(true);
    expect(deleteParsed.actionType).toBe("test.delete");

    // "update" should also be gated
    const updateResult = await tool.execute("call-8b", { action: "update" });
    const updateParsed = parseResult(updateResult) as { requiresConfirmation: boolean; actionType: string };
    expect(updateParsed.requiresConfirmation).toBe(true);
    expect(updateParsed.actionType).toBe("test.update");

    expect(mockRpcCall).not.toHaveBeenCalled();
  });
});
