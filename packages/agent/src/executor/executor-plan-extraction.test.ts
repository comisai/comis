// SPDX-License-Identifier: Apache-2.0
import type { ComisLogger, TypedEventBus } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { extractExecutionPlan } from "./executor-plan-extraction.js";

function makeDeps() {
  const info = vi.fn();
  const emit = vi.fn();
  return {
    info,
    emit,
    logger: { info } as unknown as ComisLogger,
    eventBus: { emit } as unknown as TypedEventBus,
    clock: createFakeClock(1_000),
  };
}

describe("extractExecutionPlan", () => {
  it("returns a bounded plan and emits its extraction receipt", () => {
    const deps = makeDeps();
    const plan = extractExecutionPlan({
      response: "1. Inspect inputs\n2. Produce result\n3. Verify result",
      messageText: "Perform the requested workflow",
      maxSteps: 2,
      minSteps: 2,
      executionStartMs: 900,
      agentId: "agent-a",
      formattedKey: "tenant:echo:user_a",
      ...deps,
    });

    expect(plan?.steps).toHaveLength(2);
    expect(plan?.request).toBe("Perform the requested workflow");
    expect(deps.emit).toHaveBeenCalledWith("sep:plan_extracted", {
      agentId: "agent-a",
      sessionKey: "tenant:echo:user_a",
      stepCount: 2,
      timestamp: 1_000,
    });
    expect(deps.info).toHaveBeenCalledWith(
      { agentId: "agent-a", stepCount: 2, durationMs: 100 },
      "SEP plan extracted",
    );
  });

  it("returns undefined and emits nothing for a response below the step floor", () => {
    const deps = makeDeps();
    const plan = extractExecutionPlan({
      response: "1. Inspect inputs\n2. Produce result",
      messageText: "Perform the requested workflow",
      maxSteps: 4,
      minSteps: 3,
      executionStartMs: 900,
      agentId: undefined,
      formattedKey: "tenant:echo:user_a",
      ...deps,
    });

    expect(plan).toBeUndefined();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.info).not.toHaveBeenCalled();
  });
});
