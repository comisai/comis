// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAdminManageTool } from "./admin-manage-factory.js";
import { Type } from "typebox";
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

const TestParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("create"),
    Type.Literal("delete"),
  ]),
  name: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAdminManageTool factory", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it("produces a tool with correct name, label, and description from descriptor", () => {
    const tool = createAdminManageTool(
      {
        name: "test_manage",
        label: "Test Management",
        description: "Test tool description.",
        parameters: TestParams,
        validActions: ["list", "create", "delete"],
        rpcPrefix: "test",
      },
      mockRpcCall,
    );

    expect(tool.name).toBe("test_manage");
    expect(tool.label).toBe("Test Management");
    expect(tool.description).toBe("Test tool description.");
  });

  // -----------------------------------------------------------------------
  // Trust guard enforcement
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws for non-admin callers when requiresTrust is true (default)", async () => {
      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
      );

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
      );

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-2", { action: "list" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });

    it("skips trust guard when requiresTrust is false", async () => {
      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
          requiresTrust: false,
        },
        mockRpcCall,
      );

      const result = await runWithContext(makeContext("guest"), () =>
        tool.execute("call-3", { action: "list" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Action validation
  // -----------------------------------------------------------------------

  describe("action validation", () => {
    it("throws [invalid_value] for invalid action", async () => {
      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
      );

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-inv", { action: "bogus" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Approval gate
  // -----------------------------------------------------------------------

  describe("approval gate", () => {
    it("triggers approval gate for gated actions", async () => {
      const gate = createMockApprovalGate();
      (gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ created: true });

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
          gatedActions: ["create", "delete"],
        },
        mockRpcCall,
        gate,
      );

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-g1", { action: "create", name: "new-item" } as never),
      );

      expect(gate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "test_manage",
          action: "test.create",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalled();
    });

    it("throws when approval gate denies", async () => {
      const gate = createMockApprovalGate();
      (gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "denied by policy",
      });

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
          gatedActions: ["create", "delete"],
        },
        mockRpcCall,
        gate,
      );

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-g2", { action: "create" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("does not trigger approval gate for non-gated actions", async () => {
      const gate = createMockApprovalGate();
      mockRpcCall.mockResolvedValue({ items: [] });

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
          gatedActions: ["create", "delete"],
        },
        mockRpcCall,
        gate,
      );

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-g3", { action: "list" } as never),
      );

      expect(gate.requestApproval).not.toHaveBeenCalled();
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Action overrides
  // -----------------------------------------------------------------------

  describe("actionOverrides", () => {
    it("calls override when present and returns its result", async () => {
      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
          actionOverrides: {
            async list(_p, _rpcCall, ctx) {
              return { custom: true, trustLevel: ctx.trustLevel };
            },
          },
        },
        mockRpcCall,
      );

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-o1", { action: "list" } as never),
      );

      expect(result.details).toEqual({ custom: true, trustLevel: "admin" });
      // Default rpcCall should NOT have been called since override handled it
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("falls through to default dispatch when override returns undefined", async () => {
      mockRpcCall.mockResolvedValue({ items: [] });

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
          actionOverrides: {
            async list() {
              return undefined;
            },
          },
        },
        mockRpcCall,
      );

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-o2", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("test.list", expect.objectContaining({ _trustLevel: "admin" }));
      expect(result.details).toEqual({ items: [] });
    });
  });

  // -----------------------------------------------------------------------
  // Default RPC dispatch
  // -----------------------------------------------------------------------

  describe("default RPC dispatch", () => {
    it("calls rpcCall with prefix.action and params including _trustLevel", async () => {
      mockRpcCall.mockResolvedValue({ items: [] });

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
      );

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d1", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("test.list", expect.objectContaining({ _trustLevel: "admin" }));
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws structured tool errors (starting with [)", async () => {
      mockRpcCall.mockRejectedValue(new Error("[invalid_value] Bad input"));

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
      );

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "list" } as never),
        ),
      ).rejects.toThrow("[invalid_value] Bad input");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
      );

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e2", { action: "list" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });

  // -----------------------------------------------------------------------
  // Mutation callbacks
  // -----------------------------------------------------------------------

  describe("mutation callbacks", () => {
    it("calls onMutationStart/End around default dispatch", async () => {
      mockRpcCall.mockResolvedValue({ created: true });
      const onMutationStart = vi.fn();
      const onMutationEnd = vi.fn();

      const tool = createAdminManageTool(
        {
          name: "test_manage",
          label: "Test",
          description: "Test",
          parameters: TestParams,
          validActions: ["list", "create", "delete"],
          rpcPrefix: "test",
        },
        mockRpcCall,
        undefined,
        { onMutationStart, onMutationEnd },
      );

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-m1", { action: "create" } as never),
      );

      expect(onMutationStart).toHaveBeenCalledOnce();
      expect(onMutationEnd).toHaveBeenCalledOnce();
    });
  });
});
