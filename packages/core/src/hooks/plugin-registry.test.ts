import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { z } from "zod";
import type { PluginPort, PluginRegistryApi } from "../ports/plugin.js";
import { TypedEventBus } from "../event-bus/index.js";
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
          api.registerHook("agent_end", () => {});
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const beforeHooks = registry.getHooksByName("before_agent_start");
      const endHooks = registry.getHooksByName("agent_end");
      expect(beforeHooks).toHaveLength(1);
      expect(endHooks).toHaveLength(1);
      expect(beforeHooks[0]!.pluginId).toBe("hook-plugin");
    });

    it("getPlugin() returns registered plugin by ID", () => {
      const registry = createPluginRegistry();
      const plugin = createTestPlugin({ id: "lookup-test" });

      registry.register(plugin);

      const found = registry.getPlugin("lookup-test");
      expect(found).toBe(plugin);
    });

    it("getPlugin() returns undefined for unknown ID", () => {
      const registry = createPluginRegistry();

      const found = registry.getPlugin("nonexistent");

      expect(found).toBeUndefined();
    });

    it("getPlugins() returns all registered plugins", () => {
      const registry = createPluginRegistry();
      const p1 = createTestPlugin({ id: "first" });
      const p2 = createTestPlugin({ id: "second" });
      const p3 = createTestPlugin({ id: "third" });

      registry.register(p1);
      registry.register(p2);
      registry.register(p3);

      const all = registry.getPlugins();
      expect(all).toHaveLength(3);
      expect(all.map((p) => p.id)).toEqual(["first", "second", "third"]);
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
          api.registerHook("agent_end", () => {}, { priority: 10 });
          return ok(undefined);
        },
      });

      const pluginB = createTestPlugin({
        id: "b",
        register: (api) => {
          api.registerHook("agent_end", () => {}, { priority: 10 });
          return ok(undefined);
        },
      });

      registry.register(pluginA);
      registry.register(pluginB);

      const hooks = registry.getHooksByName("agent_end");
      expect(hooks).toHaveLength(2);
      expect(hooks[0]!.pluginId).toBe("a");
      expect(hooks[1]!.pluginId).toBe("b");
    });

    it("default priority is 0 when not specified", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "default-pri",
        register: (api) => {
          api.registerHook("agent_end", () => {});
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const hooks = registry.getHooksByName("agent_end");
      expect(hooks[0]!.priority).toBe(0);
    });

    it("getHooksByName() returns only hooks for requested hook name", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "multi-hook",
        register: (api) => {
          api.registerHook("before_agent_start", () => ({ systemPrompt: "x" }));
          api.registerHook("agent_end", () => {});
          api.registerHook("before_tool_call", () => ({}));
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const beforeHooks = registry.getHooksByName("before_agent_start");
      const endHooks = registry.getHooksByName("agent_end");
      expect(beforeHooks).toHaveLength(1);
      expect(beforeHooks[0]!.hookName).toBe("before_agent_start");
      expect(endHooks).toHaveLength(1);
      expect(endHooks[0]!.hookName).toBe("agent_end");
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
          api.registerHook("agent_end", () => {});
          api.registerHook("before_agent_start", () => ({ systemPrompt: "x" }));
          return ok(undefined);
        },
      });

      registry.register(plugin);
      expect(registry.getPlugin("removable")).toBeDefined();
      expect(registry.getHooksByName("agent_end")).toHaveLength(1);

      const result = registry.unregister("removable");

      expect(result.ok).toBe(true);
      expect(registry.getPlugin("removable")).toBeUndefined();
      expect(registry.getHooksByName("agent_end")).toHaveLength(0);
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

  // ─── Activation / Deactivation ──────────────────────────────────

  describe("activation / deactivation", () => {
    it("activateAll() calls activate() on plugins that have it", async () => {
      const registry = createPluginRegistry();
      const activateFn = vi.fn(async () => ok(undefined));

      const plugin = createTestPlugin({
        id: "activatable",
        activate: activateFn,
      });

      registry.register(plugin);
      const result = await registry.activateAll();

      expect(result.ok).toBe(true);
      expect(activateFn).toHaveBeenCalledOnce();
    });

    it("activateAll() skips plugins without activate method", async () => {
      const registry = createPluginRegistry();

      const pluginWithActivate = createTestPlugin({
        id: "with",
        activate: vi.fn(async () => ok(undefined)),
      });

      const pluginWithout = createTestPlugin({
        id: "without",
        // no activate method
      });

      registry.register(pluginWithActivate);
      registry.register(pluginWithout);

      const result = await registry.activateAll();

      expect(result.ok).toBe(true);
      expect(pluginWithActivate.activate).toHaveBeenCalledOnce();
    });

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
  });

  // ─── Event Emission ─────────────────────────────────────────────

  describe("event emission", () => {
    it("emits plugin:registered event when eventBus provided", () => {
      const eventBus = new TypedEventBus();
      const handler = vi.fn();
      eventBus.on("plugin:registered", handler);

      const registry = createPluginRegistry({ eventBus });

      const plugin = createTestPlugin({
        id: "evented",
        register: (api) => {
          api.registerHook("agent_end", () => {});
          return ok(undefined);
        },
      });

      registry.register(plugin);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "evented",
          pluginName: "test-plugin-evented",
          hookCount: 1,
        }),
      );
    });

    it("emits plugin:deactivated event on deactivation", async () => {
      const eventBus = new TypedEventBus();
      const handler = vi.fn();
      eventBus.on("plugin:deactivated", handler);

      const registry = createPluginRegistry({ eventBus });
      const plugin = createTestPlugin({
        id: "will-deactivate",
        deactivate: async () => ok(undefined),
      });

      registry.register(plugin);
      await registry.deactivateAll();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "will-deactivate",
          reason: "shutdown",
        }),
      );
    });

    it("does not throw when eventBus not provided", () => {
      const registry = createPluginRegistry(); // no eventBus

      const plugin = createTestPlugin({ id: "no-bus" });

      expect(() => registry.register(plugin)).not.toThrow();
    });
  });

  // ─── Tool, Route, and Config Schema Registration ───────────────

  describe("tool registration", () => {
    it("plugin can register a tool via registerTool()", () => {
      const registry = createPluginRegistry();
      const executeFn = vi.fn(async () => "result");

      const plugin = createTestPlugin({
        id: "tool-plugin",
        register: (api) => {
          api.registerTool({
            name: "my-tool",
            description: "A test tool",
            parameters: { input: { type: "string" } },
            execute: executeFn,
          });
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const registeredTools = registry.getRegisteredTools();
      expect(registeredTools).toHaveLength(1);
      expect(registeredTools[0]!.name).toBe("my-tool");
      expect(registeredTools[0]!.description).toBe("A test tool");
      expect(registeredTools[0]!.execute).toBe(executeFn);
    });

    it("rejects tool with empty name", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "bad-tool",
        register: (api) => {
          api.registerTool({
            name: "",
            description: "empty name tool",
            parameters: {},
            execute: async () => null,
          });
          return ok(undefined);
        },
      });

      const result = registry.register(plugin);
      expect(result.ok).toBe(false);
    });
  });

  describe("HTTP route registration", () => {
    it("plugin can register an HTTP route via registerHttpRoute()", () => {
      const registry = createPluginRegistry();
      const handlerFn = vi.fn(async () => ({ status: 200 }));

      const plugin = createTestPlugin({
        id: "route-plugin",
        register: (api) => {
          api.registerHttpRoute({
            method: "POST",
            path: "/api/webhook",
            handler: handlerFn,
          });
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const registeredRoutes = registry.getRegisteredRoutes();
      expect(registeredRoutes).toHaveLength(1);
      expect(registeredRoutes[0]!.method).toBe("POST");
      expect(registeredRoutes[0]!.path).toBe("/api/webhook");
      expect(registeredRoutes[0]!.handler).toBe(handlerFn);
    });

    it("rejects route with path not starting with /", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "bad-route",
        register: (api) => {
          api.registerHttpRoute({
            method: "GET",
            path: "no-slash",
            handler: async () => null,
          });
          return ok(undefined);
        },
      });

      const result = registry.register(plugin);
      expect(result.ok).toBe(false);
    });
  });

  describe("config schema registration", () => {
    it("plugin can register a config schema via registerConfigSchema()", () => {
      const registry = createPluginRegistry();
      const schema = z.object({ apiKey: z.string(), retries: z.number() });

      const plugin = createTestPlugin({
        id: "config-plugin",
        register: (api) => {
          api.registerConfigSchema("myPlugin", schema);
          return ok(undefined);
        },
      });

      registry.register(plugin);

      const schemas = registry.getRegisteredConfigSchemas();
      expect(schemas.size).toBe(1);
      expect(schemas.get("myPlugin")).toBe(schema);
    });

    it("rejects config schema with empty section", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "bad-config",
        register: (api) => {
          api.registerConfigSchema("", z.object({}));
          return ok(undefined);
        },
      });

      const result = registry.register(plugin);
      expect(result.ok).toBe(false);
    });
  });

  describe("multiple plugin aggregation", () => {
    it("aggregates tools, routes, and schemas from multiple plugins", () => {
      const registry = createPluginRegistry();
      const schema1 = z.object({ key: z.string() });
      const schema2 = z.object({ url: z.string() });

      const plugin1 = createTestPlugin({
        id: "plugin-a",
        register: (api) => {
          api.registerTool({
            name: "tool-a",
            description: "Tool A",
            parameters: {},
            execute: async () => "a",
          });
          api.registerHttpRoute({
            method: "GET",
            path: "/api/a",
            handler: async () => "a",
          });
          api.registerConfigSchema("pluginA", schema1);
          return ok(undefined);
        },
      });

      const plugin2 = createTestPlugin({
        id: "plugin-b",
        register: (api) => {
          api.registerTool({
            name: "tool-b",
            description: "Tool B",
            parameters: {},
            execute: async () => "b",
          });
          api.registerHttpRoute({
            method: "POST",
            path: "/api/b",
            handler: async () => "b",
          });
          api.registerConfigSchema("pluginB", schema2);
          return ok(undefined);
        },
      });

      registry.register(plugin1);
      registry.register(plugin2);

      expect(registry.getRegisteredTools()).toHaveLength(2);
      expect(registry.getRegisteredTools().map((t) => t.name)).toEqual(["tool-a", "tool-b"]);

      expect(registry.getRegisteredRoutes()).toHaveLength(2);
      expect(registry.getRegisteredRoutes().map((r) => r.path)).toEqual(["/api/a", "/api/b"]);

      const schemas = registry.getRegisteredConfigSchemas();
      expect(schemas.size).toBe(2);
      expect(schemas.has("pluginA")).toBe(true);
      expect(schemas.has("pluginB")).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("registerHook still works alongside new registration methods", () => {
      const registry = createPluginRegistry();

      const plugin = createTestPlugin({
        id: "compat-plugin",
        register: (api) => {
          api.registerHook("agent_end", () => {});
          api.registerTool({
            name: "compat-tool",
            description: "backward compat test",
            parameters: {},
            execute: async () => null,
          });
          return ok(undefined);
        },
      });

      registry.register(plugin);

      expect(registry.getHooksByName("agent_end")).toHaveLength(1);
      expect(registry.getRegisteredTools()).toHaveLength(1);
    });
  });
});
