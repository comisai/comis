import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { PluginPort, PluginRegistryApi } from "../ports/plugin.js";
import type { EventMap } from "../event-bus/events.js";
import { TypedEventBus } from "../event-bus/index.js";
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

describe("HookRunner", () => {
  // ─── Void Hook Execution ────────────────────────────────────────

  describe("void hook execution", () => {
    it("runs void hooks in parallel (verifies Promise.all-like behavior)", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      registry.register(
        createTestPlugin({
          id: "slow-1",
          register: (api) => {
            api.registerHook("agent_end", async () => {
              await delay(50);
            });
            return ok(undefined);
          },
        }),
      );

      registry.register(
        createTestPlugin({
          id: "slow-2",
          register: (api) => {
            api.registerHook("agent_end", async () => {
              await delay(50);
            });
            return ok(undefined);
          },
        }),
      );

      const startMs = Date.now();
      await runner.runAgentEnd(
        { durationMs: 100, success: true },
        { agentId: "test-agent" },
      );
      const elapsed = Date.now() - startMs;

      // If parallel: ~50ms. If sequential: ~100ms.
      // Use generous margin for CI variance.
      expect(elapsed).toBeLessThan(90);
    });

    it("void hook errors are caught and do not propagate (catchErrors: true)", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry, { catchErrors: true });

      registry.register(
        createTestPlugin({
          id: "throws",
          register: (api) => {
            api.registerHook("agent_end", () => {
              throw new Error("boom");
            });
            return ok(undefined);
          },
        }),
      );

      // Should not throw
      await expect(
        runner.runAgentEnd({ durationMs: 100, success: true }, { agentId: "a" }),
      ).resolves.toBeUndefined();
    });

    it("void hook errors propagate when catchErrors is false", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry, { catchErrors: false });

      registry.register(
        createTestPlugin({
          id: "throws",
          register: (api) => {
            api.registerHook("agent_end", () => {
              throw new Error("propagate-me");
            });
            return ok(undefined);
          },
        }),
      );

      await expect(
        runner.runAgentEnd({ durationMs: 100, success: true }, { agentId: "a" }),
      ).rejects.toThrow("propagate-me");
    });

    it("void hooks with no registrations complete without error", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      await expect(
        runner.runAgentEnd({ durationMs: 100, success: true }, { agentId: "a" }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── Modifying Hook Execution ───────────────────────────────────

  describe("modifying hook execution", () => {
    it("runs modifying hooks sequentially (verifies order)", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      const executionOrder: string[] = [];

      registry.register(
        createTestPlugin({
          id: "high-pri",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => {
                executionOrder.push("high");
                return { systemPrompt: "high" };
              },
              { priority: 10 },
            );
            return ok(undefined);
          },
        }),
      );

      registry.register(
        createTestPlugin({
          id: "low-pri",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => {
                executionOrder.push("low");
                return { systemPrompt: "low" };
              },
              { priority: 5 },
            );
            return ok(undefined);
          },
        }),
      );

      await runner.runBeforeAgentStart(
        { systemPrompt: "original", messages: [] },
        { agentId: "a" },
      );

      // Higher priority runs first
      expect(executionOrder).toEqual(["high", "low"]);
    });

    it("modifying hook merges results correctly for before_agent_start", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "a",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => ({ systemPrompt: "modified" }),
              { priority: 10 },
            );
            return ok(undefined);
          },
        }),
      );

      registry.register(
        createTestPlugin({
          id: "b",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => ({ prependContext: "extra" }),
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

      expect(result).toEqual({
        systemPrompt: "modified",
        prependContext: "extra",
      });
    });

    it("modifying hook: later hook overrides earlier for same field", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "first",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => ({ systemPrompt: "first" }),
              { priority: 10 },
            );
            return ok(undefined);
          },
        }),
      );

      registry.register(
        createTestPlugin({
          id: "second",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => ({ systemPrompt: "second" }),
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

      // B runs after A (lower priority), so B's value overrides A's
      expect(result?.systemPrompt).toBe("second");
    });

    it("modifying hooks return undefined when no hooks registered", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      const result = await runner.runBeforeAgentStart(
        { systemPrompt: "original", messages: [] },
        { agentId: "a" },
      );

      expect(result).toBeUndefined();
    });

    it("modifying hook errors are caught and skipped (catchErrors: true)", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry, { catchErrors: true });

      registry.register(
        createTestPlugin({
          id: "throws",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => {
                throw new Error("broken hook");
              },
              { priority: 10 },
            );
            return ok(undefined);
          },
        }),
      );

      registry.register(
        createTestPlugin({
          id: "good",
          register: (api) => {
            api.registerHook(
              "before_agent_start",
              () => ({ systemPrompt: "good-result" }),
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

      // The erroring hook is skipped, good hook's result is returned
      expect(result?.systemPrompt).toBe("good-result");
    });
  });

  // ─── before_tool_call specific ──────────────────────────────────

  describe("before_tool_call specific", () => {
    it("before_tool_call can block tool execution", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "blocker",
          register: (api) => {
            api.registerHook("before_tool_call", () => ({
              block: true,
              blockReason: "denied",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = await runner.runBeforeToolCall(
        { toolName: "shell:exec", params: {} },
        { agentId: "a" },
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toBe("denied");
    });

    it("before_tool_call can modify params", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "modifier",
          register: (api) => {
            api.registerHook("before_tool_call", () => ({
              params: { modified: true },
            }));
            return ok(undefined);
          },
        }),
      );

      const result = await runner.runBeforeToolCall(
        { toolName: "read_file", params: { path: "/tmp" } },
        { agentId: "a" },
      );

      expect(result?.params).toEqual({ modified: true });
    });
  });

  // ─── tool_result_persist synchronous ────────────────────────────

  describe("tool_result_persist synchronous", () => {
    it("runToolResultPersist is synchronous (returns value, not promise)", () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "sync-plugin",
          register: (api) => {
            api.registerHook("tool_result_persist", () => ({
              result: "transformed",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = runner.runToolResultPersist(
        { toolName: "test", result: "original" },
        { agentId: "a" },
      );

      // Verify it's not a Promise
      expect(result).toBeDefined();
      expect(typeof result === "object" && result !== null && "then" in result).toBe(false);
      expect(result?.result).toBe("transformed");
    });

    it("tool_result_persist can transform the persisted result", () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "redactor",
          register: (api) => {
            api.registerHook("tool_result_persist", (event) => ({
              result: event.result.replace(/secret/g, "[REDACTED]"),
            }));
            return ok(undefined);
          },
        }),
      );

      const result = runner.runToolResultPersist(
        { toolName: "test", result: "the secret data" },
        { agentId: "a" },
      );

      expect(result?.result).toBe("the [REDACTED] data");
    });
  });

  // ─── before_compaction specific ─────────────────────────────────

  describe("before_compaction specific", () => {
    it("before_compaction can cancel compaction", async () => {
      const registry = createPluginRegistry();
      const runner = createHookRunner(registry);

      registry.register(
        createTestPlugin({
          id: "cancel-compaction",
          register: (api) => {
            api.registerHook("before_compaction", () => ({
              cancel: true,
              cancelReason: "test",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = await runner.runBeforeCompaction(
        {
          sessionKey: { tenantId: "t", userId: "u", channelId: "c" },
          messageCount: 100,
        },
        { agentId: "a" },
      );

      expect(result?.cancel).toBe(true);
      expect(result?.cancelReason).toBe("test");
    });
  });

  // ─── Observability Events ───────────────────────────────────────

  describe("observability events", () => {
    it("emits hook:executed event for each hook invocation", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      const hookEvents: EventMap["hook:executed"][] = [];
      eventBus.on("hook:executed", (e) => hookEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "observable",
          register: (api) => {
            api.registerHook("agent_end", () => {});
            return ok(undefined);
          },
        }),
      );

      await runner.runAgentEnd(
        { durationMs: 100, success: true },
        { agentId: "a" },
      );

      expect(hookEvents).toHaveLength(1);
    });

    it("hook:executed includes correct hookName, pluginId, durationMs, success", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      const hookEvents: EventMap["hook:executed"][] = [];
      eventBus.on("hook:executed", (e) => hookEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "metric-plugin",
          register: (api) => {
            api.registerHook("before_agent_start", () => ({ systemPrompt: "ok" }));
            return ok(undefined);
          },
        }),
      );

      await runner.runBeforeAgentStart(
        { systemPrompt: "original", messages: [] },
        { agentId: "a" },
      );

      expect(hookEvents).toHaveLength(1);
      const event = hookEvents[0]!;
      expect(event.hookName).toBe("before_agent_start");
      expect(event.pluginId).toBe("metric-plugin");
      expect(typeof event.durationMs).toBe("number");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.success).toBe(true);
    });

    it("hook:executed has success: false when hook throws", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus, catchErrors: true });

      const hookEvents: EventMap["hook:executed"][] = [];
      eventBus.on("hook:executed", (e) => hookEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "failing-plugin",
          register: (api) => {
            api.registerHook("agent_end", () => {
              throw new Error("hook failure");
            });
            return ok(undefined);
          },
        }),
      );

      await runner.runAgentEnd(
        { durationMs: 100, success: true },
        { agentId: "a" },
      );

      expect(hookEvents).toHaveLength(1);
      const event = hookEvents[0]!;
      expect(event.success).toBe(false);
      expect(event.error).toBe("hook failure");
    });
  });

  // ─── Zod Validation ─────────────────────────────────────────────

  describe("Zod schema validation", () => {
    it("hook returning valid schema shape is merged correctly", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      registry.register(
        createTestPlugin({
          id: "valid-hook",
          register: (api) => {
            api.registerHook("before_agent_start", () => ({
              systemPrompt: "modified-prompt",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = await runner.runBeforeAgentStart(
        { systemPrompt: "original", messages: [] },
        { agentId: "a" },
      );

      expect(result?.systemPrompt).toBe("modified-prompt");
    });

    it("hook returning extra properties (strict mode) is skipped with error event", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      const hookEvents: EventMap["hook:executed"][] = [];
      eventBus.on("hook:executed", (e) => hookEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "extra-props",
          register: (api) => {
            api.registerHook("before_agent_start", () => ({
              systemPrompt: "modified",
              maliciousField: "injected",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = await runner.runBeforeAgentStart(
        { systemPrompt: "original", messages: [] },
        { agentId: "a" },
      );

      // The result should be undefined because the invalid hook was skipped
      expect(result).toBeUndefined();

      // A hook:executed event should be emitted with success: false
      const failEvent = hookEvents.find((e) => !e.success);
      expect(failEvent).toBeDefined();
      expect(failEvent?.error).toContain("Invalid hook return");
    });

    it("hook returning extra properties on before_tool_call is skipped", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      registry.register(
        createTestPlugin({
          id: "extra-tool-props",
          register: (api) => {
            api.registerHook("before_tool_call", () => ({
              block: true,
              blockReason: "denied",
              extraProp: "injected",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = await runner.runBeforeToolCall(
        { toolName: "shell:exec", params: {} },
        { agentId: "a" },
      );

      // Skipped due to strict schema validation
      expect(result).toBeUndefined();
    });

    it("sync hook (tool_result_persist) with extra properties is skipped", () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      registry.register(
        createTestPlugin({
          id: "extra-sync-props",
          register: (api) => {
            api.registerHook("tool_result_persist", () => ({
              result: "ok",
              extraField: "injected",
            }));
            return ok(undefined);
          },
        }),
      );

      const result = runner.runToolResultPersist(
        { toolName: "test", result: "original" },
        { agentId: "a" },
      );

      // Skipped due to strict schema validation
      expect(result).toBeUndefined();
    });
  });

  // ─── Audit Events for Modifications ────────────────────────────

  describe("audit events for hook modifications", () => {
    it("emits audit:event when before_agent_start modifies systemPrompt", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      const auditEvents: EventMap["audit:event"][] = [];
      eventBus.on("audit:event", (e) => auditEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "prompt-modifier",
          register: (api) => {
            api.registerHook("before_agent_start", () => ({
              systemPrompt: "modified prompt",
            }));
            return ok(undefined);
          },
        }),
      );

      await runner.runBeforeAgentStart(
        { systemPrompt: "original", messages: [] },
        { agentId: "a" },
      );

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.actionType).toBe("hook_modification");
      expect(auditEvents[0]!.metadata?.hookName).toBe("before_agent_start");
      expect(auditEvents[0]!.metadata?.pluginId).toBe("prompt-modifier");
      expect(auditEvents[0]!.metadata?.systemPromptModified).toBe(true);
    });

    it("emits audit:event when before_tool_call modifies params", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      const auditEvents: EventMap["audit:event"][] = [];
      eventBus.on("audit:event", (e) => auditEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "param-modifier",
          register: (api) => {
            api.registerHook("before_tool_call", () => ({
              params: { overridden: true },
            }));
            return ok(undefined);
          },
        }),
      );

      await runner.runBeforeToolCall(
        { toolName: "read_file", params: { path: "/tmp" } },
        { agentId: "a" },
      );

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.actionType).toBe("hook_modification");
      expect(auditEvents[0]!.metadata?.hookName).toBe("before_tool_call");
      expect(auditEvents[0]!.metadata?.paramsModified).toBe(true);
    });

    it("emits audit:event when before_tool_call blocks execution", async () => {
      const eventBus = new TypedEventBus();
      const registry = createPluginRegistry({ eventBus });
      const runner = createHookRunner(registry, { eventBus });

      const auditEvents: EventMap["audit:event"][] = [];
      eventBus.on("audit:event", (e) => auditEvents.push(e));

      registry.register(
        createTestPlugin({
          id: "tool-blocker",
          register: (api) => {
            api.registerHook("before_tool_call", () => ({
              block: true,
              blockReason: "forbidden",
            }));
            return ok(undefined);
          },
        }),
      );

      await runner.runBeforeToolCall(
        { toolName: "shell:exec", params: {} },
        { agentId: "a" },
      );

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.metadata?.blocked).toBe(true);
      expect(auditEvents[0]!.metadata?.blockReason).toBe("forbidden");
    });
  });
});
