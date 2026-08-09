// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "./bus.js";

describe("managed-run lifecycle events", () => {
  it("delivers a content-free activation transition", () => {
    const bus = new TypedEventBus();
    const listener = vi.fn();
    bus.on("managed_run:activated", listener);

    bus.emit("managed_run:activated", {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      agentId: "agent_a",
      durationMs: 12,
      timestamp: 1_800_000_000_000,
    });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      managedRunId: "managed-run_a",
      durationMs: 12,
    }));
  });
});
