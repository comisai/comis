// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "./bus.js";

describe("capability-service lifecycle events", () => {
  it("delivers content-free activation and failed-instance payloads", () => {
    const bus = new TypedEventBus();
    const completed = vi.fn();
    const failed = vi.fn();
    bus.on("capability_service:activation_completed", completed);
    bus.on("capability_service:instance_failed", failed);

    bus.emit("capability_service:activation_completed", {
      revision: 1,
      viewHash: "a".repeat(64),
      activeCount: 1,
      failedCount: 0,
      durationMs: 4,
      timestamp: 1_800_000_000_000,
    });
    bus.emit("capability_service:instance_failed", {
      serviceInstanceId: "example-local",
      serviceDefinitionId: "example.service",
      reasonCode: "health_mismatch",
      cleanupFailed: false,
      timestamp: 1_800_000_000_001,
    });

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "health_mismatch",
    }));
  });
});
