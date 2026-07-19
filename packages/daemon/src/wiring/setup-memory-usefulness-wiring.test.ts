// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for wireMemoryUsefulness() — the recall-utility write-back subscriber.
 *
 * The daemon is the ONLY place holding BOTH the bus AND the @comis/memory
 * adapter (the agent↛memory cut). This wiring subscribes to memory:recall_used
 * (emitted by @comis/agent's postExecution) and writes the signal through the
 * MemoryUsefulnessStore.recordUsage port.
 *
 * Load-bearing RED-first assertions (drive a REAL TypedEventBus):
 * - event → recordUsage called once with (usedIds, ignoredIds, scope) where the
 *   scope carries agentId from the EVENT + now from the injected clock
 * - per-agent scope: agentId is NOT collapsed; tenantId derived from sessionKey
 * - default-off: feedbackEnabled() === false → recordUsage NOT called (no write)
 * - empty usedIds AND ignoredIds → no write (nothing to persist)
 * - non-fatal: a recordUsage that rejects does NOT throw out of the bus handler
 */

import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { EventMap } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { wireMemoryUsefulness } from "./setup-memory-usefulness-wiring.js";

const NOW = 1_700_000_000_000;

function recallUsedPayload(
  overrides?: Partial<EventMap["memory:recall_used"]>,
): EventMap["memory:recall_used"] {
  return {
    agentId: "agent-1",
    sessionKey: "tenant-x:telegram:user-9",
    traceId: "trace-ru-001",
    usedIds: ["m1"],
    ignoredIds: ["m2"],
    usedCount: 1,
    ignoredCount: 1,
    timestamp: NOW,
    ...overrides,
  };
}

describe("wireMemoryUsefulness — bus → usefulnessStore.recordUsage write-back", () => {
  it("writes usedIds/ignoredIds through recordUsage with a per-agent scope (clock now)", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => true,
    });

    bus.emit("memory:recall_used", recallUsedPayload());
    // Bus handler is synchronous; the recordUsage promise is fire-and-forget.
    await Promise.resolve();

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      ["m1"],
      ["m2"],
      expect.objectContaining({ agentId: "agent-1", now: NOW }),
    );
  });

  it("forwards the event intent into the recordUsage scope (the per-intent bucket)", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => true,
    });

    bus.emit("memory:recall_used", recallUsedPayload({ intent: "temporal" }));
    await Promise.resolve();

    expect(recordUsage).toHaveBeenCalledTimes(1);
    const scope = recordUsage.mock.calls[0]![2] as { intent?: string };
    // The event's intent reaches recordUsage so the per-intent usefulness bucket
    // is actually written (the per-intent write side).
    expect(scope.intent).toBe("temporal");
  });

  it("omits intent from the scope when the event carries none (the GLOBAL bucket — byte-identical to the pre-per-intent write)", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => true,
    });

    // No `intent` override → the recallUsedPayload helper emits no intent field.
    bus.emit("memory:recall_used", recallUsedPayload());
    await Promise.resolve();

    expect(recordUsage).toHaveBeenCalledTimes(1);
    const scope = recordUsage.mock.calls[0]![2] as Record<string, unknown>;
    // No intent key at all (NOT intent: undefined) → the adapter resolves the
    // global bucket; the scope is byte-identical to the pre-per-intent write.
    expect("intent" in scope).toBe(false);
  });

  it("uses configured tenant authority instead of parsing the display session key", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => true,
    });

    bus.emit(
      "memory:recall_used",
      recallUsedPayload({ agentId: "agent-2", sessionKey: "tenant-y:discord:user-1" }),
    );
    await Promise.resolve();

    const scope = recordUsage.mock.calls[0]![2] as { tenantId: string; agentId: string };
    expect(scope.agentId).toBe("agent-2");
    expect(scope.tenantId).toBe("tenant-configured");
  });

  it("default-off: feedbackEnabled() === false → recordUsage is NOT called", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => false, // no agent has feedback on
    });

    bus.emit("memory:recall_used", recallUsedPayload());
    await Promise.resolve();

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("no-op when both usedIds and ignoredIds are empty (nothing to persist)", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => true,
    });

    bus.emit(
      "memory:recall_used",
      recallUsedPayload({ usedIds: [], ignoredIds: [], usedCount: 0, ignoredCount: 0 }),
    );
    await Promise.resolve();

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("is non-fatal: a recordUsage that returns err does not throw out of the handler (warns instead)", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(
      async (): Promise<Result<void, Error>> => err(new Error("db locked")),
    );
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };
    const logger = createMockLogger();

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger,
      feedbackEnabled: () => true,
    });

    // The emit (and the synchronous handler body) must not throw.
    expect(() => bus.emit("memory:recall_used", recallUsedPayload())).not.toThrow();
    // Let the fire-and-forget promise settle, then assert the warn path.
    await Promise.resolve();
    await Promise.resolve();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("is non-fatal: a recordUsage that REJECTS does not throw out of the handler", async () => {
    const bus = new TypedEventBus();
    const recordUsage = vi.fn(async (): Promise<Result<void, Error>> => {
      throw new Error("unexpected reject");
    });
    const usefulnessStore = {
      recordUsage,
      readUsefulness: vi.fn(async () => ok(new Map())),
    };

    wireMemoryUsefulness({
      tenantId: "tenant-configured",
      eventBus: bus,
      usefulnessStore,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      feedbackEnabled: () => true,
    });

    expect(() => bus.emit("memory:recall_used", recallUsedPayload())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });
});
