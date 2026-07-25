// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import { createCronHandlers, type CronHandlerDeps } from "./cron-handlers.js";

function createCoordinator() {
  return {
    submitWake: vi.fn(() => ok({
      status: "accepted" as const,
      disposition: "new_occurrence" as const,
      correlationId: "wake-1",
      lane: "normal" as const,
      retainedReason: "wake" as const,
    })),
  } as unknown as NonNullable<CronHandlerDeps["heartbeatCoordinator"]>;
}

function makeDeps(overrides: Partial<CronHandlerDeps> = {}): CronHandlerDeps {
  return {
    defaultAgentId: "agent-a",
    agents: { "agent-a": {} as never },
    clock: { now: () => 456_000, date: (value?: number) => new Date(value ?? 456_000) },
    schedulerNowMs: () => 456_000,
    heartbeatCoordinator: createCoordinator(),
    getAgentCronScheduler: vi.fn() as never,
    getAgentCronAuthoringConfig: vi.fn(() => ({
      defaultTimezone: "UTC",
      maxConsecutiveDependencyErrors: 3,
    })),
    cronSchedulers: new Map(),
    executionTrackers: new Map(),
    tenantId: "tenant-test",
    securityConfig: {},
    logger: {} as never,
    subAgentRunner: {} as never,
    ...overrides,
  };
}

describe("scheduler wake coordinator handler", () => {
  it("admits a routine wake for the caller agent target", async () => {
    const coordinator = createCoordinator();
    const handlers = createCronHandlers(makeDeps({ heartbeatCoordinator: coordinator }));

    const result = await handlers["scheduler.wake"]!({
      target: "agent",
      _agentId: "agent-a",
    });

    expect(coordinator.submitWake).toHaveBeenCalledWith({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "wake",
      timing: { kind: "routine", notBeforeMs: 456_000 },
    });
    expect(result).toMatchObject({
      status: "accepted",
      correlationId: "wake-1",
      retainedReason: "wake",
    });
  });

  it("admits the distinct monitoring target without selecting an agent", async () => {
    const coordinator = createCoordinator();
    const handlers = createCronHandlers(makeDeps({
      defaultAgentId: "missing",
      agents: {},
      heartbeatCoordinator: coordinator,
    }));

    await handlers["scheduler.wake"]!({ target: "monitoring" });

    expect(coordinator.submitWake).toHaveBeenCalledWith({
      target: { kind: "monitoring" },
      reason: "wake",
      timing: { kind: "routine", notBeforeMs: 456_000 },
    });
  });

  it("rejects an agent wake when the selected agent is not configured", async () => {
    const handlers = createCronHandlers(makeDeps({ defaultAgentId: "missing" }));

    await expect(handlers["scheduler.wake"]!({ target: "agent" }))
      .rejects.toThrow("Agent not found: missing");
  });
});
