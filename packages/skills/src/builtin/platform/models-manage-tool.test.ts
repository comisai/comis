// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createModelsManageTool } from "./models-manage-tool.js";
import { runWithContext } from "@comis/core";
import type { RequestContext } from "@comis/core";

// Mock @comis/core: preserve real implementations, override safePath
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: (base: string, ...segments: string[]) => base + "/" + segments.join("/"),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function makeContext(trustLevel: "admin" | "user" | "guest"): RequestContext {
  return {
    tenantId: "default",
    userId: "test-user",
    sessionKey: "test-session",
    traceId: crypto.randomUUID(),
    startedAt: Date.now(),
    trustLevel,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("models_manage tool", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it("has correct name and label", () => {
    const tool = createModelsManageTool(mockRpcCall);
    expect(tool.name).toBe("models_manage");
    expect(tool.label).toBe("Model Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createModelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createModelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createModelsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "list" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // list action
  // -----------------------------------------------------------------------

  describe("list action", () => {
    it("unfiltered list summarizes to provider directory for the LLM", async () => {
      mockRpcCall.mockResolvedValue({
        providers: [
          { name: "anthropic", modelCount: 2, models: [
            { modelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", contextWindow: 200000, maxTokens: 8192 },
            { modelId: "claude-haiku-3-5", displayName: "Claude Haiku 3.5", contextWindow: 200000, maxTokens: 4096 },
          ] },
          { name: "openai", modelCount: 1, models: [
            { modelId: "gpt-4o", displayName: "GPT-4o", contextWindow: 128000, maxTokens: 16384 },
          ] },
        ],
        totalModels: 3,
      });

      const tool = createModelsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l1", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("models.list", { provider: undefined, _trustLevel: "admin" });

      // Should return provider directory only — no per-model details
      expect(result.details).toEqual({
        providers: [
          { name: "anthropic", modelCount: 2 },
          { name: "openai", modelCount: 1 },
        ],
        totalModels: 3,
        hint: "Use provider filter for full model details: models_manage list provider=<name>",
      });
    });

    it("filtered list passes full RPC result through", async () => {
      const rpcResult = {
        models: [{ provider: "anthropic", modelId: "claude-sonnet-4-5" }],
        total: 1,
      };
      mockRpcCall.mockResolvedValue(rpcResult);

      const tool = createModelsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l2", { action: "list", provider: "anthropic" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("models.list", { provider: "anthropic", _trustLevel: "admin" });
      expect(result.details).toEqual(rpcResult);
    });
  });

  // -----------------------------------------------------------------------
  // test action
  // -----------------------------------------------------------------------

  describe("test action", () => {
    it("delegates to models.test with provider", async () => {
      mockRpcCall.mockResolvedValue({ provider: "anthropic", status: "available", modelsAvailable: 1 });

      const tool = createModelsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-t1", { action: "test", provider: "anthropic" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("models.test", { provider: "anthropic", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ provider: "anthropic", status: "available" }),
      );
    });

    it("throws when provider parameter missing", async () => {
      const tool = createModelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-t2", { action: "test" } as never),
        ),
      ).rejects.toThrow(/provider/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createModelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-u1", { action: "unknown_action" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Model service unavailable"));

      const tool = createModelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err1", { action: "list" } as never),
        ),
      ).rejects.toThrow("Model service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createModelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err2", { action: "list" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });
});
