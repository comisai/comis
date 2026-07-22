// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ok } from "@comis/shared";
import { setupProactiveSchedulers } from "./setup-proactive-schedulers.js";

function runtime(options: { tasksEnabled?: boolean; cronEnabled?: boolean } = {}) {
  let tasksEnabled = options.tasksEnabled ?? false;
  return {
    container: {
      config: {
        tenantId: "tenant-a",
        agents: {
          "agent-a": {
            scheduler: {
              cron: { enabled: options.cronEnabled ?? false },
              heartbeat: { enabled: false },
            },
          },
        },
        scheduler: {
          tasks: { enabled: tasksEnabled },
          cron: { enabled: false },
          heartbeat: { enabled: false },
        },
      },
      eventBus: {},
    },
    clock: {},
    timers: {},
    schedulerLogger: {},
    taskRuntimeGate: {
      isEnabled: () => tasksEnabled,
      disable: () => {
        if (!tasksEnabled) return { changed: false };
        tasksEnabled = false;
        return { changed: true };
      },
    },
  } as never;
}

function deps(proactiveRuntime: ReturnType<typeof runtime>) {
  return {
    runtime: proactiveRuntime,
    adaptersByType: new Map(),
    deliveryService: {},
    schedulerCorePortBindings: {
      bind: vi.fn(() => ok(undefined)),
      close: vi.fn(),
    },
  } as never;
}

describe("proactive scheduler composition", () => {
  it("rejects quiescent startup when scheduler lifecycle state is absent", async () => {
    await expect(setupProactiveSchedulers(deps(runtime()))).resolves.toEqual({
      ok: false,
      error: {
        code: "dependency_unavailable",
        errorKind: "precondition",
        message: "Scheduler initialization state is unavailable",
      },
    });
  });

  it("rejects active startup before side effects when runtime dependencies are absent", async () => {
    await expect(setupProactiveSchedulers(deps(runtime({ cronEnabled: true })))).resolves.toEqual({
      ok: false,
      error: {
        code: "dependency_unavailable",
        errorKind: "precondition",
        message: "Proactive scheduler dependency is unavailable",
      },
    });
  });

  it("binds and activates the complete task runtime instead of leaving an enabled capture-only path", () => {
    const source = readFileSync(new URL("./setup-proactive-schedulers.ts", import.meta.url), "utf8");
    expect(source).toContain("createFollowupTaskRuntime(");
    expect(source).toContain("await taskRuntime.activate()");
    expect(source).toContain("taskExtractionPort: taskRuntime.taskExtractionPort");
    expect(source).toContain("taskRuntime.executeTaskTurn(input)");
    expect(source).not.toContain("Task inference is enabled but its durable runtime is not bound");
  });

  it("keeps scheduler dependencies bound through drain and finalizes them explicitly", () => {
    const source = readFileSync(new URL("./setup-proactive-schedulers.ts", import.meta.url), "utf8");
    expect(source).toContain("closeAdmission()");
    expect(source).toContain("waitForIdle()");
    expect(source).toContain("abortActive()");
    expect(source).toContain("finalizeShutdown()");
    expect(source).toContain("historyState.accepting = false");
    expect(source).toContain("deps.schedulerCorePortBindings.close()");
  });

  it("disables only task lifecycle admission through the feature-disabled terminal reason", () => {
    const source = readFileSync(new URL("./setup-proactive-schedulers.ts", import.meta.url), "utf8");
    expect(source).toContain("const disableTasks =");
    expect(source).toContain("taskRuntimeGate.disable()");
    expect(source).toContain('coordinator.closeTaskLane(agentId, "feature_disabled")');
    expect(source).toContain("taskRuntime?.disable()");
  });

  it("provides per-agent auth storage to cron memory action runners", () => {
    const source = readFileSync(new URL("./setup-proactive-schedulers.ts", import.meta.url), "utf8");

    expect(source).toContain('| "authStorages"');
    expect(source).toMatch(
      /createCronMemoryActionRunners\(\{[\s\S]*?authStorages:\s*runtime\.authStorages[\s\S]*?\}\);/u,
    );
  });
});
