// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type {
  PluginPort,
  PluginRegistryApi,
  RegisteredHook,
} from "../ports/plugin.js";
import type { HookName, HookHandlerMap } from "../ports/hook-types.js";
import type { TypedEventBus } from "../event-bus/index.js";
import { systemNowMs } from "../runtime/system-time.js";

/**
 * The plugin registry manages plugin lifecycle and hook storage.
 *
 * Created via createPluginRegistry(). Plugins register their hooks
 * during bootstrap, and the hook runner reads hooks from this registry
 * during execution.
 */
export interface PluginRegistry {
  /** Register a plugin and collect its hooks. */
  register(plugin: PluginPort): Result<void, Error>;
  /** Remove a plugin and all its hooks. */
  unregister(pluginId: string): Result<void, Error>;
  /** Get hooks for a specific hook name, sorted by priority descending. */
  getHooksByName<K extends HookName>(hookName: K): readonly RegisteredHook<K>[];
  /** Deactivate all registered plugins (calls deactivate() if present). */
  deactivateAll(): Promise<Result<void, Error>>;
}

/**
 * Options for creating a plugin registry.
 */
export interface PluginRegistryOptions {
  /** Event bus for emitting plugin:registered and plugin:deactivated events. */
  eventBus?: TypedEventBus;
}

/**
 * Create a plugin registry that stores plugins and their hooks.
 *
 * Hooks are stored sorted by priority descending (higher priority runs first).
 * The registry provides a PluginRegistryApi facade to each plugin during
 * registration, capturing the plugin ID for each registered hook.
 */
export function createPluginRegistry(options: PluginRegistryOptions = {}): PluginRegistry {
  const { eventBus } = options;
  const plugins = new Map<string, PluginPort>();
  const hooks: RegisteredHook[] = [];

  /**
   * Insert a hook into the sorted hooks array maintaining descending priority order.
   */
  function insertHookSorted(hook: RegisteredHook): void {
    // Find the insertion index to maintain descending priority order
    let insertIndex = hooks.length;
    for (let i = 0; i < hooks.length; i++) {
      if (hooks[i]!.priority < hook.priority) {
        insertIndex = i;
        break;
      }
    }
    hooks.splice(insertIndex, 0, hook);
  }

  /**
   * Create a PluginRegistryApi facade for a specific plugin.
   * Captures the pluginId so hooks are attributed correctly.
   */
  function createApiFacade(pluginId: string): { api: PluginRegistryApi; hookCount: number } {
    let hookCount = 0;

    const api: PluginRegistryApi = {
      registerHook<K extends HookName>(
        hookName: K,
        handler: HookHandlerMap[K],
        handlerOptions?: { priority?: number },
      ): void {
        const priority = handlerOptions?.priority ?? 0;
        const registeredHook: RegisteredHook<K> = {
          pluginId,
          hookName,
          handler,
          priority,
        };
        insertHookSorted(registeredHook as RegisteredHook);
        hookCount++;
      },
    };

    return {
      api,
      get hookCount() {
        return hookCount;
      },
    };
  }

  return {
    register(plugin: PluginPort): Result<void, Error> {
      if (!plugin.id) {
        return err(new Error("Plugin must have a non-empty id"));
      }

      if (plugins.has(plugin.id)) {
        return err(new Error(`Plugin already registered: ${plugin.id}`));
      }

      // Create facade and let the plugin register its hooks
      const facade = createApiFacade(plugin.id);
      let registerResult: Result<void, Error>;
      try {
        registerResult = plugin.register(facade.api);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
      if (!registerResult.ok) {
        return registerResult;
      }

      plugins.set(plugin.id, plugin);

      // Emit plugin:registered event
      if (eventBus) {
        eventBus.emit("plugin:registered", {
          pluginId: plugin.id,
          pluginName: plugin.name,
          hookCount: facade.hookCount,
          timestamp: systemNowMs(),
        });
      }

      return ok(undefined);
    },

    unregister(pluginId: string): Result<void, Error> {
      if (!plugins.has(pluginId)) {
        return err(new Error(`Plugin not registered: ${pluginId}`));
      }

      plugins.delete(pluginId);

      // Remove all hooks for this plugin
      for (let i = hooks.length - 1; i >= 0; i--) {
        if (hooks[i]!.pluginId === pluginId) {
          hooks.splice(i, 1);
        }
      }

      return ok(undefined);
    },

    getHooksByName<K extends HookName>(hookName: K): readonly RegisteredHook<K>[] {
      return hooks.filter(
        (h): h is RegisteredHook<K> => h.hookName === hookName,
      );
    },

    async deactivateAll(): Promise<Result<void, Error>> {
      const errors: string[] = [];

      for (const plugin of plugins.values()) {
        if (plugin.deactivate) {
          const result = await plugin.deactivate();
          if (!result.ok) {
            errors.push(`${plugin.id}: ${result.error.message}`);
          }
        }

        // Emit plugin:deactivated event
        if (eventBus) {
          eventBus.emit("plugin:deactivated", {
            pluginId: plugin.id,
            reason: "shutdown",
            timestamp: systemNowMs(),
          });
        }
      }

      if (errors.length > 0) {
        return err(new Error(`Plugin deactivation errors: ${errors.join("; ")}`));
      }

      return ok(undefined);
    },
  };
}
