// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { EventMap } from "@comis/core";
import { TypedEventBus, createPluginRegistry } from "@comis/core";
import { createChannelRegistry } from "./channel-registry.js";
import { createEchoPlugin } from "../echo/echo-plugin.js";

describe("channel plugin integration", () => {
  function setup() {
    const eventBus = new TypedEventBus();
    const pluginRegistry = createPluginRegistry();
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
      expect(caps?.features.reactions).toBe(false);
      expect(caps?.limits.maxMessageChars).toBe(10000);
      expect(caps?.features.attachments).toBe(false);

      // Verify channel type is listed
      expect(channelRegistry.getChannelTypes()).toContain("echo");
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
  // Event integration
  // ---------------------------------------------------------------------------

  describe("event integration", () => {
    it("channel:registered fires on registration", () => {
      const { eventBus, channelRegistry } = setup();

      const channelEvents: EventMap["channel:registered"][] = [];
      eventBus.on("channel:registered", (e) => channelEvents.push(e));

      const echoPlugin = createEchoPlugin();
      channelRegistry.registerChannel(echoPlugin);

      // channel:registered event
      expect(channelEvents).toHaveLength(1);
      expect(channelEvents[0]!.channelType).toBe("echo");
      expect(channelEvents[0]!.pluginId).toBe("channel-echo");
      expect(channelEvents[0]!.capabilities.limits.maxMessageChars).toBe(10000);
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
    it("echo plugin capabilities expose maxMessageChars for size enforcement", () => {
      const { channelRegistry } = setup();
      const echoPlugin = createEchoPlugin();

      channelRegistry.registerChannel(echoPlugin);

      const caps = channelRegistry.getCapabilities("echo");
      expect(caps).toBeDefined();
      expect(caps!.limits.maxMessageChars).toBeGreaterThan(0);

      // A helper function that uses capabilities to decide message-size policy
      function maxCharsFor(channelType: string): number {
        const channelCaps = channelRegistry.getCapabilities(channelType);
        return channelCaps?.limits.maxMessageChars ?? 0;
      }

      expect(maxCharsFor("echo")).toBeGreaterThan(0);
      expect(maxCharsFor("nonexistent")).toBe(0);
    });
  });
});
