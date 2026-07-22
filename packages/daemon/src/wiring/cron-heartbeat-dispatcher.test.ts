// SPDX-License-Identifier: Apache-2.0
import { err, ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createCronHeartbeatDispatcher } from "./cron-heartbeat-dispatcher.js";

function input(wakeMode: "now" | "next-heartbeat"):
Extract<CronRuntimeExecutionInput, { kind: "heartbeat_event" }> {
  return {
    executionId: "execution-a",
    scheduledForMs: 1_800_000_000_000,
    trigger: "scheduled",
    kind: "heartbeat_event",
    job: {
      id: "job-a",
      name: "Inspect tasks",
      agentId: "agent-a",
      source: "authored",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
      lifecycle: {
        status: "scheduled",
        nextRunAtMs: 1_800_000_060_000,
        consecutiveDependencyErrors: 0,
      },
      payload: { kind: "heartbeat_event", text: "Inspect tasks", wakeMode },
    },
  };
}

function deps() {
  return {
    clock: { now: () => 1_800_000_000_000 },
    coordinator: {
      admitSystemEventWake: vi.fn(() => ok({
        queueDisposition: "accepted" as const,
        wake: {
          status: "accepted" as const,
          disposition: "new_occurrence" as const,
          correlationId: "heartbeat-execution-a",
          lane: "normal" as const,
          retainedReason: "cron" as const,
        },
      })),
    },
    resolveNextPeriodicPhaseMs: vi.fn(() => ok(1_800_000_060_000)),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

describe("cron heartbeat dispatcher", () => {
  it("returns one atomic admission for an immediate event and owning-agent occurrence", async () => {
    const runtimeDeps = deps();
    const dispatch = createCronHeartbeatDispatcher(runtimeDeps);

    const result = await dispatch(input("now"), new AbortController().signal);

    expect(result).toEqual(ok({
      correlationId: "heartbeat-execution-a",
      queueDisposition: "accepted",
    }));
    expect(runtimeDeps.coordinator.admitSystemEventWake).toHaveBeenCalledWith({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "cron",
      wakeMode: "now",
      notBeforeMs: 1_800_000_000_000,
      event: {
        trigger: "cron",
        contextKey: "cron:execution-a",
        text: "Inspect tasks",
      },
    });
  });

  it("queues next-heartbeat work without starting an immediate turn", async () => {
    const runtimeDeps = deps();
    const dispatch = createCronHeartbeatDispatcher(runtimeDeps);

    expect(await dispatch(input("next-heartbeat"), new AbortController().signal)).toEqual(ok({
      correlationId: "heartbeat-execution-a",
      queueDisposition: "accepted",
    }));
    expect(runtimeDeps.resolveNextPeriodicPhaseMs).toHaveBeenCalledWith("agent-a");
    expect(runtimeDeps.coordinator.admitSystemEventWake).toHaveBeenCalledWith(
      expect.objectContaining({ wakeMode: "next-heartbeat", notBeforeMs: 1_800_000_060_000 }),
    );
  });

  it("rejects next-heartbeat before queue mutation when no periodic occurrence exists", async () => {
    const runtimeDeps = deps();
    runtimeDeps.resolveNextPeriodicPhaseMs.mockReturnValue(err({
      message: "Periodic heartbeat is not enabled for the cron job owner",
      errorKind: "precondition" as const,
    }));
    const dispatch = createCronHeartbeatDispatcher(runtimeDeps);

    expect(await dispatch(input("next-heartbeat"), new AbortController().signal)).toEqual(err({
      code: "precondition_failed",
      errorKind: "precondition",
      message: "Periodic heartbeat is not enabled for the cron job owner",
    }));
    expect(runtimeDeps.coordinator.admitSystemEventWake).not.toHaveBeenCalled();
  });

  it("rejects cancellation before any queue or heartbeat side effect", async () => {
    const runtimeDeps = deps();
    const dispatch = createCronHeartbeatDispatcher(runtimeDeps);
    const controller = new AbortController();
    controller.abort();

    expect((await dispatch(input("now"), controller.signal)).ok).toBe(false);
    expect(runtimeDeps.coordinator.admitSystemEventWake).not.toHaveBeenCalled();
  });
});
