// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { HookName, HookHandlerMap } from "./hook-types.js";

/**
 * PluginPort: The hexagonal architecture boundary for plugin extensions.
 *
 * Plugins implement this interface to register lifecycle hooks with the
 * plugin registry. Each plugin has a unique ID, a human-readable name,
 * and an optional version string.
 *
 * Lifecycle:
 * 1. register() — Called during bootstrap, plugin registers its hooks
 * 2. activate() — Optional async initialization (e.g. connect to external service)
 * 3. deactivate() — Optional async cleanup (e.g. close connections)
 */
export interface PluginPort {
  /** Unique plugin identifier (e.g. "webhook-forwarder", "audit-logger") */
  readonly id: string;
  /** Human-readable plugin name */
  readonly name: string;
  /** Optional semantic version string */
  readonly version?: string;

  /**
   * Register this plugin's hooks with the registry.
   * Called synchronously during bootstrap.
   */
  register(registry: PluginRegistryApi): Result<void, Error>;

  /**
   * Optional async activation after all plugins are registered.
   * Use for connecting to external services, warming caches, etc.
   */
  activate?(): Promise<Result<void, Error>>;

  /**
   * Optional async deactivation during shutdown.
   * Use for closing connections, flushing buffers, etc.
   */
  deactivate?(): Promise<Result<void, Error>>;
}

/**
 * API exposed to plugins during registration.
 *
 * Provides a type-safe way for plugins to register hook handlers with
 * optional priority ordering. `registerHook` is deliberately the only
 * registration entrypoint — there are no tool / HTTP route / config-schema
 * registration surfaces (they would have zero in-tree callers).
 */
export interface PluginRegistryApi {
  /**
   * Register a hook handler for a specific lifecycle point.
   *
   * @param hookName - The lifecycle hook to attach to
   * @param handler - The typed handler function
   * @param options - Optional priority (higher runs first, default 0, range -100 to 100)
   */
  registerHook<K extends HookName>(
    hookName: K,
    handler: HookHandlerMap[K],
    options?: { priority?: number },
  ): void;
}

/**
 * Internal representation of a registered hook handler.
 *
 * Stored by the plugin registry and consumed by the hook runner.
 * Hooks are sorted by priority descending (higher priority runs first).
 */
export interface RegisteredHook<K extends HookName = HookName> {
  readonly pluginId: string;
  readonly hookName: K;
  readonly handler: HookHandlerMap[K];
  readonly priority: number;
}
