// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { PluginPort, PluginRegistryApi } from "../ports/plugin.js";
import type { EventMap } from "../event-bus/events.js";
import { TypedEventBus } from "../event-bus/index.js";
import { PluginsConfigSchema } from "../config/schema-plugins.js";
import { createPluginRegistry } from "./plugin-registry.js";
import { createHookRunner } from "./hook-runner.js";

/**
 * Create a minimal test plugin with sensible defaults.
 */
function createTestPlugin(overrides: Partial<PluginPort> & { id: string }): PluginPort {
  return {
    name: overrides.name ?? `test-plugin-${overrides.id}`,
    register: overrides.register ?? ((_api: PluginRegistryApi) => ok(undefined)),
    ...overrides,
  };
}

describe("Hook System Integration", () => {
  it("full plugin lifecycle: register -> activate -> hook -> deactivate", async () => {
    // 1. Create a TypedEventBus instance
    const eventBus = new TypedEventBus();

    // Collect emitted events for verification
    const pluginRegisteredEvents: EventMap["plugin:registered"][] = [];
    const hookExecutedEvents: EventMap["hook:executed"][] = [];
    const pluginDeactivatedEvents: EventMap["plugin:deactivated"][] = [];

    eventBus.on("plugin:registered", (e) => pluginRegisteredEvents.push(e));
    eventBus.on("hook:executed", (e) => hookExecutedEvents.push(e));
    eventBus.on("plugin:deactivated", (e) => pluginDeactivatedEvents.push(e));

    // 2. Create a plugin registry with the event bus
    const registry = createPluginRegistry({ eventBus });

    // 3. Create a hook runner with the registry and event bus
    const runner = createHookRunner(registry, { eventBus });

    // 4. Define a test plugin
    const agentEndCalls: Array<{ durationMs: number; success: boolean }> = [];

    const testPlugin = createTestPlugin({
      id: "lifecycle-test",
      name: "Lifecycle Test Plugin",
      register: (api) => {
        // before_agent_start: modifying hook that prepends "[PLUGIN] " to system prompt
        api.registerHook("before_agent_start", (event) => ({
          systemPrompt: `[PLUGIN] ${event.systemPrompt}`,
        }));

        // agent_end: void hook that records the call
        api.registerHook("agent_end", (event) => {
          agentEndCalls.push({ durationMs: event.durationMs, success: event.success });
        });

        return ok(undefined);
      },
      activate: async () => ok(undefined),
      deactivate: async () => ok(undefined),
    });

    // 5. Register the plugin -> verify ok result
    const registerResult = registry.register(testPlugin);
    expect(registerResult.ok).toBe(true);

    // 6. Activate all plugins -> verify ok result
    const activateResult = await registry.activateAll();
    expect(activateResult.ok).toBe(true);

    // 7. Run before_agent_start hook -> verify system prompt is modified
    const beforeResult = await runner.runBeforeAgentStart(
      { systemPrompt: "Be helpful.", messages: [] },
      { agentId: "agent-1" },
    );
    expect(beforeResult?.systemPrompt).toBe("[PLUGIN] Be helpful.");

    // 8. Run agent_end hook -> verify tracking array has the call
    await runner.runAgentEnd(
      { durationMs: 250, success: true },
      { agentId: "agent-1" },
    );
    expect(agentEndCalls).toHaveLength(1);
    expect(agentEndCalls[0]).toEqual({ durationMs: 250, success: true });

    // 9. Deactivate all plugins -> verify ok result
    const deactivateResult = await registry.deactivateAll();
    expect(deactivateResult.ok).toBe(true);

    // 10. Verify plugin:registered event was emitted on the event bus
    expect(pluginRegisteredEvents).toHaveLength(1);
    expect(pluginRegisteredEvents[0]!.pluginId).toBe("lifecycle-test");
    expect(pluginRegisteredEvents[0]!.hookCount).toBe(2);

    // 11. Verify hook:executed events were emitted for both hook calls
    expect(hookExecutedEvents).toHaveLength(2);
    expect(hookExecutedEvents[0]!.hookName).toBe("before_agent_start");
    expect(hookExecutedEvents[1]!.hookName).toBe("agent_end");
    expect(hookExecutedEvents.every((e) => e.success)).toBe(true);

    // Verify deactivation event
    expect(pluginDeactivatedEvents).toHaveLength(1);
    expect(pluginDeactivatedEvents[0]!.pluginId).toBe("lifecycle-test");
  });

  it("multiple plugins with priority ordering", async () => {
    const eventBus = new TypedEventBus();
    const registry = createPluginRegistry({ eventBus });
    const runner = createHookRunner(registry, { eventBus });

    const executionOrder: string[] = [];

    // Plugin A: priority 10 (runs first)
    registry.register(
      createTestPlugin({
        id: "plugin-a",
        register: (api) => {
          api.registerHook(
            "before_tool_call",
            (event) => {
              executionOrder.push("A");
              return { params: { ...event.params, fromA: true } };
            },
            { priority: 10 },
          );
          return ok(undefined);
        },
      }),
    );

    // Plugin B: priority 5 (runs second)
    registry.register(
      createTestPlugin({
        id: "plugin-b",
        register: (api) => {
          api.registerHook(
            "before_tool_call",
            (event) => {
              executionOrder.push("B");
              return { params: { ...event.params, fromB: true } };
            },
            { priority: 5 },
          );
          return ok(undefined);
        },
      }),
    );

    const result = await runner.runBeforeToolCall(
      { toolName: "read_file", params: { path: "/tmp" } },
      { agentId: "a" },
    );

    // A ran before B (higher priority first)
    expect(executionOrder).toEqual(["A", "B"]);

    // Both modifications present (B's params override A's via merge)
    expect(result?.params).toBeDefined();
    expect(result!.params!.fromB).toBe(true);
  });

  it("plugin error isolation", async () => {
    const eventBus = new TypedEventBus();
    const registry = createPluginRegistry({ eventBus });
    const runner = createHookRunner(registry, { eventBus, catchErrors: true });

    const hookEvents: EventMap["hook:executed"][] = [];
    eventBus.on("hook:executed", (e) => hookEvents.push(e));

    // First plugin: throws an error
    registry.register(
      createTestPlugin({
        id: "broken",
        register: (api) => {
          api.registerHook(
            "before_agent_start",
            () => {
              throw new Error("intentional failure");
            },
            { priority: 10 },
          );
          return ok(undefined);
        },
      }),
    );

    // Second plugin: normal behavior
    registry.register(
      createTestPlugin({
        id: "healthy",
        register: (api) => {
          api.registerHook(
            "before_agent_start",
            () => ({ systemPrompt: "from-healthy" }),
            { priority: 5 },
          );
          return ok(undefined);
        },
      }),
    );

    const result = await runner.runBeforeAgentStart(
      { systemPrompt: "original", messages: [] },
      { agentId: "a" },
    );

    // The second plugin's result is returned (first was caught)
    expect(result?.systemPrompt).toBe("from-healthy");

    // Verify hook:executed events
    expect(hookEvents).toHaveLength(2);
    const brokenEvent = hookEvents.find((e) => e.pluginId === "broken");
    expect(brokenEvent?.success).toBe(false);
    expect(brokenEvent?.error).toBe("intentional failure");

    const healthyEvent = hookEvents.find((e) => e.pluginId === "healthy");
    expect(healthyEvent?.success).toBe(true);
  });

  it("before_tool_call blocks tool execution", async () => {
    const registry = createPluginRegistry();
    const runner = createHookRunner(registry);

    registry.register(
      createTestPlugin({
        id: "security-gate",
        register: (api) => {
          api.registerHook("before_tool_call", () => ({
            block: true,
            blockReason: "forbidden",
          }));
          return ok(undefined);
        },
      }),
    );

    const result = await runner.runBeforeToolCall(
      { toolName: "shell:exec", params: { command: "rm -rf /" } },
      { agentId: "a" },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("forbidden");
  });

  it("config-driven plugin enablement (schema validation)", () => {
    // Validate PluginsConfigSchema correctly parses plugin configurations

    // Parse a config with one enabled and one disabled plugin
    const config = PluginsConfigSchema.parse({
      enabled: true,
      plugins: {
        "audit-logger": {
          enabled: true,
          priority: 10,
          config: { logLevel: "debug" },
        },
        "webhook-forwarder": {
          enabled: false,
          priority: -5,
          config: { url: "https://example.com/webhook" },
        },
      },
    });

    expect(config.enabled).toBe(true);
    expect(Object.keys(config.plugins)).toHaveLength(2);

    const audit = config.plugins["audit-logger"]!;
    expect(audit.enabled).toBe(true);
    expect(audit.priority).toBe(10);
    expect(audit.config.logLevel).toBe("debug");

    const webhook = config.plugins["webhook-forwarder"]!;
    expect(webhook.enabled).toBe(false);
    expect(webhook.priority).toBe(-5);

    // Validate defaults work
    const defaultConfig = PluginsConfigSchema.parse({});
    expect(defaultConfig.enabled).toBe(true);
    expect(Object.keys(defaultConfig.plugins)).toHaveLength(0);
  });

  it("lifecycle scenario: unregister/re-register", async () => {
    const registry = createPluginRegistry();
    const runner = createHookRunner(registry);

    // 1. Register a plugin
    const calls: string[] = [];

    registry.register(
      createTestPlugin({
        id: "hot-plugin",
        register: (api) => {
          api.registerHook("agent_end", () => {
            calls.push("v1");
          });
          return ok(undefined);
        },
      }),
    );

    // 2. Run a hook -> verify it fires
    await runner.runAgentEnd(
      { durationMs: 100, success: true },
      { agentId: "a" },
    );
    expect(calls).toEqual(["v1"]);

    // 3. Unregister the plugin
    const unregResult = registry.unregister("hot-plugin");
    expect(unregResult.ok).toBe(true);

    // 4. Run the same hook -> verify it does NOT fire
    await runner.runAgentEnd(
      { durationMs: 100, success: true },
      { agentId: "a" },
    );
    expect(calls).toEqual(["v1"]); // still just one call

    // 5. Register a new plugin for the same hook
    registry.register(
      createTestPlugin({
        id: "hot-plugin-v2",
        register: (api) => {
          api.registerHook("agent_end", () => {
            calls.push("v2");
          });
          return ok(undefined);
        },
      }),
    );

    // 6. Run the hook -> verify the new plugin fires
    await runner.runAgentEnd(
      { durationMs: 100, success: true },
      { agentId: "a" },
    );
    expect(calls).toEqual(["v1", "v2"]);
  });
});
