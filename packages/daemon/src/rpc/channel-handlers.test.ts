import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock persist-to-config module to avoid real filesystem operations
// ---------------------------------------------------------------------------

vi.mock("./persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));

import { persistToConfig } from "./persist-to-config.js";
const mockPersistToConfig = vi.mocked(persistToConfig);

import { createChannelHandlers } from "./channel-handlers.js";
import type { ChannelHandlerDeps } from "./channel-handlers.js";
import type { PersistToConfigDeps } from "./persist-to-config.js";

// ---------------------------------------------------------------------------
// Helper: create isolated deps per test to avoid shared state
// ---------------------------------------------------------------------------

function makeMockAdapter(overrides?: Partial<{ channelId: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>) {
  return {
    channelId: overrides?.channelId ?? "tg-123",
    channelType: "telegram",
    start: overrides?.start ?? vi.fn(async () => ({ ok: true as const, value: undefined })),
    stop: overrides?.stop ?? vi.fn(async () => ({ ok: true as const, value: undefined })),
  } as never;
}

function makeDeps(overrides?: Partial<ChannelHandlerDeps>): ChannelHandlerDeps {
  const adaptersByType = new Map();
  adaptersByType.set("telegram", makeMockAdapter());
  return {
    adaptersByType,
    channelConfig: {
      telegram: { enabled: true },
      discord: { enabled: true },
      slack: { enabled: false },
    },
    ...overrides,
  };
}

function makePersistDeps(): PersistToConfigDeps {
  return {
    container: {
      config: { tenantId: "test", channels: { telegram: { enabled: true } } },
      eventBus: { emit: vi.fn() },
    },
    configPaths: ["/tmp/test-config.yaml"],
    defaultConfigPaths: ["/tmp/default-config.yaml"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  } as unknown as PersistToConfigDeps;
}

// ---------------------------------------------------------------------------
// Tests for the 5 channel management RPC handlers
// ---------------------------------------------------------------------------

describe("createChannelHandlers - channel management", () => {
  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
  });

  // -------------------------------------------------------------------------
  // channels.list (read-only -- no admin required)
  // -------------------------------------------------------------------------

  describe("channels.list", () => {
    it("returns all adapters with status", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.list"]!({})) as {
        channels: Array<{ channelType: string; status: string }>;
        total: number;
      };

      expect(result.channels).toHaveLength(2);
      expect(result.total).toBe(2);

      const telegram = result.channels.find((c) => c.channelType === "telegram");
      expect(telegram).toBeDefined();
      expect(telegram!.status).toBe("running");
    });

    it("includes configured-but-stopped channels", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.list"]!({})) as {
        channels: Array<{ channelType: string; status: string }>;
      };

      // Discord is enabled in config but has no running adapter
      const discord = result.channels.find((c) => c.channelType === "discord");
      expect(discord).toBeDefined();
      expect(discord!.status).toBe("stopped");
    });

    it("excludes disabled channels from stopped list", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.list"]!({})) as {
        channels: Array<{ channelType: string }>;
      };

      // Slack is disabled in config, should not appear
      const slack = result.channels.find((c) => c.channelType === "slack");
      expect(slack).toBeUndefined();
    });

    it("returns empty list when no adapters and no enabled config", async () => {
      const deps = makeDeps({
        adaptersByType: new Map(),
        channelConfig: {},
      });
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.list"]!({})) as {
        channels: unknown[];
        total: number;
      };

      expect(result.channels).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("works without _trustLevel (read-only operation)", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.list"]!({})) as {
        channels: unknown[];
      };

      expect(result.channels.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // channels.get (read-only -- no admin required)
  // -------------------------------------------------------------------------

  describe("channels.get", () => {
    it("returns running adapter details", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.get"]!({
        channel_type: "telegram",
      })) as { channelType: string; channelId: string; status: string };

      expect(result.channelType).toBe("telegram");
      expect(result.channelId).toBe("tg-123");
      expect(result.status).toBe("running");
    });

    it("returns stopped adapter info for configured-but-not-running", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.get"]!({
        channel_type: "discord",
      })) as { channelType: string; status: string; configured: boolean };

      expect(result.channelType).toBe("discord");
      expect(result.status).toBe("stopped");
      expect(result.configured).toBe(true);
    });

    it("throws for unknown channel type", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.get"]!({ channel_type: "whatsapp" }),
      ).rejects.toThrow("Channel type not found");
    });

    it("throws when channel_type is missing", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.get"]!({}),
      ).rejects.toThrow("Missing required parameter: channel_type");
    });

    it("works without _trustLevel (read-only operation)", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.get"]!({
        channel_type: "telegram",
      })) as { channelType: string };

      expect(result.channelType).toBe("telegram");
    });
  });

  // -------------------------------------------------------------------------
  // channels.enable (admin required)
  // -------------------------------------------------------------------------

  describe("channels.enable", () => {
    it("rejects channels.enable without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.enable"]!({ channel_type: "telegram", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects channels.enable without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.enable"]!({ channel_type: "telegram" }),
      ).rejects.toThrow("Admin access required");
    });

    it("calls adapter.start() and returns success", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.enable"]!({
        channel_type: "telegram",
        _trustLevel: "admin",
      })) as { channelType: string; status: string; message: string };

      const adapter = deps.adaptersByType.get("telegram") as { start: ReturnType<typeof vi.fn> };
      expect(adapter.start).toHaveBeenCalled();
      expect(result.channelType).toBe("telegram");
      expect(result.status).toBe("running");
      expect(result.message).toBe("Channel adapter started");
    });

    it("throws when adapter not found", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.enable"]!({ channel_type: "discord", _trustLevel: "admin" }),
      ).rejects.toThrow("Channel type not found or not configured");
    });

    it("throws when start fails", async () => {
      const failStart = vi.fn(async () => ({
        ok: false as const,
        error: new Error("Connection refused"),
      }));
      const adapter = makeMockAdapter({ start: failStart });
      const adaptersByType = new Map();
      adaptersByType.set("telegram", adapter);

      const deps = makeDeps({ adaptersByType });
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.enable"]!({ channel_type: "telegram", _trustLevel: "admin" }),
      ).rejects.toThrow("Connection refused");
    });
  });

  // -------------------------------------------------------------------------
  // channels.disable (admin required)
  // -------------------------------------------------------------------------

  describe("channels.disable", () => {
    it("rejects channels.disable without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.disable"]!({ channel_type: "telegram", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects channels.disable without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.disable"]!({ channel_type: "telegram" }),
      ).rejects.toThrow("Admin access required");
    });

    it("calls adapter.stop() and returns success", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.disable"]!({
        channel_type: "telegram",
        _trustLevel: "admin",
      })) as { channelType: string; status: string; message: string };

      const adapter = deps.adaptersByType.get("telegram") as { stop: ReturnType<typeof vi.fn> };
      expect(adapter.stop).toHaveBeenCalled();
      expect(result.channelType).toBe("telegram");
      expect(result.status).toBe("stopped");
      expect(result.message).toBe("Channel adapter stopped");
    });

    it("throws when adapter not found", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.disable"]!({ channel_type: "discord", _trustLevel: "admin" }),
      ).rejects.toThrow("Channel type not found or not configured");
    });

    it("throws when stop fails", async () => {
      const failStop = vi.fn(async () => ({
        ok: false as const,
        error: new Error("Stop timed out"),
      }));
      const adapter = makeMockAdapter({ stop: failStop });
      const adaptersByType = new Map();
      adaptersByType.set("telegram", adapter);

      const deps = makeDeps({ adaptersByType });
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.disable"]!({ channel_type: "telegram", _trustLevel: "admin" }),
      ).rejects.toThrow("Stop timed out");
    });
  });

  // -------------------------------------------------------------------------
  // channels.restart (admin required)
  // -------------------------------------------------------------------------

  describe("channels.restart", () => {
    it("rejects channels.restart without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.restart"]!({ channel_type: "telegram", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects channels.restart without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.restart"]!({ channel_type: "telegram" }),
      ).rejects.toThrow("Admin access required");
    });

    it("calls stop then start and returns success", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.restart"]!({
        channel_type: "telegram",
        _trustLevel: "admin",
      })) as { channelType: string; status: string; message: string };

      const adapter = deps.adaptersByType.get("telegram") as {
        stop: ReturnType<typeof vi.fn>;
        start: ReturnType<typeof vi.fn>;
      };
      expect(adapter.stop).toHaveBeenCalled();
      expect(adapter.start).toHaveBeenCalled();
      expect(result.channelType).toBe("telegram");
      expect(result.status).toBe("running");
      expect(result.message).toBe("Channel adapter restarted");
    });

    it("throws when stop fails (does not call start)", async () => {
      const failStop = vi.fn(async () => ({
        ok: false as const,
        error: new Error("Stop failed"),
      }));
      const mockStart = vi.fn(async () => ({ ok: true as const, value: undefined }));
      const adapter = makeMockAdapter({ stop: failStop, start: mockStart });
      const adaptersByType = new Map();
      adaptersByType.set("telegram", adapter);

      const deps = makeDeps({ adaptersByType });
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.restart"]!({ channel_type: "telegram", _trustLevel: "admin" }),
      ).rejects.toThrow("Stop failed");

      // start should NOT have been called since stop failed
      expect(mockStart).not.toHaveBeenCalled();
    });

    it("throws when adapter not found", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.restart"]!({ channel_type: "discord", _trustLevel: "admin" }),
      ).rejects.toThrow("Channel type not found or not configured");
    });
  });

  // -------------------------------------------------------------------------
  // Persistence wiring tests
  // -------------------------------------------------------------------------

  describe("persistence wiring", () => {
    it("channels.enable calls persistToConfig with enabled: true patch", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createChannelHandlers(deps);

      await handlers["channels.enable"]!({ channel_type: "telegram", _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("channels.enable");
      expect(callOpts.entityId).toBe("telegram");
      expect(callOpts.patch).toEqual({ channels: { telegram: { enabled: true } } });
    });

    it("channels.disable calls persistToConfig with enabled: false patch", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createChannelHandlers(deps);

      await handlers["channels.disable"]!({ channel_type: "telegram", _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("channels.disable");
      expect(callOpts.entityId).toBe("telegram");
      expect(callOpts.patch).toEqual({ channels: { telegram: { enabled: false } } });
    });

    it("channels.enable succeeds even if persistToConfig fails (best-effort)", async () => {
      mockPersistToConfig.mockResolvedValue({ ok: false, error: "disk full" } as never);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.enable"]!({
        channel_type: "telegram",
        _trustLevel: "admin",
      })) as { channelType: string; status: string };

      // Handler still succeeds -- persistence is best-effort
      expect(result.channelType).toBe("telegram");
      expect(result.status).toBe("running");
      // Persistence failure was logged
      expect(persistDeps.logger.warn).toHaveBeenCalled();
    });

    it("channels.list does not call persistToConfig", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createChannelHandlers(deps);

      await handlers["channels.list"]!({});

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    it("channels.restart does not call persistToConfig", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createChannelHandlers(deps);

      await handlers["channels.restart"]!({ channel_type: "telegram", _trustLevel: "admin" });

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // channels.health (read-only observability -- no admin required)
  // -------------------------------------------------------------------------

  describe("channels.health", () => {
    it("returns empty array with enabled: false when healthMonitor is undefined", async () => {
      const deps = makeDeps(); // no healthMonitor
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.health"]!({})) as {
        channels: unknown[];
        timestamp: number;
        enabled: boolean;
      };

      expect(result.channels).toHaveLength(0);
      expect(result.enabled).toBe(false);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("returns formatted entries when healthMonitor is provided", async () => {
      const now = Date.now();
      const mockSummary = new Map([
        [
          "telegram",
          {
            channelType: "telegram",
            state: "healthy" as const,
            connectionMode: "polling" as const,
            lastCheckedAt: now,
            lastMessageAt: now - 5000,
            error: null,
            stateChangedAt: now - 60000,
            consecutiveFailures: 0,
            activeRuns: 1,
            lastRunStartedAt: now - 3000,
            adapterStartedAt: now - 120000,
            restartAttempts: 0,
            busyStateInitialized: false,
          },
        ],
        [
          "discord",
          {
            channelType: "discord",
            state: "idle" as const,
            connectionMode: "socket" as const,
            lastCheckedAt: now,
            lastMessageAt: now - 700000,
            error: null,
            stateChangedAt: now - 300000,
            consecutiveFailures: 0,
            activeRuns: 0,
            lastRunStartedAt: null,
            adapterStartedAt: now - 900000,
            restartAttempts: 2,
            busyStateInitialized: false,
          },
        ],
      ]);

      const mockHealthMonitor = {
        getHealthSummary: vi.fn().mockReturnValue(mockSummary),
        addAdapter: vi.fn(),
        removeAdapter: vi.fn(),
      };

      const deps = makeDeps({ healthMonitor: mockHealthMonitor as never });
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.health"]!({})) as {
        channels: Array<{
          channelType: string;
          state: string;
          connectionMode: string;
          lastCheckedAt: number;
          lastMessageAt: number | null;
          error: string | null;
          stateChangedAt: number;
          consecutiveFailures: number;
          activeRuns: number;
          restartAttempts: number;
          uptimeMs: number;
        }>;
        timestamp: number;
        enabled: boolean;
      };

      expect(result.enabled).toBe(true);
      expect(result.channels).toHaveLength(2);
      expect(result.timestamp).toBeGreaterThan(0);

      const tg = result.channels.find((c) => c.channelType === "telegram");
      expect(tg).toBeDefined();
      expect(tg!.state).toBe("healthy");
      expect(tg!.connectionMode).toBe("polling");
      expect(tg!.activeRuns).toBe(1);
      expect(tg!.restartAttempts).toBe(0);
      expect(tg!.uptimeMs).toBeGreaterThan(0);

      const dc = result.channels.find((c) => c.channelType === "discord");
      expect(dc).toBeDefined();
      expect(dc!.state).toBe("idle");
      expect(dc!.connectionMode).toBe("socket");
      expect(dc!.restartAttempts).toBe(2);
    });

    it("works without _trustLevel (read-only operation)", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      // Should not throw -- no admin required
      const result = (await handlers["channels.health"]!({})) as { enabled: boolean };
      expect(result.enabled).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Health monitor dynamic registration
  // -------------------------------------------------------------------------

  describe("health monitor dynamic registration", () => {
    it("channels.enable calls healthMonitor.addAdapter() after start", async () => {
      const mockHealthMonitor = {
        getHealthSummary: vi.fn(),
        addAdapter: vi.fn(),
        removeAdapter: vi.fn(),
      };

      const deps = makeDeps({ healthMonitor: mockHealthMonitor as never });
      const handlers = createChannelHandlers(deps);

      await handlers["channels.enable"]!({ channel_type: "telegram", _trustLevel: "admin" });

      expect(mockHealthMonitor.addAdapter).toHaveBeenCalledOnce();
      expect(mockHealthMonitor.addAdapter).toHaveBeenCalledWith(
        "telegram",
        deps.adaptersByType.get("telegram"),
      );
    });

    it("channels.disable calls healthMonitor.removeAdapter() after stop", async () => {
      const mockHealthMonitor = {
        getHealthSummary: vi.fn(),
        addAdapter: vi.fn(),
        removeAdapter: vi.fn(),
      };

      const deps = makeDeps({ healthMonitor: mockHealthMonitor as never });
      const handlers = createChannelHandlers(deps);

      await handlers["channels.disable"]!({ channel_type: "telegram", _trustLevel: "admin" });

      expect(mockHealthMonitor.removeAdapter).toHaveBeenCalledOnce();
      expect(mockHealthMonitor.removeAdapter).toHaveBeenCalledWith("telegram");
    });

    it("channels.enable works without healthMonitor (no addAdapter call)", async () => {
      const deps = makeDeps(); // no healthMonitor
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.enable"]!({
        channel_type: "telegram",
        _trustLevel: "admin",
      })) as { status: string };

      expect(result.status).toBe("running");
    });

    it("channels.disable works without healthMonitor (no removeAdapter call)", async () => {
      const deps = makeDeps(); // no healthMonitor
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.disable"]!({
        channel_type: "telegram",
        _trustLevel: "admin",
      })) as { status: string };

      expect(result.status).toBe("stopped");
    });
  });

  // -------------------------------------------------------------------------
  // delivery.queue.status (read-only observability)
  // -------------------------------------------------------------------------

  describe("delivery.queue.status", () => {
    it("returns per-status counts from delivery queue", async () => {
      const mockDeliveryQueue = {
        statusCounts: vi.fn().mockResolvedValue({
          ok: true as const,
          value: { pending: 3, inFlight: 1, failed: 2, delivered: 10, expired: 0 },
        }),
      };
      const deps = makeDeps({ deliveryQueue: mockDeliveryQueue as never });
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["delivery.queue.status"]!({})) as {
        pending: number; inFlight: number; failed: number; delivered: number; expired: number;
      };

      expect(result.pending).toBe(3);
      expect(result.inFlight).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.delivered).toBe(10);
      expect(result.expired).toBe(0);
    });

    it("passes channel_type filter to statusCounts", async () => {
      const mockDeliveryQueue = {
        statusCounts: vi.fn().mockResolvedValue({
          ok: true as const,
          value: { pending: 1, inFlight: 0, failed: 0, delivered: 5, expired: 0 },
        }),
      };
      const deps = makeDeps({ deliveryQueue: mockDeliveryQueue as never });
      const handlers = createChannelHandlers(deps);

      await handlers["delivery.queue.status"]!({ channel_type: "telegram" });

      expect(mockDeliveryQueue.statusCounts).toHaveBeenCalledWith("telegram");
    });

    it("returns all zeros when deliveryQueue is undefined", async () => {
      const deps = makeDeps(); // no deliveryQueue
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["delivery.queue.status"]!({})) as {
        pending: number; inFlight: number; failed: number; delivered: number; expired: number;
      };

      expect(result).toEqual({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 });
    });

    it("throws when statusCounts returns error", async () => {
      const mockDeliveryQueue = {
        statusCounts: vi.fn().mockResolvedValue({
          ok: false as const,
          error: new Error("Database locked"),
        }),
      };
      const deps = makeDeps({ deliveryQueue: mockDeliveryQueue as never });
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["delivery.queue.status"]!({}),
      ).rejects.toThrow("Database locked");
    });
  });

  // -------------------------------------------------------------------------
  // channels.capabilities (read-only observability)
  // -------------------------------------------------------------------------

  describe("channels.capabilities", () => {
    it("returns features map for a given channel type", async () => {
      const mockPlugin = {
        capabilities: {
          features: {
            reactions: true,
            editMessages: true,
            deleteMessages: true,
            fetchHistory: false,
            attachments: true,
            threads: true,
            mentions: true,
            formatting: ["bold", "italic"],
            buttons: true,
            cards: true,
            effects: true,
          },
        },
      };
      const channelPlugins = new Map([["telegram", mockPlugin as never]]);
      const deps = makeDeps({ channelPlugins });
      const handlers = createChannelHandlers(deps);

      const result = (await handlers["channels.capabilities"]!({
        channel_type: "telegram",
      })) as { channelType: string; features: Record<string, unknown> };

      expect(result.channelType).toBe("telegram");
      expect(result.features.reactions).toBe(true);
      expect(result.features.editMessages).toBe(true);
      expect(result.features.threads).toBe(true);
    });

    it("throws when channel_type is missing", async () => {
      const deps = makeDeps();
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.capabilities"]({}),
      ).rejects.toThrow("Missing required parameter: channel_type");
    });

    it("throws when channel type not found in plugins map", async () => {
      const channelPlugins = new Map<string, never>();
      const deps = makeDeps({ channelPlugins });
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.capabilities"]!({ channel_type: "whatsapp" }),
      ).rejects.toThrow("Channel type not found: whatsapp");
    });

    it("throws when channelPlugins is undefined", async () => {
      const deps = makeDeps(); // no channelPlugins
      const handlers = createChannelHandlers(deps);

      await expect(
        handlers["channels.capabilities"]!({ channel_type: "telegram" }),
      ).rejects.toThrow("Channel type not found: telegram");
    });
  });
});
