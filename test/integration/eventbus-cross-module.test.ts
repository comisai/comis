// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Module Event Flow Integration Tests (non-daemon)
 *
 * Validates that TypedEventBus events flow correctly across real module
 * boundaries (plugin registry -> hook runner -> event bus) and that the
 * bootstrap composition root creates a singleton bus shared by all subsystems.
 *
 *   Group 1: Plugin Lifecycle Events (plugin:registered, hook:executed, plugin:deactivated)
 *   Group 2: Bootstrap AppContainer Wiring (singleton bus, shutdown cleanup)
 *
 * All imports come from built dist/ packages via vitest aliases --
 * this is integration testing, not unit testing.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  TypedEventBus,
  createPluginRegistry,
  createHookRunner,
  bootstrap,
} from "@comis/core";
import type {
  PluginPort,
  HookSessionStartEvent,
  HookSessionStartContext,
  HookBeforeAgentStartEvent,
  HookBeforeAgentStartContext,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createEventAwaiter, type EventAwaiter } from "../support/event-awaiter.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal test plugin implementing PluginPort.
 * Registers a single session_start hook by default.
 */
function createTestPlugin(
  hookName: "session_start" | "before_agent_start" = "session_start",
): PluginPort {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    register(api) {
      if (hookName === "session_start") {
        api.registerHook("session_start", () => {});
      } else {
        api.registerHook("before_agent_start", () => {
          return { systemPrompt: "modified" };
        });
      }
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Group 1: Plugin Lifecycle Events
// ---------------------------------------------------------------------------

describe("Cross-Module Event Flows", () => {
  describe("Plugin Lifecycle Events", () => {
    let bus: TypedEventBus;
    let awaiter: EventAwaiter;

    beforeEach(() => {
      bus = new TypedEventBus();
      awaiter = createEventAwaiter(bus);
    });

    afterEach(() => {
      awaiter.dispose();
    });

    it("plugin:registered fires on register", async () => {
      const registry = createPluginRegistry({ eventBus: bus });
      const testPlugin = createTestPlugin();

      const collected = await awaiter.collectDuring("plugin:registered", async () => {
        registry.register(testPlugin);
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.pluginId).toBe("test-plugin");
      expect(collected[0]!.pluginName).toBe("Test Plugin");
      expect(collected[0]!.hookCount).toBe(1);
    });

    it("plugin:deactivated fires on deactivateAll", async () => {
      const registry = createPluginRegistry({ eventBus: bus });
      const testPlugin = createTestPlugin();
      registry.register(testPlugin);

      const collected = await awaiter.collectDuring("plugin:deactivated", async () => {
        await registry.deactivateAll();
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]!.pluginId).toBe("test-plugin");
      expect(collected[0]!.reason).toBe("shutdown");
    });

    it("full lifecycle sequence: plugin:registered -> hook:executed -> plugin:deactivated", async () => {
      const registry = createPluginRegistry({ eventBus: bus });
      const hookRunner = createHookRunner(registry, { eventBus: bus, catchErrors: true });
      const testPlugin = createTestPlugin("session_start");

      // Start waiting for the sequence BEFORE firing events
      const sequencePromise = awaiter.waitForSequence(
        ["plugin:registered", "hook:executed", "plugin:deactivated"],
        { timeoutMs: 5_000 },
      );

      // 1. Register plugin (fires plugin:registered)
      registry.register(testPlugin);

      // 2. Execute the hook (fires hook:executed)
      const sessionStartEvent: HookSessionStartEvent = {
        sessionKey: { channelType: "echo", channelId: "test", chatId: "c1" },
        isNew: true,
      };
      const sessionStartContext: HookSessionStartContext = {
        agentId: "test-agent",
      };
      await hookRunner.runSessionStart(sessionStartEvent, sessionStartContext);

      // 3. Deactivate all (fires plugin:deactivated)
      await registry.deactivateAll();

      // Await sequence
      const events = await sequencePromise;
      expect(events).toHaveLength(3);
    });

    it("hook:executed includes timing and success fields", async () => {
      const registry = createPluginRegistry({ eventBus: bus });
      const hookRunner = createHookRunner(registry, { eventBus: bus, catchErrors: true });
      const testPlugin = createTestPlugin("session_start");
      registry.register(testPlugin);

      const payload = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timeout waiting for hook:executed")),
          5_000,
        );
        bus.on("hook:executed", (p) => {
          clearTimeout(timer);
          resolve(p);
        });
        // Run the hook
        hookRunner.runSessionStart(
          { sessionKey: { channelType: "echo", channelId: "test", chatId: "c1" }, isNew: true },
          { agentId: "test-agent" },
        );
      });

      expect(payload.hookName).toBe("session_start");
      expect(payload.pluginId).toBe("test-plugin");
      expect(typeof payload.durationMs).toBe("number");
      expect(payload.success).toBe(true);
      expect(typeof payload.timestamp).toBe("number");
    });

    it("audit:event fires through hook runner for modifying hooks", async () => {
      const registry = createPluginRegistry({ eventBus: bus });
      const hookRunner = createHookRunner(registry, { eventBus: bus, catchErrors: true });

      // Register a plugin with before_agent_start hook (a modifying hook)
      const testPlugin = createTestPlugin("before_agent_start");
      registry.register(testPlugin);

      const payload = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timeout waiting for audit:event")),
          5_000,
        );
        bus.on("audit:event", (p) => {
          clearTimeout(timer);
          resolve(p);
        });
        // Run the modifying hook
        const event: HookBeforeAgentStartEvent = {
          systemPrompt: "Hello",
          messages: [],
        };
        const ctx: HookBeforeAgentStartContext = {
          agentId: "test-agent",
        };
        hookRunner.runBeforeAgentStart(event, ctx);
      });

      expect(payload.actionType).toBe("hook_modification");
      expect(payload.outcome).toBe("success");
      expect(typeof payload.timestamp).toBe("number");
      expect(payload.metadata).toBeDefined();
      expect(payload.metadata.hookName).toBe("before_agent_start");
      expect(payload.metadata.pluginId).toBe("test-plugin");
    });
  });

  // ---------------------------------------------------------------------------
  // Group 2: Bootstrap AppContainer Wiring
  // ---------------------------------------------------------------------------

  describe("Bootstrap AppContainer Wiring", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = join(tmpdir(), `comis-test-eventbus-bootstrap-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Write a minimal config YAML that passes Zod validation.
     */
    function writeMinimalConfig(): string {
      const configPath = join(tmpDir, `config-${Date.now()}.yaml`);
      const yaml = `agents:
  test-agent:
    model: echo
    name: Test Agent
    provider: echo
memory:
  dbPath: ":memory:"
gateway:
  port: 19876
  tokens: []
`;
      writeFileSync(configPath, yaml, "utf-8");
      return configPath;
    }

    it("bootstrap() creates AppContainer with functional event bus", () => {
      const configPath = writeMinimalConfig();
      const result = bootstrap({ configPaths: [configPath], env: {} });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const container = result.value;
      try {
        // Verify eventBus exists and has all expected methods
        expect(container.eventBus).toBeDefined();
        expect(typeof container.eventBus.emit).toBe("function");
        expect(typeof container.eventBus.on).toBe("function");
        expect(typeof container.eventBus.off).toBe("function");
        expect(typeof container.eventBus.once).toBe("function");
        expect(typeof container.eventBus.removeAllListeners).toBe("function");
        expect(typeof container.eventBus.listenerCount).toBe("function");
        expect(typeof container.eventBus.setMaxListeners).toBe("function");

        // Verify the bus is functional: register handler, emit, verify called
        let shutdownCalled = false;
        container.eventBus.on("system:shutdown", () => {
          shutdownCalled = true;
        });
        container.eventBus.emit("system:shutdown", { reason: "test", graceful: true });
        expect(shutdownCalled).toBe(true);
      } finally {
        container.shutdown();
      }
    });

    it("bootstrap() event bus is singleton across container properties", async () => {
      const configPath = writeMinimalConfig();
      const result = bootstrap({ configPaths: [configPath], env: {} });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const container = result.value;
      try {
        // Register a handler on the container's event bus for plugin:registered
        let pluginRegisteredPayload: any = null;
        container.eventBus.on("plugin:registered", (payload) => {
          pluginRegisteredPayload = payload;
        });

        // Register a plugin through the container's plugin registry
        const testPlugin: PluginPort = {
          id: "singleton-test-plugin",
          name: "Singleton Test Plugin",
          version: "1.0.0",
          register(api) {
            api.registerHook("session_start", () => {});
            return ok(undefined);
          },
        };
        container.pluginRegistry.register(testPlugin);

        // Verify the handler on container.eventBus was called (same bus instance)
        expect(pluginRegisteredPayload).not.toBeNull();
        expect(pluginRegisteredPayload.pluginId).toBe("singleton-test-plugin");
        expect(pluginRegisteredPayload.pluginName).toBe("Singleton Test Plugin");
        expect(pluginRegisteredPayload.hookCount).toBe(1);
      } finally {
        await container.shutdown();
      }
    });

    it("container.shutdown() removes all listeners", async () => {
      const configPath = writeMinimalConfig();
      const result = bootstrap({ configPaths: [configPath], env: {} });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const container = result.value;

      // Register handlers for two different events
      container.eventBus.on("system:shutdown", () => {});
      container.eventBus.on("system:error", () => {});

      // Verify listenerCount > 0 for both events
      expect(container.eventBus.listenerCount("system:shutdown")).toBeGreaterThan(0);
      expect(container.eventBus.listenerCount("system:error")).toBeGreaterThan(0);

      // Call shutdown()
      await container.shutdown();

      // Verify listenerCount dropped to 0 for both events
      expect(container.eventBus.listenerCount("system:shutdown")).toBe(0);
      expect(container.eventBus.listenerCount("system:error")).toBe(0);
    });
  });
});
