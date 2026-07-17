// SPDX-License-Identifier: Apache-2.0
/**
 * Custom Adapter Wiring & Integration Tests.
 *
 * Package-level integration tests for ChannelManager adapter wiring
 * (combined direct + registry adapter lists, failure isolation, active
 * count tracking) and ChannelRegistry event emission, plus daemon-level
 * E2E tests verifying custom adapter registration and dispatch.
 *
 * Uses port 8504 for daemon-level tests.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChannelRegistry,
  createEchoPlugin,
  EchoChannelAdapter,
  type ChannelRegistry,
} from "@comis/channels";
// createChannelManager + ChannelManagerDeps live in @comis/orchestrator.
import {
  createChannelManager,
  processInboundMessage,
  type ChannelManagerDeps,
} from "@comis/orchestrator";
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
    sendAttachment: vi.fn(async () =>
      ok({ kind: "tracked" as const, messageId: "msg-attach-1" })
    ),
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
    features: {
      reactions: false,
      editMessages: false,
      deleteMessages: false,
      fetchHistory: false,
      attachments: false,
    },
    limits: { maxMessageChars: 4096 },
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
  const eventBus = makeEventBus();
  return {
    eventBus,
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
    // DeliveryService is required on ChannelManagerDeps. The CWIRE suite
    // only exercises startAll() / stopAll() lifecycle, never the inbound
    // pipeline, so the service is fine as a noop stub.
    deliveryService: {
      deliverToChannel: vi.fn(async () => ({ ok: true, value: { ok: true } })) as any,
      drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })) as any,
    } as any,
    // processInboundMessage is dep-injected on ChannelManagerDeps so
    // channels does not back-edge import orchestrator. The CWIRE tests do
    // not invoke it directly — they only assert combined-adapter-list
    // lifecycle — so the real function is a safe choice; nothing
    // observable depends on its return path here.
    processInboundMessage: processInboundMessage as unknown as ChannelManagerDeps["processInboundMessage"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Custom Adapter Wiring & Integration", () => {
  // -------------------------------------------------------------------------
  // ChannelManager combined adapter list
  // -------------------------------------------------------------------------

  describe("ChannelManager combined adapter list", () => {
    it("startAll() starts direct adapters only when no channelRegistry provided", async () => {
      const adapterA = createMockAdapter({ channelId: "a", channelType: "direct-a" });
      const adapterB = createMockAdapter({ channelId: "b", channelType: "direct-b" });
      const deps = makeMinimalDeps({ adapters: [adapterA, adapterB] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(manager.activeCount).toBe(2);
      expect(adapterA.start).toHaveBeenCalled();
      expect(adapterB.start).toHaveBeenCalled();
    });

    it("startAll() starts registry-only adapters when deps.adapters is empty", async () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
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

    it("startAll() builds combined list from both direct adapters and registry plugins", async () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
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

    it("failed adapter start() is logged and skipped, other adapters proceed", async () => {
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
  // ChannelRegistry event emission
  // -------------------------------------------------------------------------

  describe("ChannelRegistry event emission", () => {
    it("channel:registered event fires with correct channelType, pluginId, capabilities, timestamp", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
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

    it("channel:deregistered event fires on unregisterChannel with correct payload", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
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
  // Capability feature negotiation
  // -------------------------------------------------------------------------

  describe("capability feature negotiation", () => {
    it("getCapabilities returns full capability object for registered channel", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const richCaps: ChannelCapability = {
        features: {
          reactions: true,
          editMessages: true,
          deleteMessages: true,
          fetchHistory: true,
          attachments: true,
        },
        limits: { maxMessageChars: 8000 },
        replyToMetaKey: "thread_ts",
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
      expect(caps!.features.editMessages).toBe(true);
      expect(caps!.features.fetchHistory).toBe(true);
      expect(caps!.features.attachments).toBe(true);
      expect(caps!.features.deleteMessages).toBe(true);
      expect(caps!.features.reactions).toBe(true);
      expect(caps!.limits.maxMessageChars).toBe(8000);
      expect(caps!.replyToMetaKey).toBe("thread_ts");
    });

    it("capability-driven feature check: attachment support query", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const attachYes = createMockPlugin({
        channelType: "attach-yes",
        capabilities: {
          features: {
            reactions: false, editMessages: false, deleteMessages: false,
            fetchHistory: false, attachments: true,
          },
          limits: { maxMessageChars: 4096 },
        },
      });
      const attachNo = createMockPlugin({
        channelType: "attach-no",
        capabilities: {
          features: {
            reactions: false, editMessages: false, deleteMessages: false,
            fetchHistory: false, attachments: false,
          },
          limits: { maxMessageChars: 4096 },
        },
      });

      channelRegistry.registerChannel(attachYes);
      channelRegistry.registerChannel(attachNo);

      function supportsAttachments(channelType: string): boolean {
        const caps = channelRegistry.getCapabilities(channelType);
        return caps?.features.attachments === true;
      }

      expect(supportsAttachments("attach-yes")).toBe(true);
      expect(supportsAttachments("attach-no")).toBe(false);
      expect(supportsAttachments("nonexistent")).toBe(false);
    });

    it("capability-driven feature check: edit support determines operation availability", () => {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry();
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });

      const editable = createMockPlugin({
        channelType: "editable",
        capabilities: {
          features: {
            reactions: false, editMessages: true, deleteMessages: false,
            fetchHistory: false, attachments: false,
          },
          limits: { maxMessageChars: 4096 },
        },
      });
      const readonly_ = createMockPlugin({
        channelType: "readonly",
        capabilities: {
          features: {
            reactions: false, editMessages: false, deleteMessages: false,
            fetchHistory: false, attachments: false,
          },
          limits: { maxMessageChars: 4096 },
        },
      });

      channelRegistry.registerChannel(editable);
      channelRegistry.registerChannel(readonly_);

      expect(channelRegistry.getCapabilities("editable")?.features.editMessages).toBe(true);
      expect(channelRegistry.getCapabilities("readonly")?.features.editMessages).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Daemon-level custom adapter E2E
  // -------------------------------------------------------------------------

  describe("Daemon-level custom adapter E2E", () => {
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

    it("daemon boots successfully and adapter registry is accessible", () => {
      expect(handle).toBeDefined();
      expect(registry).toBeInstanceOf(Map);
      expect(handle.authToken).toBeTruthy();
      expect(typeof handle.authToken).toBe("string");
    });

    it("custom EchoChannelAdapter registered on daemon registry is accessible", () => {
      echoAdapter = new EchoChannelAdapter({
        channelId: "custom-e2e",
        channelType: "custom-e2e",
      });
      registry.set("custom-e2e", echoAdapter);

      expect(registry.get("custom-e2e")).toBe(echoAdapter);
      expect(registry.has("custom-e2e")).toBe(true);
    });

    it("custom adapter dispatch via registry works for sendMessage and fetchMessages", async () => {
      // Use the adapter registered in the previous test.
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
