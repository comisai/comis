// SPDX-License-Identifier: Apache-2.0
/**
 * CWIRE: Custom Adapter Wiring & Integration Tests
 *
 * Package-level integration tests for ChannelManager adapter wiring
 * (combined direct + registry adapter lists, failure isolation, active
 * count tracking) and ChannelRegistry event emission, plus daemon-level
 * E2E tests verifying custom adapter registration and dispatch.
 *
 *   CWIRE-01: startAll() starts direct adapters only when no registry
 *   CWIRE-02: startAll() starts registry-only adapters when deps.adapters empty
 *   CWIRE-03: startAll() builds combined list from both sources
 *   CWIRE-04: failed adapter start() is logged and skipped
 *   CWIRE-05: channel:registered event fires with correct payload
 *   CWIRE-06: channel:deregistered event fires on unregisterChannel
 *   CWIRE-07: getCapabilities returns full capability object
 *   CWIRE-08: streaming support query via capabilities
 *   CWIRE-09: edit support determines operation availability
 *   CWIRE-10: daemon boots and adapter registry is accessible
 *   CWIRE-11: custom EchoChannelAdapter registered on daemon registry
 *   CWIRE-12: custom adapter dispatch via registry (sendMessage + fetchMessages)
 *
 * Uses port 8504 for daemon-level tests.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChannelManager,
  createChannelRegistry,
  createEchoPlugin,
  EchoChannelAdapter,
  type ChannelManagerDeps,
  type ChannelRegistry,
} from "@comis/channels";
import {
  TypedEventBus,
  createPluginRegistry,
  type ChannelPort,
  type ChannelPluginPort,
  type ChannelCapability,
} from "@comis/core";
import { ok, err } from "@comis/shared";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const customAdapterConfigPath = resolve(
  __dirname,
  "../config/config.test-custom-adapter.yaml",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock ChannelPort adapter with configurable start/stop results.
 */
function createMockAdapter(opts: {
  channelId: string;
  channelType: string;
  startResult?: ReturnType<typeof err>;
  stopResult?: ReturnType<typeof err>;
}): ChannelPort {
  return {
    channelId: opts.channelId,
    channelType: opts.channelType,
    start: vi.fn(async () => opts.startResult ?? ok(undefined)),
    stop: vi.fn(async () => opts.stopResult ?? ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    reactToMessage: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok("msg-attach-1")),
    platformAction: vi.fn(async () => ok({})),
    onMessage: vi.fn(),
  } as any;
}

/**
 * Create a mock ChannelPluginPort wrapping a mock adapter.
 */
