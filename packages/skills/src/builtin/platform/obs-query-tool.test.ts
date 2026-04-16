import { describe, it, expect, vi, beforeEach } from "vitest";
import { createObsQueryTool } from "./obs-query-tool.js";
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

describe("obs_query tool", () => {
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
    const tool = createObsQueryTool(mockRpcCall);
    expect(tool.name).toBe("obs_query");
    expect(tool.label).toBe("Observability Query");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws for non-admin callers (guest)", async () => {
      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "diagnostics" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws for non-admin callers (user)", async () => {
      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "diagnostics" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createObsQueryTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "diagnostics" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // diagnostics action
  // -----------------------------------------------------------------------

  describe("diagnostics action", () => {
    it("calls rpcCall('obs.diagnostics') with category, limit, sinceMs", async () => {
      mockRpcCall.mockResolvedValue({ entries: [] });

      const tool = createObsQueryTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d1", {
          action: "diagnostics",
          category: "errors",
          limit: 10,
          since_ms: 1000,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.diagnostics", {
        category: "errors",
        limit: 10,
        sinceMs: 1000,
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(expect.objectContaining({ entries: [] }));
    });

    it("passes undefined for optional params when not provided", async () => {
      mockRpcCall.mockResolvedValue({ entries: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d2", { action: "diagnostics" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.diagnostics", {
        category: undefined,
        limit: undefined,
        sinceMs: undefined,
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // billing action
  // -----------------------------------------------------------------------

  describe("billing action", () => {
    it("billing/byProvider calls rpcCall('obs.billing.byProvider')", async () => {
      mockRpcCall.mockResolvedValue({ providers: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-b1", {
          action: "billing",
          sub_action: "byProvider",
          since_ms: 5000,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.billing.byProvider", { sinceMs: 5000, _trustLevel: "admin" });
    });

    it("billing/byAgent calls rpcCall('obs.billing.byAgent') with agentId", async () => {
      mockRpcCall.mockResolvedValue({ usage: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-b2", {
          action: "billing",
          sub_action: "byAgent",
          agent_id: "bot-1",
          since_ms: 3000,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.billing.byAgent", {
        agentId: "bot-1",
        sinceMs: 3000,
        _trustLevel: "admin",
      });
    });

    it("billing/bySession calls rpcCall('obs.billing.bySession') with sessionKey", async () => {
      mockRpcCall.mockResolvedValue({ usage: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-b3", {
          action: "billing",
          sub_action: "bySession",
          session_key: "sess-1",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.billing.bySession", {
        sessionKey: "sess-1",
        sinceMs: undefined,
        _trustLevel: "admin",
      });
    });

    it("billing/total calls rpcCall('obs.billing.total')", async () => {
      mockRpcCall.mockResolvedValue({ total: 100 });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-b4", {
          action: "billing",
          sub_action: "total",
          since_ms: 1000,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.billing.total", { sinceMs: 1000, _trustLevel: "admin" });
    });

    it("billing defaults to total when sub_action not specified", async () => {
      mockRpcCall.mockResolvedValue({ total: 50 });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-b5", { action: "billing" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.billing.total", { sinceMs: undefined, _trustLevel: "admin" });
    });

    it("billing/byAgent throws when agent_id missing", async () => {
      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-b6", {
            action: "billing",
            sub_action: "byAgent",
          } as never),
        ),
      ).rejects.toThrow(/agent_id/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // delivery action
  // -----------------------------------------------------------------------

  describe("delivery action", () => {
    it("delivery/recent calls rpcCall('obs.delivery.recent') with params", async () => {
      mockRpcCall.mockResolvedValue({ traces: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-del1", {
          action: "delivery",
          sub_action: "recent",
          since_ms: 2000,
          limit: 5,
          channel_id: "ch-1",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.delivery.recent", {
        sinceMs: 2000,
        limit: 5,
        channelId: "ch-1",
        _trustLevel: "admin",
      });
    });

    it("delivery defaults to recent when sub_action not specified", async () => {
      mockRpcCall.mockResolvedValue({ traces: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-del2", { action: "delivery" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.delivery.recent", {
        sinceMs: undefined,
        limit: undefined,
        channelId: undefined,
        _trustLevel: "admin",
      });
    });

    it("delivery/stats calls rpcCall('obs.delivery.stats')", async () => {
      mockRpcCall.mockResolvedValue({ sent: 100, failed: 2 });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-del3", {
          action: "delivery",
          sub_action: "stats",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.delivery.stats", { _trustLevel: "admin" });
    });
  });

  // -----------------------------------------------------------------------
  // channels action
  // -----------------------------------------------------------------------

  describe("channels action", () => {
    it("channels/all calls rpcCall('obs.channels.all')", async () => {
      mockRpcCall.mockResolvedValue({ channels: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ch1", {
          action: "channels",
          sub_action: "all",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.channels.all", { _trustLevel: "admin" });
    });

    it("channels defaults to all when sub_action not specified", async () => {
      mockRpcCall.mockResolvedValue({ channels: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ch2", { action: "channels" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.channels.all", { _trustLevel: "admin" });
    });

    it("channels/stale calls rpcCall('obs.channels.stale') with thresholdMs", async () => {
      mockRpcCall.mockResolvedValue({ stale: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ch3", {
          action: "channels",
          sub_action: "stale",
          threshold_ms: 600_000,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.channels.stale", {
        thresholdMs: 600_000,
        _trustLevel: "admin",
      });
    });

    it("channels/stale uses default 300000ms when threshold_ms not provided", async () => {
      mockRpcCall.mockResolvedValue({ stale: [] });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ch4", {
          action: "channels",
          sub_action: "stale",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.channels.stale", {
        thresholdMs: 300_000,
        _trustLevel: "admin",
      });
    });

    it("channels/get calls rpcCall('obs.channels.get') with channelId", async () => {
      mockRpcCall.mockResolvedValue({ channelId: "ch-1", active: true });

      const tool = createObsQueryTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ch5", {
          action: "channels",
          sub_action: "get",
          channel_id: "ch-1",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("obs.channels.get", { channelId: "ch-1", _trustLevel: "admin" });
    });

    it("channels/get throws when channel_id missing", async () => {
      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-ch6", {
            action: "channels",
            sub_action: "get",
          } as never),
        ),
      ).rejects.toThrow(/channel_id/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Obs service unavailable"));

      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "diagnostics" } as never),
        ),
      ).rejects.toThrow("Obs service unavailable");
    });

    it("handles non-Error throws gracefully", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e2", { action: "diagnostics" } as never),
        ),
      ).rejects.toThrow("string error");
    });

    it("throws [invalid_action] for unknown action", async () => {
      const tool = createObsQueryTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e3", { action: "unknown" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });
});
