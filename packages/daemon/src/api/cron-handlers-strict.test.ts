// SPDX-License-Identifier: Apache-2.0
import { createConversationRef } from "@comis/core";
import { err, ok } from "@comis/shared";
import type {
  CronDeliveryTarget,
  CronJob,
  CronScheduler,
  ExecutionTracker,
} from "@comis/scheduler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { withHeldCapabilities } from "../../../../test/support/held-capabilities.js";
import { createCronHandlers as createCronHandlersRaw } from "./cron-handlers.js";
import type { CronHandlerDeps } from "./cron-handlers.js";

const NOW_MS = 1_800_000_000_000;

function target(agentId = "agent-a"): CronDeliveryTarget {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "chat-a",
    threadId: "thread-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId,
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    conversation: { conversationScope, conversationRef: conversationRef.value },
    destinationEndpoint,
  };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-a",
    name: "Daily status",
    agentId: "agent-a",
    source: "authored",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
    lifecycle: {
      status: "scheduled",
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    },
    payload: { kind: "agent_turn", message: "Summarize status" },
    sessionPolicy: { strategy: "fresh" },
    continuationMode: "none",
    ...overrides,
  } as CronJob;
}

function scheduler(jobs: CronJob[] = [job()]): CronScheduler {
  return {
    initialize: vi.fn(async () => ok(undefined)),
    reload: vi.fn(async () => ok(undefined)),
    activate: vi.fn(() => ok(undefined)),
    enterMaintenance: vi.fn(() => ok({ activeExecutions: 0 })),
    stop: vi.fn(async () => ok(undefined)),
    addJob: vi.fn(async () => ok(undefined)),
    replaceJob: vi.fn(async () => ok(undefined)),
    removeJob: vi.fn(async () => ok(true)),
    getJobs: vi.fn(() => ok(jobs)),
    runMissedJobs: vi.fn(async () => ok([])),
    runJob: vi.fn(async () => ok("execution-a")),
  };
}

function maintenance() {
  return {
    initialize: vi.fn(async () => ok(undefined)),
    activate: vi.fn(() => ok(undefined)),
    status: vi.fn(async () => ok({
      state: "failed" as const,
      configuredEnabled: true,
      strictAuthoritiesValid: false,
      ownershipReconciled: false,
      jobCount: 0,
      activeClaimCount: 0,
      store: { exists: true, bytes: 10, digest: "a".repeat(64) },
      ledger: { exists: true, bytes: 20, digest: "b".repeat(64) },
      intent: { status: "none" as const },
      lastError: { code: "initialization_failed" as const, errorKind: "validation" as const },
    })),
    reset: vi.fn(async () => ok({
      operationId: "operation-a",
      target: "all" as const,
      beforeDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      afterDigests: { store: "c".repeat(64), ledger: "d".repeat(64) },
      state: "active" as const,
      reactivated: true,
    })),
  };
}

function tracker(history: unknown[] = []): ExecutionTracker {
  return {
    initialize: vi.fn(async () => ok({ executions: 0, fileDigest: "a".repeat(64) })),
    appendStart: vi.fn(async () => ok(undefined)),
    appendTerminal: vi.fn(async () => ok(undefined)),
    readExecution: vi.fn(async () => ok(undefined)),
    listHistory: vi.fn(async () => ok(history as never)),
    prune: vi.fn(async () => ok(undefined)),
  };
}

function deps(
  cronScheduler = scheduler(),
  overrides: Partial<CronHandlerDeps> = {},
): CronHandlerDeps {
  return {
    defaultAgentId: "agent-a",
    getAgentCronScheduler: vi.fn(() => cronScheduler),
    getAgentCronAuthoringConfig: vi.fn(() => ({
      defaultTimezone: "UTC",
      maxConsecutiveDependencyErrors: 5,
    })),
    cronSchedulers: new Map([["agent-a", cronScheduler]]),
    executionTrackers: new Map([["agent-a", tracker()]]),
    cronMaintenanceControllers: new Map([["agent-a", maintenance()]]) as never,
    agents: { "agent-a": {} as never },
    schedulerNowMs: () => NOW_MS,
    clock: createFakeClock(NOW_MS),
    ...overrides,
  } as CronHandlerDeps;
}

function handlers(input: CronHandlerDeps) {
  return withHeldCapabilities(createCronHandlersRaw(input));
}

