// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "typebox/value";
import {
  createProvidersManageTool,
  ProvidersManageToolParams,
} from "./providers-manage-tool.js";
import { runWithContext } from "@comis/core";
import type { RequestContext, ApprovalGate } from "@comis/core";

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
    channelType: "telegram",
  };
}

function createMockApprovalGate(): ApprovalGate {
  return {
    requestApproval: vi.fn(),
    resolveApproval: vi.fn(),
    pending: vi.fn(() => []),
    getRequest: vi.fn(),
    dispose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("providers_manage tool", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;
  let mockApprovalGate: ApprovalGate;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
    mockApprovalGate = createMockApprovalGate();
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  describe("metadata", () => {
    it("has correct name and label", () => {
      const tool = createProvidersManageTool(mockRpcCall);
      expect(tool.name).toBe("providers_manage");
      expect(tool.label).toBe("Provider Management");
    });
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is guest", async () => {
      const tool = createProvidersManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is user", async () => {
      const tool = createProvidersManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createProvidersManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "list" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Action delegation
  // -----------------------------------------------------------------------

  describe("action delegation", () => {
    it("list action delegates to providers.list RPC", async () => {
      mockRpcCall.mockResolvedValue({ providers: [] });
      const tool = createProvidersManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-list", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.list", {
        _trustLevel: "admin",
      });
    });

    it("get action delegates to providers.get RPC with providerId", async () => {
      mockRpcCall.mockResolvedValue({ provider: {} });
      const tool = createProvidersManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-get", { action: "get", provider_id: "my-ollama" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.get", {
        providerId: "my-ollama",
        _trustLevel: "admin",
      });
    });

    it("create action delegates to providers.create RPC with providerId and config", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ created: true });

      const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate);
      const config = { type: "openai", name: "My OpenAI", baseUrl: "https://api.openai.com/v1" };

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-create", {
          action: "create",
          provider_id: "my-openai",
          config,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.create", {
        providerId: "my-openai",
        config,
        _trustLevel: "admin",
      });
    });

    it("update action delegates to providers.update RPC with providerId and config", async () => {
      mockRpcCall.mockResolvedValue({ updated: true });
      const tool = createProvidersManageTool(mockRpcCall);
      const config = { name: "Updated Name" };

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-update", {
          action: "update",
          provider_id: "my-ollama",
          config,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.update", {
        providerId: "my-ollama",
        config,
        _trustLevel: "admin",
      });
    });

    it("delete action delegates to providers.delete RPC with providerId", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ deleted: true });
      const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-delete", {
          action: "delete",
          provider_id: "my-ollama",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.delete", {
        providerId: "my-ollama",
        _trustLevel: "admin",
      });
    });

    it("enable action delegates to providers.enable RPC with providerId", async () => {
      mockRpcCall.mockResolvedValue({ enabled: true });
      const tool = createProvidersManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-enable", {
          action: "enable",
          provider_id: "my-ollama",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.enable", {
        providerId: "my-ollama",
        _trustLevel: "admin",
      });
    });

    it("disable action delegates to providers.disable RPC with providerId", async () => {
      mockRpcCall.mockResolvedValue({ disabled: true });
      const tool = createProvidersManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-disable", {
          action: "disable",
          provider_id: "my-ollama",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.disable", {
        providerId: "my-ollama",
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Approval gate
  // -----------------------------------------------------------------------

  describe("approval gate", () => {
    it("approval gate is called for create action", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ created: true });

      const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-gate-create", {
          action: "create",
          provider_id: "new-provider",
          config: { type: "openai" },
        } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "providers_manage",
          action: "providers.create",
          channelType: "telegram",
        }),
      );
    });

    it("approval gate is called for delete action", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ deleted: true });

      const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-gate-delete", {
          action: "delete",
          provider_id: "old-provider",
        } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "providers_manage",
          action: "providers.delete",
          channelType: "telegram",
        }),
      );
    });

    it("throws denial error when approval gate denies create", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "test denied",
      });

      const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-gate-deny", {
            action: "create",
            provider_id: "new-provider",
          } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("approval gate is NOT called for list, get, update, enable, disable", async () => {
      const nonGatedActions = [
        { action: "list", params: {} },
        { action: "get", params: { provider_id: "my-ollama" } },
        { action: "update", params: { provider_id: "my-ollama", config: { name: "X" } } },
        { action: "enable", params: { provider_id: "my-ollama" } },
        { action: "disable", params: { provider_id: "my-ollama" } },
      ] as const;

      for (const { action, params } of nonGatedActions) {
        // Reset mock per iteration
        (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockClear();
        mockRpcCall.mockResolvedValue({ ok: true });

        const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate);

        await runWithContext(makeContext("admin"), () =>
          tool.execute(`call-nogate-${action}`, { action, ...params } as never),
        );

        expect(
          mockApprovalGate.requestApproval,
          `${action} should NOT trigger approval gate`,
        ).not.toHaveBeenCalled();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Config coercion
  // -----------------------------------------------------------------------

  describe("config coercion", () => {
    it("coerces JSON string config to object", async () => {
      mockRpcCall.mockResolvedValue({ updated: true });
      const tool = createProvidersManageTool(mockRpcCall);
      const configStr = JSON.stringify({ type: "openai", name: "From String" });

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-coerce", {
          action: "update",
          provider_id: "my-provider",
          config: configStr,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.update", {
        providerId: "my-provider",
        config: { type: "openai", name: "From String" },
        _trustLevel: "admin",
      });
    });

    it("passes object config through unchanged", async () => {
      mockRpcCall.mockResolvedValue({ updated: true });
      const tool = createProvidersManageTool(mockRpcCall);
      const configObj = { type: "ollama", baseUrl: "http://localhost:11434" };

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-obj", {
          action: "update",
          provider_id: "local",
          config: configObj,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("providers.update", {
        providerId: "local",
        config: configObj,
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("rejects invalid action", async () => {
      const tool = createProvidersManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-invalid", { action: "restart" } as never),
        ),
      ).rejects.toThrow(/invalid_action|Invalid value|restart/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("propagates RPC errors", async () => {
      mockRpcCall.mockRejectedValue(new Error("RPC connection failed"));
      const tool = createProvidersManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-rpc-err", {
            action: "get",
            provider_id: "nonexistent",
          } as never),
        ),
      ).rejects.toThrow(/RPC connection failed/);
    });
  });

  // -----------------------------------------------------------------------
  // Mutation callbacks
  // -----------------------------------------------------------------------

  describe("mutation callbacks", () => {
    it("calls onMutationStart and onMutationEnd for create", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ created: true });

      const onMutationStart = vi.fn();
      const onMutationEnd = vi.fn();
      const tool = createProvidersManageTool(mockRpcCall, mockApprovalGate, {
        onMutationStart,
        onMutationEnd,
      });

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-mut-create", {
          action: "create",
          provider_id: "new-p",
          config: { type: "openai" },
        } as never),
      );

      expect(onMutationStart).toHaveBeenCalledTimes(1);
      expect(onMutationEnd).toHaveBeenCalledTimes(1);
    });

    it("calls onMutationEnd even when RPC fails (try/finally)", async () => {
      mockRpcCall.mockRejectedValue(new Error("rpc failure"));
      const onMutationStart = vi.fn();
      const onMutationEnd = vi.fn();
      const tool = createProvidersManageTool(mockRpcCall, undefined, {
        onMutationStart,
        onMutationEnd,
      });

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-mut-fail", {
            action: "update",
            provider_id: "my-p",
            config: { name: "fail" },
          } as never),
        ),
      ).rejects.toThrow(/rpc failure/);

      expect(onMutationStart).toHaveBeenCalledTimes(1);
      expect(onMutationEnd).toHaveBeenCalledTimes(1);
    });

    it("calls mutation callbacks for enable and disable actions", async () => {
      mockRpcCall.mockResolvedValue({ ok: true });
      const onMutationStart = vi.fn();
      const onMutationEnd = vi.fn();
      const tool = createProvidersManageTool(mockRpcCall, undefined, {
        onMutationStart,
        onMutationEnd,
      });

      for (const action of ["enable", "disable"] as const) {
        onMutationStart.mockClear();
        onMutationEnd.mockClear();

        await runWithContext(makeContext("admin"), () =>
          tool.execute(`call-mut-${action}`, {
            action,
            provider_id: "my-p",
          } as never),
        );

        expect(onMutationStart, `${action}: onMutationStart`).toHaveBeenCalledTimes(1);
        expect(onMutationEnd, `${action}: onMutationEnd`).toHaveBeenCalledTimes(1);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Schema validation
  // -----------------------------------------------------------------------

  describe("schema validation", () => {
    it("validates a complete provider config against TypeBox schema", () => {
      const valid = Value.Check(ProvidersManageToolParams, {
        action: "create",
        provider_id: "nvidia",
        config: {
          type: "openai",
          name: "NVIDIA NIM",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKeyName: "NVIDIA_API_KEY",
          enabled: true,
          timeoutMs: 30000,
          maxRetries: 3,
          headers: { "X-Custom": "value" },
          models: [
            {
              id: "meta/llama-3.1-405b-instruct",
              name: "Llama 3.1 405B",
              reasoning: false,
              contextWindow: 131072,
              maxTokens: 4096,
              input: ["text"],
            },
          ],
        },
      });
      expect(valid).toBe(true);
    });

    it("validates JSON string config variant", () => {
      const valid = Value.Check(ProvidersManageToolParams, {
        action: "update",
        provider_id: "my-p",
        config: '{"type":"openai","name":"Test"}',
      });
      expect(valid).toBe(true);
    });

    it("validates list action without provider_id", () => {
      const valid = Value.Check(ProvidersManageToolParams, {
        action: "list",
      });
      expect(valid).toBe(true);
    });
  });
});
