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

  it("delivers a content-free accepted report index", () => {
    const bus = new TypedEventBus();
    const listener = vi.fn();
    bus.on("managed_run:report_accepted", listener);

    bus.emit("managed_run:report_accepted", {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      sequence: 2,
      kind: "progress",
      durationMs: 7,
      timestamp: 1_800_000_000_000,
    });

    expect(listener).toHaveBeenCalledWith({
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      sequence: 2,
      kind: "progress",
      durationMs: 7,
      timestamp: 1_800_000_000_000,
    });
  });

  it("delivers a content-free attention response transition", () => {
    const bus = new TypedEventBus();
    const listener = vi.fn();
    bus.on("managed_run:attention_response_bound", listener);

    bus.emit("managed_run:attention_response_bound", {
      managedRunId: "managed-run_a",
      attentionId: "attention_a",
      agentId: "agent_a",
      durationMs: 4,
      timestamp: 1_800_000_000_000,
    });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      attentionId: "attention_a",
      durationMs: 4,
    }));
  });

  it("delivers content-free attention response delivery outcomes", () => {
    const bus = new TypedEventBus();
    const delivered = vi.fn();
    const failed = vi.fn();
    bus.on("managed_run:attention_response_delivered", delivered);
    bus.on("managed_run:attention_response_delivery_failed", failed);

    bus.emit("managed_run:attention_response_delivered", {
      managedRunId: "managed-run_a",
      attentionId: "attention_a",
      serviceInstanceId: "service-instance_a",
      durationMs: 4,
      timestamp: 1_800_000_000_000,
    });
    bus.emit("managed_run:attention_response_delivery_failed", {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      reasonCode: "state_mismatch",
      timestamp: 1_800_000_000_000,
    });

    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
      attentionId: "attention_a",
      durationMs: 4,
    }));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "state_mismatch",
    }));
  });
});
