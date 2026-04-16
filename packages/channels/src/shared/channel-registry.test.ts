import { describe, it, expect } from "vitest";
import { ok } from "@comis/shared";
import type {
  ChannelPluginPort,
  ChannelCapability,
  ChannelPort,
  PluginRegistryApi,
  EventMap,
} from "@comis/core";
import { TypedEventBus, createPluginRegistry } from "@comis/core";
import { createChannelRegistry } from "./channel-registry.js";

/**
 * Create a minimal mock ChannelPort adapter for testing.
 * All methods return ok(undefined) or appropriate defaults.
 */
function createMockAdapter(
  overrides: Partial<ChannelPort> & { channelId: string; channelType: string },
): ChannelPort {
  return {
    channelId: overrides.channelId,
    channelType: overrides.channelType,
    start: overrides.start ?? (async () => ok(undefined)),
    stop: overrides.stop ?? (async () => ok(undefined)),
    sendMessage: overrides.sendMessage ?? (async () => ok("mock-msg-id")),
    editMessage: overrides.editMessage ?? (async () => ok(undefined)),
    onMessage: overrides.onMessage ?? (() => {}),
    reactToMessage: overrides.reactToMessage ?? (async () => ok(undefined)),
    deleteMessage: overrides.deleteMessage ?? (async () => ok(undefined)),
    fetchMessages: overrides.fetchMessages ?? (async () => ok([])),
    sendAttachment: overrides.sendAttachment ?? (async () => ok("mock-attach-id")),
    platformAction: overrides.platformAction ?? (async () => ok({ echoed: true })),
  };
}

/**
 * Create a minimal ChannelPluginPort for testing.
 * Uses a mock adapter and valid default capabilities.
 */
function createTestChannelPlugin(
  overrides: Partial<ChannelPluginPort> & { channelType: string },
): ChannelPluginPort {
  const channelType = overrides.channelType;
  const adapter = overrides.adapter ??
    createMockAdapter({ channelId: `${channelType}-test`, channelType });

  const capabilities: ChannelCapability = overrides.capabilities ?? {
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
      buttons: false,
      cards: false,
      effects: false,
    },
    limits: {
      maxMessageChars: 4096,
    },
    streaming: {
      supported: false,
      throttleMs: 300,
      method: "none",
    },
    threading: {
      supported: false,
      threadType: "none",
    },
  };

  return {
    id: overrides.id ?? `channel-${channelType}`,
    name: overrides.name ?? `${channelType} Channel Plugin`,
    version: overrides.version ?? "1.0.0",
    channelType,
    capabilities,
    adapter,
    register: overrides.register ?? ((_api: PluginRegistryApi) => ok(undefined)),
    activate: overrides.activate,
    deactivate: overrides.deactivate,
  };
}