function createMockPlugin(opts: {
  channelType: string;
  id?: string;
  capabilities?: Partial<ChannelCapability>;
}): ChannelPluginPort {
  const adapter = createMockAdapter({
    channelId: `mock-${opts.channelType}`,
    channelType: opts.channelType,
  });
  const defaultCaps: ChannelCapability = {
    chatTypes: ["dm"],
    features: {
      reactions: false,
      editMessages: false,
      deleteMessages: false,
      fetchHistory: false,
      attachments: false,
      threads: false,
      mentions: false,
      formatting: [],
    },
    limits: { maxMessageChars: 4096 },
    streaming: { supported: false, throttleMs: 300, method: "none" },
    threading: { supported: false, threadType: "none" },
  };
  const mergedCaps = opts.capabilities
    ? { ...defaultCaps, ...opts.capabilities }
    : defaultCaps;

  return {
    id: opts.id ?? `channel-${opts.channelType}`,
    name: `Mock ${opts.channelType} plugin`,
    version: "1.0.0",
    channelType: opts.channelType,
    capabilities: mergedCaps,
    adapter,
    register: (_api) => ok(undefined),
    activate: async () => adapter.start(),
    deactivate: async () => adapter.stop(),
  } as ChannelPluginPort;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeEventBus() {
  return {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  } as any;
}

function makeMinimalDeps(overrides?: Partial<ChannelManagerDeps>): ChannelManagerDeps {
  return {
    eventBus: makeEventBus(),
    messageRouter: { resolve: vi.fn(() => "agent-default"), updateConfig: vi.fn() } as any,
    sessionManager: {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    } as any,
    createExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({
        response: "test",
        sessionKey: { tenantId: "default", userId: "u1", channelId: "c1" },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop",
      })),
    })),
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CWIRE: Custom Adapter Wiring & Integration", () => {
  // -------------------------------------------------------------------------
  // ChannelManager combined adapter list (CWIRE-01 through CWIRE-04)
  // -------------------------------------------------------------------------

  describe("ChannelManager combined adapter list (CWIRE-01 through CWIRE-04)", () => {
    it("CWIRE-01: startAll() starts direct adapters only when no channelRegistry provided", async () => {
      const adapterA = createMockAdapter({ channelId: "a", channelType: "direct-a" });
      const adapterB = createMockAdapter({ channelId: "b", channelType: "direct-b" });
      const deps = makeMinimalDeps({ adapters: [adapterA, adapterB] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(manager.activeCount).toBe(2);
      expect(adapterA.start).toHaveBeenCalled();
      expect(adapterB.start).toHaveBeenCalled();
    });

    it("CWIRE-02: startAll() starts registry-only adapters when deps.adapters is empty", async () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const pluginA = createMockPlugin({ channelType: "reg-a" });
      const pluginB = createMockPlugin({ channelType: "reg-b" });
      channelRegistry.registerChannel(pluginA);
      channelRegistry.registerChannel(pluginB);

      const deps = makeMinimalDeps({
        adapters: [],
        channelRegistry,
        eventBus: eventBus as any,
      });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(manager.activeCount).toBe(2);
    });

    it("CWIRE-03: startAll() builds combined list from both direct adapters and registry plugins", async () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const directAdapter = createMockAdapter({ channelId: "direct-c", channelType: "direct-c" });
      const regPlugin = createMockPlugin({ channelType: "reg-c" });
      channelRegistry.registerChannel(regPlugin);

      const deps = makeMinimalDeps({
        adapters: [directAdapter],
        channelRegistry,
        eventBus: eventBus as any,
      });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(manager.activeCount).toBe(2); // 1 direct + 1 registry
    });

    it("CWIRE-04: failed adapter start() is logged and skipped, other adapters proceed", async () => {
      const failingAdapter = createMockAdapter({
        channelId: "fail-adapter",
        channelType: "fail-type",
        startResult: err(new Error("Connection refused")),
      });
      const workingAdapter = createMockAdapter({
        channelId: "good-adapter",
        channelType: "good-type",
      });
      const logger = makeLogger();
      const deps = makeMinimalDeps({
        adapters: [failingAdapter, workingAdapter],
        logger,
      });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(manager.activeCount).toBe(1); // only working adapter
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: "fail-adapter" }),
        expect.stringContaining("Failed to start adapter"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // ChannelRegistry event emission (CWIRE-05, CWIRE-06)
  // -------------------------------------------------------------------------

  describe("ChannelRegistry event emission (CWIRE-05, CWIRE-06)", () => {
    it("CWIRE-05: channel:registered event fires with correct channelType, pluginId, capabilities, timestamp", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const events: any[] = [];
      eventBus.on("channel:registered", (ev) => events.push(ev));

      const plugin = createMockPlugin({
        channelType: "event-test",
        id: "channel-event-test",
        capabilities: {
          limits: { maxMessageChars: 2048 },
        },
      });
      channelRegistry.registerChannel(plugin);

      expect(events.length).toBe(1);
      expect(events[0].channelType).toBe("event-test");
      expect(events[0].pluginId).toBe("channel-event-test");
      expect(events[0].capabilities.limits.maxMessageChars).toBe(2048);
      expect(events[0].timestamp).toBeGreaterThan(0);
    });

    it("CWIRE-06: channel:deregistered event fires on unregisterChannel with correct payload", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const plugin = createMockPlugin({
        channelType: "dereg-test",
        id: "channel-dereg-test",
      });
      channelRegistry.registerChannel(plugin);

      const events: any[] = [];
      eventBus.on("channel:deregistered", (ev) => events.push(ev));

      channelRegistry.unregisterChannel("dereg-test");

      expect(events.length).toBe(1);
      expect(events[0].channelType).toBe("dereg-test");
      expect(events[0].pluginId).toBe("channel-dereg-test");
      expect(events[0].timestamp).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Capability feature negotiation (CWIRE-07 through CWIRE-09)
  // -------------------------------------------------------------------------

  describe("capability feature negotiation (CWIRE-07 through CWIRE-09)", () => {
    it("CWIRE-07: getCapabilities returns full capability object for registered channel", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const richCaps: ChannelCapability = {
        chatTypes: ["dm", "group", "thread"],
        features: {
          reactions: true,
          editMessages: true,
          deleteMessages: true,
          fetchHistory: true,
          attachments: true,
          threads: true,
          mentions: true,
          formatting: ["bold", "italic"],
        },
        limits: { maxMessageChars: 8000 },
        streaming: { supported: true, throttleMs: 100, method: "edit" },
        threading: { supported: true, threadType: "native", maxDepth: 5 },
      };

      const plugin: ChannelPluginPort = {
        id: "channel-rich",
        name: "Rich Plugin",
        version: "1.0.0",
        channelType: "rich-channel",
        capabilities: richCaps,
        adapter: createMockAdapter({ channelId: "rich", channelType: "rich-channel" }),
        register: (_api) => ok(undefined),
      };
      channelRegistry.registerChannel(plugin);

      const caps = channelRegistry.getCapabilities("rich-channel");
      expect(caps).toBeDefined();
      expect(caps!.chatTypes).toEqual(["dm", "group", "thread"]);
      expect(caps!.features.editMessages).toBe(true);
      expect(caps!.features.threads).toBe(true);
      expect(caps!.streaming.supported).toBe(true);
      expect(caps!.streaming.method).toBe("edit");
      expect(caps!.threading.supported).toBe(true);
      expect(caps!.threading.threadType).toBe("native");
      expect(caps!.threading.maxDepth).toBe(5);
    });

    it("CWIRE-08: capability-driven feature check: streaming support query", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const streamYes = createMockPlugin({
        channelType: "stream-yes",
        capabilities: {
          chatTypes: ["dm"],
          features: {
            reactions: false, editMessages: false, deleteMessages: false,
            fetchHistory: false, attachments: false, threads: false,
            mentions: false, formatting: [],
          },
          limits: { maxMessageChars: 4096 },
          streaming: { supported: true, throttleMs: 100, method: "edit" },
          threading: { supported: false, threadType: "none" },
        },
      });
      const streamNo = createMockPlugin({
        channelType: "stream-no",
        capabilities: {
          chatTypes: ["dm"],
          features: {
            reactions: false, editMessages: false, deleteMessages: false,
            fetchHistory: false, attachments: false, threads: false,
            mentions: false, formatting: [],
          },
          limits: { maxMessageChars: 4096 },
          streaming: { supported: false, throttleMs: 300, method: "none" },
          threading: { supported: false, threadType: "none" },
        },
      });

      channelRegistry.registerChannel(streamYes);
      channelRegistry.registerChannel(streamNo);

      // Helper function to check streaming support
      function shouldStream(channelType: string): boolean {
        const caps = channelRegistry.getCapabilities(channelType);
        return caps?.streaming.supported === true;
      }

      expect(shouldStream("stream-yes")).toBe(true);
      expect(shouldStream("stream-no")).toBe(false);
      expect(shouldStream("nonexistent")).toBe(false);
    });

    it("CWIRE-09: capability-driven feature check: edit support determines operation availability", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const editable = createMockPlugin({
        channelType: "editable",
        capabilities: {
          chatTypes: ["dm"],
          features: {
            reactions: false, editMessages: true, deleteMessages: false,
            fetchHistory: false, attachments: false, threads: false,
            mentions: false, formatting: [],
          },
          limits: { maxMessageChars: 4096 },
          streaming: { supported: false, throttleMs: 300, method: "none" },
          threading: { supported: false, threadType: "none" },
        },
      });
      const readonly_ = createMockPlugin({
        channelType: "readonly",
        capabilities: {
          chatTypes: ["dm"],
          features: {
            reactions: false, editMessages: false, deleteMessages: false,
            fetchHistory: false, attachments: false, threads: false,
            mentions: false, formatting: [],
          },
          limits: { maxMessageChars: 4096 },
          streaming: { supported: false, throttleMs: 300, method: "none" },
          threading: { supported: false, threadType: "none" },
        },
      });

      channelRegistry.registerChannel(editable);
      channelRegistry.registerChannel(readonly_);

      expect(channelRegistry.getCapabilities("editable")?.features.editMessages).toBe(true);
      expect(channelRegistry.getCapabilities("readonly")?.features.editMessages).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Daemon-level custom adapter E2E (CWIRE-10 through CWIRE-12)
  // -------------------------------------------------------------------------

  describe("Daemon-level custom adapter E2E (CWIRE-10 through CWIRE-12)", () => {
    let handle: TestDaemonHandle;
    let registry: Map<string, ChannelPort>;
    let echoAdapter: EchoChannelAdapter;

    beforeAll(async () => {
      handle = await startTestDaemon({ configPath: customAdapterConfigPath });
      // Access daemon's internal adapter registry (same pattern as messaging-echo.test.ts)
      registry = (handle.daemon as any).adapterRegistry as Map<string, ChannelPort>;
    }, 60_000);

    afterAll(async () => {
      if (handle) {
        try {
          await handle.cleanup();
        } catch (cleanupErr) {
          // Expected: graceful shutdown calls the overridden exit() which throws.
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          if (!msg.includes("Daemon exit with code")) {
            throw cleanupErr;
          }
        }
      }
    }, 30_000);

    it("CWIRE-10: daemon boots successfully and adapter registry is accessible", () => {
      expect(handle).toBeDefined();
      expect(registry).toBeInstanceOf(Map);
      expect(handle.authToken).toBeTruthy();
      expect(typeof handle.authToken).toBe("string");
    });

    it("CWIRE-11: custom EchoChannelAdapter registered on daemon registry is accessible", () => {
      echoAdapter = new EchoChannelAdapter({
        channelId: "custom-e2e",
        channelType: "custom-e2e",
      });
      registry.set("custom-e2e", echoAdapter);

      expect(registry.get("custom-e2e")).toBe(echoAdapter);
      expect(registry.has("custom-e2e")).toBe(true);
    });

    it("CWIRE-12: custom adapter dispatch via registry works for sendMessage and fetchMessages", async () => {
      // Use the adapter registered in CWIRE-11
      const adapter = registry.get("custom-e2e") as EchoChannelAdapter;
      expect(adapter).toBeDefined();

      // Send two messages
      const send1 = await adapter.sendMessage("ch-1", "Hello from custom adapter");
      expect(send1.ok).toBe(true);
      expect(typeof send1.value).toBe("string");

      const send2 = await adapter.sendMessage("ch-1", "Second message");
      expect(send2.ok).toBe(true);
      expect(typeof send2.value).toBe("string");

      // Fetch messages
      const fetched = await adapter.fetchMessages("ch-1");
      expect(fetched.ok).toBe(true);
      expect(Array.isArray(fetched.value)).toBe(true);
      expect(fetched.value!.length).toBe(2);

      // Verify message content
      const texts = fetched.value!.map((m) => m.text);
      expect(texts).toContain("Hello from custom adapter");
      expect(texts).toContain("Second message");
    });
  });
});
