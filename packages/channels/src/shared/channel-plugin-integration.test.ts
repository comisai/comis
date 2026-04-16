import { describe, it, expect } from "vitest";
import type { EventMap } from "@comis/core";
import { TypedEventBus, createPluginRegistry } from "@comis/core";
import { createChannelRegistry } from "./channel-registry.js";
import { createEchoPlugin } from "../echo/echo-plugin.js";
import { EchoChannelAdapter } from "../echo/echo-adapter.js";

describe("channel plugin integration", () => {
  function setup() {
    const eventBus = new TypedEventBus();
    const pluginRegistry = createPluginRegistry({ eventBus });
    const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });
    return { eventBus, pluginRegistry, channelRegistry };
  }

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("register -> getAdapter -> getCapabilities -> getChannelTypes", () => {
      const { channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();

      const result = channelRegistry.registerChannel(echoPlugin);
      expect(result.ok).toBe(true);

      // Verify adapter is accessible
      const adapter = channelRegistry.getAdapter("echo");
      expect(adapter).toBeDefined();
      expect(adapter).toBe(echoPlugin.adapter);
      expect(adapter?.channelType).toBe("echo");

      // Verify capabilities are accessible
      const caps = channelRegistry.getCapabilities("echo");
      expect(caps).toBeDefined();
      expect(caps?.chatTypes).toContain("dm");
      expect(caps?.limits.maxMessageChars).toBe(10000);
      expect(caps?.streaming.supported).toBe(false);

      // Verify channel type is listed
      expect(channelRegistry.getChannelTypes()).toContain("echo");
    });

    it("register -> activate -> start() called -> deactivate -> stop() called", async () => {
      const { pluginRegistry, channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();
      const echoAdapter = echoPlugin.adapter as EchoChannelAdapter;

      // Register
      channelRegistry.registerChannel(echoPlugin);

      // Activate via plugin registry
      expect(echoAdapter.isRunning()).toBe(false);
      const activateResult = await pluginRegistry.activateAll();
      expect(activateResult.ok).toBe(true);
      expect(echoAdapter.isRunning()).toBe(true);

      // Deactivate via plugin registry
      const deactivateResult = await pluginRegistry.deactivateAll();
      expect(deactivateResult.ok).toBe(true);
      expect(echoAdapter.isRunning()).toBe(false);
    });

    it("registers two different channel plugins and both are accessible", () => {
      const { channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();
      const echo2Plugin = createEchoPlugin({
        channelId: "echo2-test",
        channelType: "echo2",
      });
      // Override the channelType and id since createEchoPlugin uses fixed values
      const echo2Wrapper = {
        ...echo2Plugin,
        id: "channel-echo2",
        channelType: "echo2",
      };

      channelRegistry.registerChannel(echoPlugin);
      channelRegistry.registerChannel(echo2Wrapper);

      expect(channelRegistry.getAdapter("echo")).toBe(echoPlugin.adapter);
      expect(channelRegistry.getAdapter("echo2")).toBe(echo2Wrapper.adapter);
      expect(channelRegistry.getChannelTypes()).toHaveLength(2);
      expect(channelRegistry.getChannelTypes()).toEqual(
        expect.arrayContaining(["echo", "echo2"]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Plugin-registry integration (delegation)
  // ---------------------------------------------------------------------------

  describe("plugin-registry integration", () => {
    it("channel plugin appears in pluginRegistry.getPlugins() after registration", () => {
      const { pluginRegistry, channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();

      channelRegistry.registerChannel(echoPlugin);

      const plugins = pluginRegistry.getPlugins();
      expect(plugins.some((p) => p.id === "channel-echo")).toBe(true);
    });

    it("channel plugin removed from pluginRegistry after unregistration", () => {
      const { pluginRegistry, channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();

      channelRegistry.registerChannel(echoPlugin);
      expect(pluginRegistry.getPlugin("channel-echo")).toBeDefined();

      channelRegistry.unregisterChannel("echo");
      expect(pluginRegistry.getPlugin("channel-echo")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Event integration
  // ---------------------------------------------------------------------------

  describe("event integration", () => {
    it("channel:registered and plugin:registered both fire on registration", () => {
      const { eventBus, channelRegistry } = setup();

      const channelEvents: EventMap["channel:registered"][] = [];
      const pluginEvents: EventMap["plugin:registered"][] = [];
      eventBus.on("channel:registered", (e) => channelEvents.push(e));
      eventBus.on("plugin:registered", (e) => pluginEvents.push(e));

      const echoPlugin = createEchoPlugin();
      channelRegistry.registerChannel(echoPlugin);

      // channel:registered event
      expect(channelEvents).toHaveLength(1);
      expect(channelEvents[0]!.channelType).toBe("echo");
      expect(channelEvents[0]!.pluginId).toBe("channel-echo");
      expect(channelEvents[0]!.capabilities.limits.maxMessageChars).toBe(10000);

      // plugin:registered event (from PluginRegistry delegation)
      expect(pluginEvents).toHaveLength(1);
      expect(pluginEvents[0]!.pluginId).toBe("channel-echo");
      expect(pluginEvents[0]!.pluginName).toBe("Echo Channel Plugin");
    });

    it("channel:deregistered fires on unregistration", () => {
      const { eventBus, channelRegistry } = setup();

      const channelDeregEvents: EventMap["channel:deregistered"][] = [];
      eventBus.on("channel:deregistered", (e) => channelDeregEvents.push(e));

      const echoPlugin = createEchoPlugin();
      channelRegistry.registerChannel(echoPlugin);
      channelRegistry.unregisterChannel("echo");

      expect(channelDeregEvents).toHaveLength(1);
      expect(channelDeregEvents[0]!.channelType).toBe("echo");
      expect(channelDeregEvents[0]!.pluginId).toBe("channel-echo");
    });
  });

  // ---------------------------------------------------------------------------
  // Capability-driven behavior
  // ---------------------------------------------------------------------------

  describe("capability-driven behavior", () => {
    it("echo plugin capabilities indicate streaming not supported", () => {
      const { channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();

      channelRegistry.registerChannel(echoPlugin);

      const caps = channelRegistry.getCapabilities("echo");
      expect(caps).toBeDefined();
      expect(caps!.streaming.supported).toBe(false);

      // A helper function that uses capabilities to decide streaming behavior
      function shouldUseStreaming(channelType: string): boolean {
        const channelCaps = channelRegistry.getCapabilities(channelType);
        return channelCaps?.streaming.supported === true;
      }

      expect(shouldUseStreaming("echo")).toBe(false);
      expect(shouldUseStreaming("nonexistent")).toBe(false);
    });
  });
});
