// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ok } from "@comis/shared";
import type { PluginPort, PluginRegistryApi } from "../ports/plugin.js";
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
  it("full plugin lifecycle: register -> hook -> deactivate", async () => {
    // 1. Create a plugin registry
    const registry = createPluginRegistry();

    // 2. Create a hook runner
    const runner = createHookRunner(registry);

    // 3. Define a test plugin
    const sessionStartCalls: Array<{ isNew: boolean }> = [];

    const testPlugin = createTestPlugin({
      id: "lifecycle-test",
      name: "Lifecycle Test Plugin",
      register: (api) => {
        // before_agent_start: modifying hook that prepends "[PLUGIN] " to system prompt
        api.registerHook("before_agent_start", (event) => ({
          systemPrompt: `[PLUGIN] ${event.systemPrompt}`,
        }));

        // session_start: void hook that records the call
        api.registerHook("session_start", (event) => {
          sessionStartCalls.push({ isNew: event.isNew });
        });

        return ok(undefined);
      },
      deactivate: async () => ok(undefined),
    });

    // 4. Register the plugin -> verify ok result
    const registerResult = registry.register(testPlugin);
    expect(registerResult.ok).toBe(true);

    // 5. Run before_agent_start hook -> verify system prompt is modified
    const beforeResult = await runner.runBeforeAgentStart(
      { systemPrompt: "Be helpful.", messages: [] },
      { agentId: "agent-1" },
    );
    expect(beforeResult?.systemPrompt).toBe("[PLUGIN] Be helpful.");

    // 6. Run session_start hook -> verify tracking array has the call
    await runner.runSessionStart(
      { sessionKey: { tenantId: "t", userId: "u", channelId: "c" }, isNew: true },
      { agentId: "agent-1" },
    );
    expect(sessionStartCalls).toHaveLength(1);
    expect(sessionStartCalls[0]).toEqual({ isNew: true });

    // 7. Deactivate all plugins -> verify ok result
    const deactivateResult = await registry.deactivateAll();
    expect(deactivateResult.ok).toBe(true);
  });

  it("multiple plugins with priority ordering", async () => {
    const registry = createPluginRegistry();
    const runner = createHookRunner(registry);

    const executionOrder: string[] = [];

    // Plugin A: priority 10 (runs first)
    registry.register(
      createTestPlugin({
        id: "plugin-a",
        register: (api) => {
          api.registerHook(
            "before_agent_start",
            () => {
              executionOrder.push("A");
              return { systemPrompt: "from-A" };
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
            "before_agent_start",
            () => {
              executionOrder.push("B");
              return { systemPrompt: "from-B" };
            },
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

    // A ran before B (higher priority first)
    expect(executionOrder).toEqual(["A", "B"]);

    // B's value overrides A's via merge (last-writer-wins)
    expect(result?.systemPrompt).toBe("from-B");
  });

  it("plugin error isolation", async () => {
    const registry = createPluginRegistry();
    const runner = createHookRunner(registry, { catchErrors: true });

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
  });

  it("parses config-driven plugin enablement schema", () => {
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
          api.registerHook("session_start", () => {
            calls.push("v1");
          });
          return ok(undefined);
        },
      }),
    );

    // 2. Run a hook -> verify it fires
    await runner.runSessionStart(
      { sessionKey: { tenantId: "t", userId: "u", channelId: "c" }, isNew: true },
      { agentId: "a" },
    );
    expect(calls).toEqual(["v1"]);

    // 3. Unregister the plugin
    const unregResult = registry.unregister("hot-plugin");
    expect(unregResult.ok).toBe(true);

    // 4. Run the same hook -> verify it does NOT fire
    await runner.runSessionStart(
      { sessionKey: { tenantId: "t", userId: "u", channelId: "c" }, isNew: true },
      { agentId: "a" },
    );
    expect(calls).toEqual(["v1"]); // still just one call

    // 5. Register a new plugin for the same hook
    registry.register(
      createTestPlugin({
        id: "hot-plugin-v2",
        register: (api) => {
          api.registerHook("session_start", () => {
            calls.push("v2");
          });
          return ok(undefined);
        },
      }),
    );

    // 6. Run the hook -> verify the new plugin fires
    await runner.runSessionStart(
      { sessionKey: { tenantId: "t", userId: "u", channelId: "c" }, isNew: true },
      { agentId: "a" },
    );
    expect(calls).toEqual(["v1", "v2"]);
  });
});
