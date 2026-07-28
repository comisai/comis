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
    const result = await setupProactiveSchedulers(deps(runtime({ cronEnabled: true })));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.code).toBe("dependency_unavailable");
    expect(result.error.errorKind).toBe("precondition");
  });

  // This guard collapses ELEVEN distinct runtime dependencies into one Result.
  // When any is missing the daemon throws
  // `FATAL: Proactive scheduler activation failed: <message>` and systemd
  // restart-loops — so the message is the ONLY diagnostic an operator gets, and
  // "Proactive scheduler dependency is unavailable" named none of the eleven.
  // Observed live on a fresh install: a boot crash-loop with nothing to act on.
  it("NAMES the missing dependencies so a boot crash-loop is diagnosable", async () => {
    const result = await setupProactiveSchedulers(deps(runtime({ cronEnabled: true })));
    if (result.ok) throw new Error("expected err");
    // At least one concrete dependency identifier must appear in the message.
    expect(result.error.message).toMatch(
      /workspaceDirs|getExecutor|piSessionAdapters|assembleToolsForAgent|sharedLeaseManager|boundedAutonomyBudgetHolder|capEndpointHandle|cronRuntimeBinding|activateCronSchedulers|deactivateCronSchedulers|getAgentSchedulerSeed/,
    );
    // …and it must still say what failed, for the FATAL prefix to read sensibly.
    expect(result.error.message).toMatch(/proactive scheduler/i);
  });

  it("binds and activates the complete task runtime instead of leaving an enabled capture-only path", () => {
    const source = readFileSync(new URL("./setup-proactive-schedulers.ts", import.meta.url), "utf8");
    expect(source).toContain("createFollowupTaskRuntime(");
    expect(source).toContain("await taskRuntime.initialize()");
    expect(source).toContain("activateTaskSchedules: () => {");
    expect(source).toContain("const result = taskRuntime.activate()");
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
