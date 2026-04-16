import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHeartbeatManageTool } from "./heartbeat-manage-tool.js";
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

describe("heartbeat_manage tool", () => {
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
    const tool = createHeartbeatManageTool(mockRpcCall);
    expect(tool.name).toBe("heartbeat_manage");
    expect(tool.label).toBe("Heartbeat Configuration");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws for non-admin callers (user)", async () => {
      const tool = createHeartbeatManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-1", { action: "get", agent_id: "test-agent" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws for non-admin callers (guest)", async () => {
      const tool = createHeartbeatManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-2", { action: "get" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows admin callers", async () => {
      const tool = createHeartbeatManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "get", agent_id: "test-agent" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // get action
  // -----------------------------------------------------------------------

  describe("get action", () => {
    it("delegates to heartbeat.get RPC with agentId", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "test-agent", perAgent: {}, effective: {} });
      const tool = createHeartbeatManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-g1", { action: "get", agent_id: "test-agent" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("heartbeat.get", { _trustLevel: "admin", agentId: "test-agent" });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "test-agent" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // update action
  // -----------------------------------------------------------------------

  describe("update action", () => {
    it("maps snake_case params to camelCase RPC fields", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "test-agent", updated: true });
      const tool = createHeartbeatManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-u1", {
          action: "update",
          agent_id: "test-agent",
          interval_ms: 600000,
          show_ok: true,
          target_channel_type: "telegram",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("heartbeat.update", {
        _trustLevel: "admin",
        agentId: "test-agent",
        intervalMs: 600000,
        showOk: true,
        targetChannelType: "telegram",
      });
    });

    it("only includes provided fields in RPC params", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "a", updated: true });
      const tool = createHeartbeatManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-u2", {
          action: "update",
          agent_id: "a",
          enabled: true,
        } as never),
      );

      const rpcParams = mockRpcCall.mock.calls[0]![1];
      expect(rpcParams).toEqual({ _trustLevel: "admin", agentId: "a", enabled: true });
      // Should NOT have intervalMs, model, etc.
      expect(rpcParams).not.toHaveProperty("intervalMs");
      expect(rpcParams).not.toHaveProperty("model");
      expect(rpcParams).not.toHaveProperty("prompt");
    });
  });

  // -----------------------------------------------------------------------
  // status action
  // -----------------------------------------------------------------------

  describe("status action", () => {
    it("delegates to heartbeat.states RPC", async () => {
      mockRpcCall.mockResolvedValue({ agents: [] });
      const tool = createHeartbeatManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s1", { action: "status" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("heartbeat.states", { _trustLevel: "admin" });
    });
  });

  // -----------------------------------------------------------------------
  // trigger action
  // -----------------------------------------------------------------------

  describe("trigger action", () => {
    it("delegates to heartbeat.trigger RPC with agentId", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "test-agent", triggered: true });
      const tool = createHeartbeatManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-t1", { action: "trigger", agent_id: "test-agent" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("heartbeat.trigger", { _trustLevel: "admin", agentId: "test-agent" });
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("throws [invalid_action] for unknown action", async () => {
      const tool = createHeartbeatManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "bogus" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when rpcCall throws", async () => {
      mockRpcCall.mockRejectedValue(new Error("RPC failed"));
      const tool = createHeartbeatManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e2", { action: "get", agent_id: "a" } as never),
        ),
      ).rejects.toThrow("RPC failed");
    });
  });
});
