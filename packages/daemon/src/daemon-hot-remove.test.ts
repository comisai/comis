// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createHotRemove } from "./daemon.js";

function keyedMap(value: unknown): Map<string, unknown> {
  return new Map([["agent-a", value]]);
}

describe("agent hot-removal lifecycle", () => {
  it("retires proactive and scheduler ownership before publishing removal", async () => {
    const retireProactiveAgent = vi.fn(() => ({
      heartbeatTargetRemoved: true,
      droppedExtractionCount: 1,
      activeExtractionCount: 0,
      activeTaskCheckCount: 0,
    }));
    const retireSchedulerAgent = vi.fn(async () => ({
      ok: true as const,
      value: undefined,
    }));
    const emit = vi.fn();
    const context = {
      activeRunRegistry: new Map(),
      daemonLogger: { warn: vi.fn(), info: vi.fn() },
      skillWatcherHandles: new Map(),
      executors: keyedMap({}),
      workspaceDirs: keyedMap("/workspace/agent-a"),
      costTrackers: keyedMap({}),
      budgetGuards: keyedMap({}),
      stepCounters: keyedMap({}),
      piSessionAdapters: keyedMap({}),
      skillRegistries: keyedMap({}),
      toolCapabilityPorts: keyedMap({}),
      proactiveSchedulers: { retireAgent: retireProactiveAgent },
      retireAgentRuntime: retireSchedulerAgent,
      container: { eventBus: { emit } },
    };
    const hotRemove = createHotRemove({ channels: context as never });

    await hotRemove("agent-a");

    expect(retireProactiveAgent).toHaveBeenCalledWith("agent-a");
    expect(retireSchedulerAgent).toHaveBeenCalledWith("agent-a");
    expect(retireProactiveAgent.mock.invocationCallOrder[0]).toBeLessThan(
      retireSchedulerAgent.mock.invocationCallOrder[0]!,
    );
    expect(retireSchedulerAgent.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0]!,
    );
    expect(context.executors.has("agent-a")).toBe(false);
    expect(context.workspaceDirs.has("agent-a")).toBe(false);
    expect(context.costTrackers.has("agent-a")).toBe(false);
    expect(context.budgetGuards.has("agent-a")).toBe(false);
    expect(context.stepCounters.has("agent-a")).toBe(false);
    expect(context.piSessionAdapters.has("agent-a")).toBe(false);
    expect(context.skillRegistries.has("agent-a")).toBe(false);
    expect(context.toolCapabilityPorts.has("agent-a")).toBe(false);
    expect(emit).toHaveBeenCalledWith("agent:hot_removed", expect.objectContaining({
      agentId: "agent-a",
    }));
  });
});