describe("strict cron RPC mutations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves authoring time once and persists only the strict agent-turn variant", async () => {
    const cronScheduler = scheduler([]);
    const bound = handlers(deps(cronScheduler));

    await bound["cron.add"]!({
      name: "One-shot status",
      schedule: { kind: "in", seconds: 90 },
      payload: { kind: "agent_turn", message: "Summarize status" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 4 },
      continuationMode: "none",
    });

    expect(cronScheduler.addJob).toHaveBeenCalledWith(expect.objectContaining({
      source: "authored",
      schedule: { kind: "at", atMs: NOW_MS + 90_000 },
      lifecycle: {
        status: "scheduled",
        nextRunAtMs: NOW_MS + 90_000,
        consecutiveDependencyErrors: 0,
      },
      payload: { kind: "agent_turn", message: "Summarize status" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 4 },
      continuationMode: "none",
    }));
    const added = vi.mocked(cronScheduler.addJob).mock.calls[0]![0] as Record<string, unknown>;
    expect(added).not.toHaveProperty("sessionTarget");
    expect(added).not.toHaveProperty("enabled");
    expect(added).not.toHaveProperty("createdAtMs");
  });

  it("rejects the removed flat and system-event authoring shape", async () => {
    const bound = handlers(deps(scheduler([])));
    await expect(bound["cron.add"]!({
      name: "Old shape",
      schedule_kind: "every",
      schedule_every_ms: 60_000,
      payload_kind: "system_event",
      payload_text: "check",
    })).rejects.toThrow();
  });

  it("binds agent authoring to the exact trusted target and rejects redirection", async () => {
    const cronScheduler = scheduler([]);
    const bound = handlers(deps(cronScheduler));
    const trusted = target();

    await bound["cron.add"]!({
      name: "Origin update",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "delivery", text: "Update" },
      deliveryTarget: trusted,
      _agentId: "agent-a",
      _deliveryTarget: trusted,
    });
    expect(cronScheduler.addJob).toHaveBeenCalledWith(expect.objectContaining({ deliveryTarget: trusted }));

    await expect(bound["cron.add"]!({
      name: "Redirected update",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "delivery", text: "Update" },
      deliveryTarget: target("agent-b"),
      _agentId: "agent-a",
      _deliveryTarget: trusted,
    })).rejects.toThrow(/trusted request route/i);
  });

  it("replaces authored jobs atomically and refuses config-owned mutation", async () => {
    const authored = job();
    const builtIn = job({
      id: "memory-review-agent-a",
      source: "built_in",
      payload: { kind: "internal_action", action: "memory_review" },
    } as Partial<CronJob>);
    const cronScheduler = scheduler([authored, builtIn]);
    const bound = handlers(deps(cronScheduler));

    await bound["cron.update"]!({ jobId: authored.id, name: "Renamed status" });
    expect(cronScheduler.replaceJob).toHaveBeenCalledWith(
      authored.id,
      expect.objectContaining({ id: authored.id, name: "Renamed status", source: "authored" }),
    );
    expect(authored.name).toBe("Daily status");

    await expect(bound["cron.update"]!({
      jobId: builtIn.id,
      name: "Changed built-in",
    })).rejects.toThrow(/config-owned/i);
  });

  it("manual run delegates to runJob without rewriting persisted lifecycle", async () => {
    const scheduled = job();
    const cronScheduler = scheduler([scheduled]);
    const bound = handlers(deps(cronScheduler));

    const result = await bound["cron.run"]!({ jobName: scheduled.name });

    expect(cronScheduler.runJob).toHaveBeenCalledWith(scheduled.id);
    expect(cronScheduler.runMissedJobs).not.toHaveBeenCalled();
    expect(scheduled.lifecycle).toEqual({
      status: "scheduled",
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    });
    expect(result).toEqual({
      triggered: true,
      mode: "force",
      jobName: scheduled.name,
      resolvedAgentId: "agent-a",
      executionId: "execution-a",
    });
  });

  it("surfaces scheduler Result failures instead of claiming mutation success", async () => {
    const cronScheduler = scheduler([]);
    vi.mocked(cronScheduler.addJob).mockResolvedValue(err({
      code: "operation_failed",
      errorKind: "resource",
      message: "Cron store is full",
    }));
    const bound = handlers(deps(cronScheduler));

    await expect(bound["cron.add"]!({
      name: "Capacity",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "heartbeat_event", text: "check", wakeMode: "now" },
    })).rejects.toThrow("Cron store is full");
  });

  it("lists only the selected agent unless an admin requests all agents", async () => {
    const agentA = scheduler([job()]);
    const agentB = scheduler([job({ id: "job-b", name: "Agent B", agentId: "agent-b" })]);
    const cronSchedulers = new Map([
      ["agent-a", agentA],
      ["agent-b", agentB],
    ]);
    const bound = handlers(deps(agentA, { cronSchedulers }));

    const selected = await bound["cron.list"]!({ _agentId: "agent-a" }) as { jobs: CronJob[] };
    const all = await bound["cron.list"]!({ agentId: "*", _trustLevel: "admin" }) as { jobs: CronJob[] };

    expect(selected.jobs.map((entry) => entry.id)).toEqual(["job-a"]);
    expect(all.jobs.map((entry) => entry.id)).toEqual(["job-a", "job-b"]);
    await expect(bound["cron.list"]!({ agentId: "*", _agentId: "agent-a" }))
      .rejects.toThrow(/admin access required/i);
  });

  it("reports raw failed-authority status without inventing a scheduler", async () => {
    const controller = maintenance();
    const bound = handlers(deps(scheduler([]), {
      cronSchedulers: new Map(),
      cronMaintenanceControllers: new Map([["agent-a", controller]]) as never,
    }));

    await expect(bound["cron.status"]!({})).resolves.toEqual({
      state: "failed",
      configuredEnabled: true,
      running: false,
      strictAuthoritiesValid: false,
      ownershipReconciled: false,
      jobCount: 0,
      activeClaimCount: 0,
      resolvedAgentId: "agent-a",
      store: { exists: true, bytes: 10, digest: "a".repeat(64) },
      ledger: { exists: true, bytes: 20, digest: "b".repeat(64) },
      intent: { status: "none" },
      lastError: { code: "initialization_failed", errorKind: "validation" },
    });
    expect(controller.status).toHaveBeenCalledOnce();
  });

  it("keeps cron.reset admin-only and forwards its exact digest CAS to one controller", async () => {
    const controller = maintenance();
    const bound = handlers(deps(scheduler([]), {
      cronMaintenanceControllers: new Map([["agent-a", controller]]) as never,
    }));
    const request = {
      target: "all" as const,
      expectedDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      confirmed: true,
      agentId: "agent-a",
    };

    await expect(bound["cron.reset"]!(request)).rejects.toThrow(/admin/i);
    await expect(bound["cron.reset"]!({ ...request, _trustLevel: "admin" })).resolves.toEqual({
      operationId: "operation-a",
      target: "all",
      resolvedAgentId: "agent-a",
      beforeDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      afterDigests: { store: "c".repeat(64), ledger: "d".repeat(64) },
      state: "active",
      reactivated: true,
    });
    expect(controller.reset).toHaveBeenCalledWith({
      target: "all",
      expectedDigests: request.expectedDigests,
      confirmed: true,
      actorScope: "admin",
    });
  });

  it("projects immutable ledger groups through cron.runs", async () => {
    const cronScheduler = scheduler([job()]);
    const history = [{
      start: {
        executionId: "execution-a",
        bootId: "boot-a",
        jobId: "job-a",
        agentId: "agent-a",
        scheduledForMs: NOW_MS,
        trigger: "manual",
        recordType: "started",
        workKind: "heartbeat_event",
        rootRunId: null,
        startedAtMs: NOW_MS,
      },
      terminal: {
        executionId: "execution-a",
        bootId: "boot-a",
        jobId: "job-a",
        agentId: "agent-a",
        scheduledForMs: NOW_MS,
        trigger: "manual",
        recordType: "terminal",
        workKind: "heartbeat_event",
        terminalAtMs: NOW_MS + 20,
        durationMs: 20,
        outcome: {
          kind: "heartbeat_event",
          correlationId: "heartbeat-a",
          queueDisposition: "accepted",
        },
      },
    }];
    const executionTracker = tracker(history);
    const bound = handlers(deps(cronScheduler, {
      executionTrackers: new Map([["agent-a", executionTracker]]),
    }));

    const result = await bound["cron.runs"]!({ jobName: "Daily status", limit: 7 });

    expect(executionTracker.listHistory).toHaveBeenCalledWith({ jobId: "job-a", limit: 7 });
    expect(result).toEqual({ runs: [{
      executionId: "execution-a",
      jobId: "job-a",
      agentId: "agent-a",
      scheduledForMs: NOW_MS,
      trigger: "manual",
      workKind: "heartbeat_event",
      rootRunId: null,
      startedAtMs: NOW_MS,
      terminalAtMs: NOW_MS + 20,
      durationMs: 20,
      status: "dispatched",
      deliveryStatus: "not_requested",
    }] });
  });

  it("removes authored jobs by stable id and rejects config-owned jobs", async () => {
    const authored = job();
    const builtIn = job({
      id: "reflection-agent-a",
      name: "Reflection",
      source: "built_in",
      payload: { kind: "internal_action", action: "reflection" },
    } as Partial<CronJob>);
    const cronScheduler = scheduler([authored, builtIn]);
    const bound = handlers(deps(cronScheduler));

    await expect(bound["cron.remove"]!({ jobId: authored.id })).resolves.toEqual({
      jobName: authored.name,
      removed: true,
    });
    expect(cronScheduler.removeJob).toHaveBeenCalledWith(authored.id);
    await expect(bound["cron.remove"]!({ jobId: builtIn.id }))
      .rejects.toThrow(/config-owned/i);
  });

  it("runs due occurrences through the scheduler and returns their execution identities", async () => {
    const cronScheduler = scheduler([job()]);
    vi.mocked(cronScheduler.runMissedJobs).mockResolvedValue(ok(["execution-a", "execution-b"]));
    const bound = handlers(deps(cronScheduler));

    await expect(bound["cron.run"]!({ mode: "due" })).resolves.toEqual({
      triggered: true,
      mode: "due",
      resolvedAgentId: "agent-a",
      executionIds: ["execution-a", "execution-b"],
    });
  });
});
