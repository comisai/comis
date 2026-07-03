// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for setup-startup-invariants.ts.
 *
 * Four behaviours verified:
 *   1. Normal clean boot → one INFO record, no WARN.
 *   2. Regression wiring (handlersPerAdapter > 1) → WARN with errorKind:"config".
 *   3. depSlotConsistency.adaptersList:true (a stale legacy dep slot) → WARN with errorKind:"config".
 *   4. alertBudgetPolicy provided → returns unsubscribe function; omitted → returns undefined.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { emitStartupInvariants, type StartupInvariantsDeps } from "./setup-startup-invariants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEchoAdapter() {
  return {
    channelId: "echo-test",
    channelType: "echo",
  };
}

function makeCleanDeps(overrides: Partial<StartupInvariantsDeps> = {}): StartupInvariantsDeps {
  const adapter = makeEchoAdapter();
  const adaptersByType = new Map([["echo", adapter as any]]);
  const rawHandlerCounts = new Map([["echo", 1]]);
  const channelPlugins = new Map([["echo", {} as any]]);
  return {
    logger: createMockLogger() as any,
    adaptersByType,
    rawHandlerCounts,
    channelPlugins,
    pluginRegistry: { count: vi.fn(() => 0) },
    mcpClientManager: { getTools: vi.fn(() => []) },
    agentsConfig: { default: {} as any },
    depSlotConsistency: { adaptersList: false, channelRegistry: true },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitStartupInvariants", () => {
  describe("normal clean boot (single echo adapter, no regression)", () => {
    it("emits exactly one INFO record with daemon:startup_invariants message", () => {
      const deps = makeCleanDeps();

      emitStartupInvariants(deps);

      expect(deps.logger.info).toHaveBeenCalledTimes(1);
      const [payload, message] = (deps.logger.info as any).mock.calls[0];
      expect(message).toBe("daemon:startup_invariants");
      expect(payload).toMatchObject({
        adaptersByChannelType: { echo: 1 },
        handlersPerAdapter: { echo: 1 },
        pluginRegistryCount: 0,
        channelRegistryCount: 1,
        depSlotConsistency: { adaptersList: false, channelRegistry: true },
        agentCount: 1,
        toolCatalogSize: 0,
        mcpServerCount: 0,
      });
    });

    it("does NOT call logger.warn on clean boot", () => {
      const deps = makeCleanDeps();

      emitStartupInvariants(deps);

      expect(deps.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("regression wiring — handlersPerAdapter > 1", () => {
    it("emits WARN with errorKind:config and verbatim hint when raw handler count exceeds 1", () => {
      const adapter = makeEchoAdapter();
      const deps = makeCleanDeps({
        adaptersByType: new Map([["telegram", adapter as any]]),
        rawHandlerCounts: new Map([["telegram", 2]]),
        channelPlugins: new Map(),
        agentsConfig: {},
      });

      emitStartupInvariants(deps);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "telegram",
          count: 2,
          hint: "Duplicate adapter registration detected; see AGENTS.md §6.1",
          errorKind: "config",
        }),
        expect.any(String),
      );
    });

    it("still emits the INFO record (with handlersPerAdapter showing the duplicate count)", () => {
      const adapter = makeEchoAdapter();
      const deps = makeCleanDeps({
        adaptersByType: new Map([["telegram", adapter as any]]),
        rawHandlerCounts: new Map([["telegram", 2]]),
        channelPlugins: new Map(),
        agentsConfig: {},
      });

      emitStartupInvariants(deps);

      expect(deps.logger.info).toHaveBeenCalledTimes(1);
      const [payload] = (deps.logger.info as any).mock.calls[0];
      expect(payload.handlersPerAdapter).toEqual({ telegram: 2 });
    });
  });

  describe("depSlotConsistency.adaptersList:true signals a stale legacy dep slot", () => {
    it("emits WARN with errorKind:config and verbatim hint when adaptersList is true", () => {
      const deps = makeCleanDeps({
        depSlotConsistency: { adaptersList: true, channelRegistry: true },
      });

      emitStartupInvariants(deps);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Duplicate adapter registration detected; see AGENTS.md §6.1",
          errorKind: "config",
          adaptersList: true,
        }),
        expect.any(String),
      );
    });
  });

  describe("health aggregator wiring", () => {
    it("returns undefined when alertBudgetPolicy not provided", () => {
      const deps = makeCleanDeps();
      const result = emitStartupInvariants(deps);
      expect(result).toBeUndefined();
    });

    it("returns an unsubscribe function when alertBudgetPolicy and eventBus are provided", () => {
      const eventBus = new TypedEventBus();
      const deps = makeCleanDeps({
        alertBudgetPolicy: {
          enabled: true,
          thresholds: { network: { count: 100, windowMs: 60_000 } },
        },
        eventBus,
      });
      const result = emitStartupInvariants(deps);
      expect(typeof result).toBe("function");
    });

    it("returned unsubscribe stops aggregator subscriptions", () => {
      const eventBus = new TypedEventBus();
      const budgetListener = vi.fn();
      eventBus.on("health:budget_exceeded", budgetListener);

      const deps = makeCleanDeps({
        alertBudgetPolicy: {
          enabled: true,
          thresholds: { network: { count: 1, windowMs: 60_000 } },
        },
        eventBus,
      });
      const unsub = emitStartupInvariants(deps);
      expect(typeof unsub).toBe("function");

      // Unsubscribe first — aggregator should no longer fire.
      unsub!();

      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: "tc-1",
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });

      expect(budgetListener).not.toHaveBeenCalled();
    });
  });
});
