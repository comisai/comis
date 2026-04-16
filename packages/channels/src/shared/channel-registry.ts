import type { Result } from "@comis/shared";
import { ok, err, tryCatch } from "@comis/shared";
import type {
  ChannelPluginPort,
  ChannelCapability,
  ChannelPort,
} from "@comis/core";
import { ChannelCapabilitySchema } from "@comis/core";
import type { PluginRegistry } from "@comis/core";
import type { TypedEventBus } from "@comis/core";

/**
 * ChannelRegistry: Channel-specific registry wrapping PluginRegistry.
 *
 * Provides channel-aware registration, lookup by channelType, and
 * capability querying. Delegates plugin lifecycle (hooks, activate,
 * deactivate) to the underlying PluginRegistry.
 */
export interface ChannelRegistry {
  /** Register a channel plugin, validating capabilities and delegating to PluginRegistry. */
  registerChannel(plugin: ChannelPluginPort): Result<void, Error>;
  /** Unregister a channel by type, removing from both channel map and PluginRegistry. */
  unregisterChannel(channelType: string): Result<void, Error>;
  /** Get the channel adapter for a given channel type. */
  getAdapter(channelType: string): ChannelPort | undefined;
  /** Get the declared capabilities for a given channel type. */
  getCapabilities(channelType: string): ChannelCapability | undefined;
  /** Get all registered channel type strings. */
  getChannelTypes(): readonly string[];
  /** Get all registered channel plugins. */
  getChannelPlugins(): readonly ChannelPluginPort[];
}

/**
 * Options for creating a ChannelRegistry.
 */
export interface ChannelRegistryOptions {
  /** The plugin registry to delegate lifecycle management to. */
  pluginRegistry: PluginRegistry;
  /** Optional event bus for emitting channel:registered/deregistered events. */
  eventBus?: TypedEventBus;
}

/**
 * Create a ChannelRegistry that wraps PluginRegistry with channel-specific
 * registration, capability validation, and lookup by channelType.
 *
 * Registration flow:
 * 1. Check for duplicate channelType
 * 2. Validate capabilities with ChannelCapabilitySchema
 * 3. Delegate to pluginRegistry.register()
 * 4. Store in internal channel map
 * 5. Emit channel:registered event
 */
export function createChannelRegistry(options: ChannelRegistryOptions): ChannelRegistry {
  const { pluginRegistry, eventBus } = options;
  const channels = new Map<string, ChannelPluginPort>();

  return {
    registerChannel(plugin: ChannelPluginPort): Result<void, Error> {
      // Check for duplicate channelType
      if (channels.has(plugin.channelType)) {
        return err(new Error(`Channel type already registered: ${plugin.channelType}`));
      }

      // Validate capabilities with Zod schema
      const validationResult = tryCatch(() =>
        ChannelCapabilitySchema.parse(plugin.capabilities),
      );
      if (!validationResult.ok) {
        return err(
          new Error(`Invalid capabilities for channel "${plugin.channelType}": ${validationResult.error.message}`),
        );
      }

      // Delegate to plugin registry for hook registration and lifecycle
      const registerResult = pluginRegistry.register(plugin);
      if (!registerResult.ok) {
        return registerResult;
      }

      // Store in channel map
      channels.set(plugin.channelType, plugin);

      // Emit channel:registered event
      if (eventBus) {
        eventBus.emit("channel:registered", {
          channelType: plugin.channelType,
          pluginId: plugin.id,
          capabilities: plugin.capabilities,
          timestamp: Date.now(),
        });
      }

      return ok(undefined);
    },

    unregisterChannel(channelType: string): Result<void, Error> {
      const plugin = channels.get(channelType);
      if (!plugin) {
        return err(new Error(`Channel type not registered: ${channelType}`));
      }

      // Delegate to plugin registry for hook removal
      const unregisterResult = pluginRegistry.unregister(plugin.id);
      if (!unregisterResult.ok) {
        return unregisterResult;
      }

      // Remove from channel map
      channels.delete(channelType);

      // Emit channel:deregistered event
      if (eventBus) {
        eventBus.emit("channel:deregistered", {
          channelType,
          pluginId: plugin.id,
          timestamp: Date.now(),
        });
      }

      return ok(undefined);
    },

    getAdapter(channelType: string): ChannelPort | undefined {
      return channels.get(channelType)?.adapter;
    },

    getCapabilities(channelType: string): ChannelCapability | undefined {
      return channels.get(channelType)?.capabilities;
    },

    getChannelTypes(): readonly string[] {
      return Array.from(channels.keys());
    },

    getChannelPlugins(): readonly ChannelPluginPort[] {
      return Array.from(channels.values());
    },
  };
}
