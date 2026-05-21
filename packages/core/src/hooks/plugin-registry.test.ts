// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { PluginPort, PluginRegistryApi } from "../ports/plugin.js";
import { createPluginRegistry } from "./plugin-registry.js";

/**
 * Create a minimal test plugin with sensible defaults.
 * Overrides allow customizing any field for specific test scenarios.
 */
function createTestPlugin(overrides: Partial<PluginPort> & { id: string }): PluginPort {
  return {
    name: overrides.name ?? `test-plugin-${overrides.id}`,
    register: overrides.register ?? ((_api: PluginRegistryApi) => ok(undefined)),
    ...overrides,
  };
}

describe("PluginRegistry", () => {
  // ─── Registration ───────────────────────────────────────────────

  describe("registration", () => {
    it("registers a plugin and returns ok result", () => {
      const registry = createPluginRegistry();
      const plugin = createTestPlugin({ id: "alpha" });

      const result = registry.register(plugin);

      expect(result.ok).toBe(true);
    });

    it("rejects duplicate plugin ID with err result", () => {
      const registry = createPluginRegistry();
      const plugin1 = createTestPlugin({ id: "alpha" });
      const plugin2 = createTestPlugin({ id: "alpha", name: "another-alpha" });

      registry.register(plugin1);
      const result = registry.register(plugin2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("already registered");
      }
    });

    it("stores hooks registered by plugin via PluginRegistryApi", () => {
      const registry = createPluginRegistry();
      const plugin = createTestPlugin({
        id: "hook-plugin",
        register: (api) => {
          api.registerHook("before_agent_start", () => ({ systemPrompt: "test" }));
          api.registerHook("session_start", () => {});
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const beforeHooks = registry.getHooksByName("before_agent_start");
      const sessionHooks = registry.getHooksByName("session_start");
      expect(beforeHooks).toHaveLength(1);
      expect(sessionHooks).toHaveLength(1);
      expect(beforeHooks[0]!.pluginId).toBe("hook-plugin");
    });
  });

  // ─── Hook Storage and Priority ──────────────────────────────────

  describe("hook storage and priority", () => {
    it("hooks are sorted by priority descending (higher first)", () => {
      const registry = createPluginRegistry();

      const pluginLow = createTestPlugin({
        id: "low",
        register: (api) => {
          api.registerHook("before_agent_start", () => ({ systemPrompt: "low" }), { priority: 5 });
          return ok(undefined);
        },
      });

      const pluginHigh = createTestPlugin({
        id: "high",
        register: (api) => {
          api.registerHook("before_agent_start", () => ({ systemPrompt: "high" }), {
            priority: 50,
          });
          return ok(undefined);
        },
      });

      // Register low first, then high
      registry.register(pluginLow);
      registry.register(pluginHigh);

      const hooks = registry.getHooksByName("before_agent_start");
      expect(hooks).toHaveLength(2);
      expect(hooks[0]!.pluginId).toBe("high");
      expect(hooks[1]!.pluginId).toBe("low");
    });

    it("hooks with same priority maintain insertion order", () => {
      const registry = createPluginRegistry();

      const pluginA = createTestPlugin({
        id: "a",
        register: (api) => {
          api.registerHook("session_start", () => {}, { priority: 10 });
          return ok(undefined);
        },
      });

      const pluginB = createTestPlugin({
        id: "b",
        register: (api) => {
          api.registerHook("session_start", () => {}, { priority: 10 });
          return ok(undefined);
        },
      });

      registry.register(pluginA);
      registry.register(pluginB);

      const hooks = registry.getHooksByName("session_start");
      expect(hooks).toHaveLength(2);
      expect(hooks[0]!.pluginId).toBe("a");
      expect(hooks[1]!.pluginId).toBe("b");
    });

    it("default priority is 0 when not specified", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "default-pri",
        register: (api) => {
          api.registerHook("session_start", () => {});
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const hooks = registry.getHooksByName("session_start");
      expect(hooks[0]!.priority).toBe(0);
    });

    it("getHooksByName() returns only hooks for requested hook name", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "multi-hook",
        register: (api) => {
          api.registerHook("before_agent_start", () => ({ systemPrompt: "x" }));
          api.registerHook("session_start", () => {});
          api.registerHook("session_end", () => {});
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const beforeHooks = registry.getHooksByName("before_agent_start");
      const startHooks = registry.getHooksByName("session_start");
      expect(beforeHooks).toHaveLength(1);
      expect(beforeHooks[0]!.hookName).toBe("before_agent_start");
      expect(startHooks).toHaveLength(1);
      expect(startHooks[0]!.hookName).toBe("session_start");
    });

    it("getHooksByName() returns empty array for hook with no registrations", () => {
      const registry = createPluginRegistry();

      const hooks = registry.getHooksByName("gateway_start");

      expect(hooks).toEqual([]);
    });
  });

  // ─── Unregistration ─────────────────────────────────────────────

  describe("unregistration", () => {
    it("unregister() removes plugin and its hooks", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "removable",
        register: (api) => {
          api.registerHook("session_start", () => {});
          api.registerHook("before_agent_start", () => ({ systemPrompt: "x" }));
          return ok(undefined);
        },
      });

      registry.register(plugin);
      expect(registry.getHooksByName("session_start")).toHaveLength(1);

      const result = registry.unregister("removable");

      expect(result.ok).toBe(true);
      expect(registry.getHooksByName("session_start")).toHaveLength(0);
      expect(registry.getHooksByName("before_agent_start")).toHaveLength(0);
    });

    it("unregister() returns err for unknown plugin ID", () => {
      const registry = createPluginRegistry();

      const result = registry.unregister("ghost");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not registered");
      }
    });
  });

  // ─── Deactivation ───────────────────────────────────────────────

  describe("deactivation", () => {
    it("deactivateAll() calls deactivate() on all plugins", async () => {
      const registry = createPluginRegistry();
      const deactivateFn = vi.fn(async () => ok(undefined));

      const plugin = createTestPlugin({
        id: "deactivatable",
        deactivate: deactivateFn,
      });

      registry.register(plugin);
      const result = await registry.deactivateAll();

      expect(result.ok).toBe(true);
      expect(deactivateFn).toHaveBeenCalledOnce();
    });

    it("deactivateAll() skips plugins without deactivate method", async () => {
      const registry = createPluginRegistry();

      const pluginWithout = createTestPlugin({
        id: "no-deactivate",
      });

      registry.register(pluginWithout);

      const result = await registry.deactivateAll();

      expect(result.ok).toBe(true);
    });
  });
});