describe("channel-registry", () => {
  function setup() {
    const eventBus = new TypedEventBus();
    const pluginRegistry = createPluginRegistry({ eventBus });
    const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });
    return { eventBus, pluginRegistry, channelRegistry };
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe("registration", () => {
    it("registers a channel plugin successfully", () => {
      const { channelRegistry } = setup();
      const plugin = createTestChannelPlugin({ channelType: "telegram" });

      const result = channelRegistry.registerChannel(plugin);

      expect(result.ok).toBe(true);
    });

    it("rejects duplicate channel type registration", () => {
      const { channelRegistry } = setup();
      const plugin1 = createTestChannelPlugin({
        channelType: "telegram",
        id: "channel-telegram-1",
      });
      const plugin2 = createTestChannelPlugin({
        channelType: "telegram",
        id: "channel-telegram-2",
      });

      channelRegistry.registerChannel(plugin1);
      const result = channelRegistry.registerChannel(plugin2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("already registered");
        expect(result.error.message).toContain("telegram");
      }
    });

    it("rejects plugin with invalid capabilities (missing maxMessageChars)", () => {
      const { channelRegistry } = setup();
      const plugin = createTestChannelPlugin({
        channelType: "broken",
        // Force invalid capabilities -- missing required limits.maxMessageChars
        capabilities: {
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
            buttons: false,
            cards: false,
            effects: false,
          },
          limits: {} as ChannelCapability["limits"], // missing maxMessageChars
          streaming: {
            supported: false,
            throttleMs: 300,
            method: "none",
          },
          threading: {
            supported: false,
            threadType: "none",
          },
        },
      });

      const result = channelRegistry.registerChannel(plugin);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid capabilities");
        expect(result.error.message).toContain("broken");
      }
    });

    it("registers multiple channel plugins with different channel types", () => {
      const { channelRegistry } = setup();
      const telegram = createTestChannelPlugin({ channelType: "telegram" });
      const discord = createTestChannelPlugin({ channelType: "discord" });
      const slack = createTestChannelPlugin({ channelType: "slack" });

      expect(channelRegistry.registerChannel(telegram).ok).toBe(true);
      expect(channelRegistry.registerChannel(discord).ok).toBe(true);
      expect(channelRegistry.registerChannel(slack).ok).toBe(true);

      expect(channelRegistry.getChannelTypes()).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  describe("lookup", () => {
    it("getAdapter() returns the adapter for a registered channel type", () => {
      const { channelRegistry } = setup();
      const mockAdapter = createMockAdapter({
        channelId: "tg-1",
        channelType: "telegram",
      });
      const plugin = createTestChannelPlugin({
        channelType: "telegram",
        adapter: mockAdapter,
      });

      channelRegistry.registerChannel(plugin);
      const adapter = channelRegistry.getAdapter("telegram");

      expect(adapter).toBe(mockAdapter);
      expect(adapter?.channelId).toBe("tg-1");
    });

    it("getAdapter() returns undefined for unregistered channel type", () => {
      const { channelRegistry } = setup();

      expect(channelRegistry.getAdapter("nonexistent")).toBeUndefined();
    });

    it("getCapabilities() returns capabilities for a registered channel type", () => {
      const { channelRegistry } = setup();
      const plugin = createTestChannelPlugin({ channelType: "discord" });

      channelRegistry.registerChannel(plugin);
      const caps = channelRegistry.getCapabilities("discord");

      expect(caps).toBeDefined();
      expect(caps?.chatTypes).toContain("dm");
      expect(caps?.limits.maxMessageChars).toBe(4096);
    });

    it("getCapabilities() returns undefined for unregistered channel type", () => {
      const { channelRegistry } = setup();

      expect(channelRegistry.getCapabilities("nonexistent")).toBeUndefined();
    });

    it("getChannelTypes() returns all registered channel type strings", () => {
      const { channelRegistry } = setup();
      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "telegram" }),
      );
      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "discord" }),
      );

      const types = channelRegistry.getChannelTypes();

      expect(types).toContain("telegram");
      expect(types).toContain("discord");
      expect(types).toHaveLength(2);
    });

    it("getChannelPlugins() returns all registered channel plugins", () => {
      const { channelRegistry } = setup();
      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "telegram" }),
      );
      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "discord" }),
      );

      const plugins = channelRegistry.getChannelPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins.map((p) => p.channelType)).toEqual(
        expect.arrayContaining(["telegram", "discord"]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Unregistration
  // ---------------------------------------------------------------------------

  describe("unregistration", () => {
    it("unregisters a channel plugin successfully", () => {
      const { channelRegistry } = setup();
      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "telegram" }),
      );

      const result = channelRegistry.unregisterChannel("telegram");

      expect(result.ok).toBe(true);
    });

    it("after unregistration, getAdapter() returns undefined", () => {
      const { channelRegistry } = setup();
      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "telegram" }),
      );

      channelRegistry.unregisterChannel("telegram");

      expect(channelRegistry.getAdapter("telegram")).toBeUndefined();
      expect(channelRegistry.getChannelTypes()).toHaveLength(0);
    });

    it("unregistering a non-existent channel type returns error", () => {
      const { channelRegistry } = setup();

      const result = channelRegistry.unregisterChannel("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not registered");
        expect(result.error.message).toContain("nonexistent");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  describe("event emission", () => {
    it("channel:registered event fires on successful registration", () => {
      const { eventBus, channelRegistry } = setup();
      const events: EventMap["channel:registered"][] = [];
      eventBus.on("channel:registered", (e) => events.push(e));

      const plugin = createTestChannelPlugin({ channelType: "telegram" });
      channelRegistry.registerChannel(plugin);

      expect(events).toHaveLength(1);
      expect(events[0]!.channelType).toBe("telegram");
      expect(events[0]!.pluginId).toBe("channel-telegram");
      expect(events[0]!.capabilities).toBeDefined();
      expect(events[0]!.capabilities.limits.maxMessageChars).toBe(4096);
      expect(events[0]!.timestamp).toBeGreaterThan(0);
    });

    it("channel:deregistered event fires on unregistration", () => {
      const { eventBus, channelRegistry } = setup();
      const events: EventMap["channel:deregistered"][] = [];
      eventBus.on("channel:deregistered", (e) => events.push(e));

      channelRegistry.registerChannel(
        createTestChannelPlugin({ channelType: "telegram" }),
      );
      channelRegistry.unregisterChannel("telegram");

      expect(events).toHaveLength(1);
      expect(events[0]!.channelType).toBe("telegram");
      expect(events[0]!.pluginId).toBe("channel-telegram");
      expect(events[0]!.timestamp).toBeGreaterThan(0);
    });
  });
});
