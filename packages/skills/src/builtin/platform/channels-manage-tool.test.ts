import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChannelsManageTool } from "./channels-manage-tool.js";
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

describe("channels_manage tool", () => {
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

  it("has correct name and label", () => {
    const tool = createChannelsManageTool(mockRpcCall);
    expect(tool.name).toBe("channels_manage");
    expect(tool.label).toBe("Channel Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createChannelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createChannelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createChannelsManageTool(mockRpcCall);

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
    it("delegates to channels.list RPC", async () => {
      mockRpcCall.mockResolvedValue({ channels: [], total: 0 });

      const tool = createChannelsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l1", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("channels.list", { _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ channels: [], total: 0 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // get action
  // -----------------------------------------------------------------------

  describe("get action", () => {
    it("delegates to channels.get with channel_type", async () => {
      mockRpcCall.mockResolvedValue({ channelType: "telegram", status: "running" });

      const tool = createChannelsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-g1", { action: "get", channel_type: "telegram" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("channels.get", { channel_type: "telegram", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ channelType: "telegram", status: "running" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // enable action
  // -----------------------------------------------------------------------

  describe("enable action", () => {
    it("requests approval then delegates to channels.enable", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ channelType: "telegram", status: "running" });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-en1", { action: "enable", channel_type: "telegram" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "channels_manage",
          action: "channels.enable",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("channels.enable", { channel_type: "telegram", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ channelType: "telegram", status: "running" }),
      );
    });

    it("throws denial when approval rejected", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "operator denied",
      });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-en2", { action: "enable", channel_type: "telegram" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // disable action
  // -----------------------------------------------------------------------

  describe("disable action", () => {
    it("requests approval then delegates to channels.disable", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ channelType: "telegram", status: "stopped" });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-dis1", { action: "disable", channel_type: "telegram" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "channels_manage",
          action: "channels.disable",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("channels.disable", { channel_type: "telegram", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ channelType: "telegram", status: "stopped" }),
      );
    });

    it("throws denial when approval rejected", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "not authorized",
      });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-dis2", { action: "disable", channel_type: "telegram" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // restart action
  // -----------------------------------------------------------------------

  describe("restart action", () => {
    it("requests approval then delegates to channels.restart", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ channelType: "telegram", status: "running" });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-res1", { action: "restart", channel_type: "telegram" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "channels_manage",
          action: "channels.restart",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("channels.restart", { channel_type: "telegram", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ channelType: "telegram", status: "running" }),
      );
    });

    it("throws denial when approval rejected", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "maintenance window",
      });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-res2", { action: "restart", channel_type: "telegram" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // configure action
  // -----------------------------------------------------------------------

  describe("configure action", () => {
    it("reads channel config and patches media processing setting", async () => {
      // First call: config.read returns channel config with telegram present
      mockRpcCall.mockResolvedValueOnce({
        telegram: { mediaProcessing: { transcribeAudio: false } },
      });
      // Second call: config.patch returns success
      mockRpcCall.mockResolvedValueOnce({ patched: true });

      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cfg1", {
          action: "configure",
          channel_type: "telegram",
          setting: "transcribeAudio",
          enabled: true,
        } as never),
      );

      // Verify config.read called first
      expect(mockRpcCall).toHaveBeenNthCalledWith(1, "config.read", { section: "channels", _trustLevel: "admin" });
      // Verify config.patch called second with correct key
      expect(mockRpcCall).toHaveBeenNthCalledWith(2, "config.patch", {
        section: "channels",
        key: "telegram.mediaProcessing.transcribeAudio",
        value: true,
        _trustLevel: "admin",
      });
      // Verify approval gate was invoked by the factory (channels.configure)
      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "channels_manage",
          action: "channels.configure",
        }),
      );
      // Verify result
      expect(result.details).toEqual({ patched: true });
    });

    it("throws for invalid setting name", async () => {
      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-cfg2", {
            action: "configure",
            channel_type: "telegram",
            setting: "invalidSetting",
            enabled: true,
          } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\].*Invalid media processing setting/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when channel not found in config", async () => {
      // config.read returns config without telegram
      mockRpcCall.mockResolvedValueOnce({
        discord: { mediaProcessing: { transcribeAudio: true } },
      });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-cfg3", {
            action: "configure",
            channel_type: "telegram",
            setting: "transcribeAudio",
            enabled: true,
          } as never),
        ),
      ).rejects.toThrow(/\[not_found\].*Channel not found/);
      // config.read was called but config.patch should NOT have been called
      expect(mockRpcCall).toHaveBeenCalledTimes(1);
      expect(mockRpcCall).toHaveBeenCalledWith("config.read", { section: "channels", _trustLevel: "admin" });
    });

    it("throws denial when approval rejected", async () => {
      // config.read returns channel config with telegram present
      mockRpcCall.mockResolvedValueOnce({
        telegram: { mediaProcessing: {} },
      });

      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "not now",
      });

      const tool = createChannelsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-cfg4", {
            action: "configure",
            channel_type: "telegram",
            setting: "analyzeImages",
            enabled: false,
          } as never),
        ),
      ).rejects.toThrow(/not approved/);
      // config.read was called but config.patch should NOT have been called
      expect(mockRpcCall).toHaveBeenCalledTimes(1);
      expect(mockRpcCall).toHaveBeenCalledWith("config.read", { section: "channels", _trustLevel: "admin" });
    });

    it("works without approval gate", async () => {
      // First call: config.read
      mockRpcCall.mockResolvedValueOnce({
        telegram: { mediaProcessing: { describeVideos: false } },
      });
      // Second call: config.patch
      mockRpcCall.mockResolvedValueOnce({ patched: true });

      const tool = createChannelsManageTool(mockRpcCall); // no approval gate

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cfg5", {
          action: "configure",
          channel_type: "telegram",
          setting: "describeVideos",
          enabled: true,
        } as never),
      );

      // Both RPC calls made without approval gate interaction
      expect(mockRpcCall).toHaveBeenCalledTimes(2);
      expect(mockRpcCall).toHaveBeenNthCalledWith(1, "config.read", { section: "channels", _trustLevel: "admin" });
      expect(mockRpcCall).toHaveBeenNthCalledWith(2, "config.patch", {
        section: "channels",
        key: "telegram.mediaProcessing.describeVideos",
        value: true,
        _trustLevel: "admin",
      });
      expect(result.details).toEqual({ patched: true });
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createChannelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-u1", { action: "unknown_action" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // works without approval gate
  // -----------------------------------------------------------------------

  describe("without approval gate", () => {
    it("calls rpcCall directly for enable when approvalGate is undefined", async () => {
      mockRpcCall.mockResolvedValue({ channelType: "telegram", status: "running" });

      const tool = createChannelsManageTool(mockRpcCall); // no approval gate

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-na1", { action: "enable", channel_type: "telegram" } as never),
      );

      expect(result.details).toEqual(
        expect.objectContaining({ channelType: "telegram", status: "running" }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("channels.enable", { channel_type: "telegram", _trustLevel: "admin" });
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Channel service unavailable"));

      const tool = createChannelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "list" } as never),
        ),
      ).rejects.toThrow("Channel service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createChannelsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e2", { action: "list" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });
});
