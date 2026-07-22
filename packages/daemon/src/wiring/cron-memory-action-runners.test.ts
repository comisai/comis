// SPDX-License-Identifier: Apache-2.0
import { ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCronMemoryActionRunners } from "./cron-memory-action-runners.js";

const NOW_MS = 1_800_000_000_000;

function lifecycleInput(): Extract<CronRuntimeExecutionInput, { kind: "internal_action" }> {
  return {
    executionId: "execution-a",
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "internal_action",
    rootRunId: "root-cron-execution-a",
    job: {
      id: "memory-lifecycle",
      name: "Memory lifecycle",
      agentId: "agent-a",
      source: "built_in",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
      lifecycle: { status: "scheduled", nextRunAtMs: NOW_MS + 60_000, consecutiveDependencyErrors: 0 },
      payload: { kind: "internal_action", action: "memory_lifecycle" },
    },
  };
}

function deps() {
  const emit = vi.fn();
  const runLifecycleSweep = vi.fn(async () => ok({
    scanned: 9,
    promoted: 0,
    demoted: 1,
    evicted: 2,
  }));
  return {
    container: {
      config: {
        agents: {
          "agent-a": {
            learning: { enabled: true, forget: { failureEvictionFloor: 3 } },
          },
        },
      },
      eventBus: { emit },
    } as never,
    tenantId: "tenant-a",
    clock: createFakeClock(NOW_MS),
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    workspaceDirs: new Map(),
    memoryAdapter: {} as never,
    sessionStore: {} as never,
    memoryLifecycleStore: { runLifecycleSweep } as never,
    _emit: emit,
    _runLifecycleSweep: runLifecycleSweep,
  };
}

describe("cron memory action runners", () => {
  it("returns lifecycle sweep counters and emits counts-only observations", async () => {
    const runtimeDeps = deps();
    const runners = createCronMemoryActionRunners(runtimeDeps);

    const result = await runners.executeMemoryLifecycle({
      input: lifecycleInput(),
      signal: new AbortController().signal,
    });

    expect(result).toEqual(ok({
      status: "completed",
      counters: [
        { name: "scanned", value: 9 },
        { name: "promoted", value: 0 },
        { name: "demoted", value: 1 },
        { name: "evicted", value: 2 },
      ],
    }));
    expect(runtimeDeps._runLifecycleSweep).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      agentId: "agent-a",
      now: NOW_MS,
      policy: { evictionEnabled: true, failureEvictionFloor: 3 },
    });
    expect(runtimeDeps._emit).toHaveBeenCalledWith("learning:lifecycle_swept", {
      agentId: "agent-a",
      scanned: 9,
      promoted: 0,
      demoted: 1,
      evicted: 2,
      timestamp: NOW_MS,
    });
  });

  it("honors cancellation before the lifecycle store is called", async () => {
    const runtimeDeps = deps();
    const runners = createCronMemoryActionRunners(runtimeDeps);
    const controller = new AbortController();
    controller.abort();

    const result = await runners.executeMemoryLifecycle({ input: lifecycleInput(), signal: controller.signal });

    expect(result).toMatchObject({ ok: false, error: { errorKind: "timeout" } });
    expect(runtimeDeps._runLifecycleSweep).not.toHaveBeenCalled();
  });
});
