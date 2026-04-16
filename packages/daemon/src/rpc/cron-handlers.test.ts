import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCronHandlers } from "./cron-handlers.js";
import type { CronHandlerDeps } from "./cron-handlers.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock buildCronSchedule to return deterministic schedule objects
vi.mock("../wiring/daemon-utils.js", () => ({
  buildCronSchedule: vi.fn((kind: string, params: Record<string, unknown>) => {
    if (kind === "every") return { kind: "every" as const, everyMs: params.schedule_every_ms as number };
    if (kind === "cron") return { kind: "cron" as const, expr: params.schedule_expr as string, tz: undefined };
    return { kind: "at" as const, at: params.schedule_at as string };
  }),
}));

// Mock sanitizeToolOutput to pass-through (tested elsewhere)
vi.mock("@comis/agent", () => ({
  sanitizeToolOutput: vi.fn((text: string) => text),
}));

// Deterministic UUID
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-job-uuid",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockScheduler() {
  const testJob = {
    id: "job-1",
    name: "test-job",
    agentId: "default",
    enabled: true,
    schedule: { kind: "every" as const, everyMs: 60000 },
    payload: { kind: "agent_turn" as const, message: "hello" },
    sessionTarget: "isolated" as const,
    nextRunAtMs: 0,
    lastRunAtMs: 0,
    consecutiveErrors: 0,
    createdAtMs: 1000,
  };

  return {
    addJob: vi.fn(async () => undefined),
    getJobs: vi.fn(() => [testJob]),
    removeJob: vi.fn(async () => true),
    runMissedJobs: vi.fn(async () => undefined),
    _testJob: testJob,
  };
}

function makeMockTracker() {
  return {
    getHistory: vi.fn(async () => [
      { runId: "r1", jobId: "job-1", startedAt: 1000, completedAt: 2000, status: "ok" },
    ]),
  };
}

function makeDeps(overrides?: Partial<CronHandlerDeps>): CronHandlerDeps {
  const mockScheduler = makeMockScheduler();
  return {
    defaultAgentId: "default",
    getAgentCronScheduler: vi.fn(() => mockScheduler),
    cronSchedulers: new Map([["default", mockScheduler as never]]),
    executionTrackers: new Map([["default", makeMockTracker() as never]]),
    wakeCoalescer: { requestHeartbeatNow: vi.fn(), shutdown: vi.fn() } as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCronHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // cron.add
  // -------------------------------------------------------------------------

  describe("cron.add", () => {
    it("adds a job with agentTurn payload and returns jobId/name/schedule", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "morning-greeting",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "Good morning!",
      })) as { jobId: string; name: string; schedule: { kind: string } };

      expect(result.jobId).toBe("test-job-uuid");
      expect(result.name).toBe("morning-greeting");
      expect(result.schedule.kind).toBe("every");
      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("default");
    });

    it("adds a job with systemEvent payload kind", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "heartbeat-check",
        schedule_kind: "every",
        schedule_every_ms: 30000,
        payload_kind: "system_event",
        payload_text: "check-health",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "system_event", text: "check-health" },
        }),
      );
    });

    it("uses _agentId from params when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.add"]!({
        name: "custom-agent-job",
        schedule_kind: "every",
        schedule_every_ms: 10000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        _agentId: "agent-2",
      });

      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("agent-2");
    });

    it("accepts session_target and wake_mode from params", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "main-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "check in",
        session_target: "main",
        wake_mode: "now",
        forward_to_main: false,
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTarget: "main",
          wakeMode: "now",
          forwardToMain: false,
        }),
      );
    });

    it("defaults sessionTarget to isolated and wakeMode to next-heartbeat when not provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "default-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "hello",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          forwardToMain: false,
        }),
      );
    });

    it("propagates session_strategy and max_history_turns into created job", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "rolling-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        session_strategy: "rolling",
        max_history_turns: 5,
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStrategy: "rolling",
          maxHistoryTurns: 5,
        }),
      );
    });

    it("defaults sessionStrategy to 'fresh' when session_strategy not provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "default-strategy-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "hello",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStrategy: "fresh",
        }),
      );
    });

    it("sets model on agent_turn payload when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        model: "gemini-2.5-flash",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "agent_turn", message: "hello", model: "gemini-2.5-flash" },
        }),
      );
    });

    it("does NOT set model on system_event payload", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "sys-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "check",
        model: "gemini-2.5-flash",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "system_event", text: "check" },
        }),
      );
    });

    it("omits model from agent_turn payload when not provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "no-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "agent_turn", message: "hello" },
        }),
      );
    });

    it("includes model in cron.add response for agent_turn", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "model-response-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        model: "gemini-2.5-flash",
      })) as { model: string };

      expect(result.model).toBe("gemini-2.5-flash");
    });

    it("includes model as 'default' in response when not specified for agent_turn", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "default-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
      })) as { model: string };

      expect(result.model).toBe("default");
    });

    it("does not include model in response for system_event", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "sys-no-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "check",
      })) as { model?: string };

      expect(result.model).toBeUndefined();
    });

    it("rejects duplicate job name", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.add"]!({
          name: "test-job",
          schedule_kind: "every",
          schedule_every_ms: 60000,
          payload_kind: "agent_turn",
          payload_text: "hello",
        }),
      ).rejects.toThrow('A job named "test-job" already exists');
    });
  });

  // -------------------------------------------------------------------------
  // cron.list
  // -------------------------------------------------------------------------

  describe("cron.list", () => {
    it("returns job list with expected fields", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{
          id: string;
          name: string;
          enabled: boolean;
          schedule: { kind: string };
          nextRunAtMs: number;
          lastRunAtMs: number;
          consecutiveErrors: number;
        }>;
      };

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]!.id).toBe("job-1");
      expect(result.jobs[0]!.name).toBe("test-job");
      expect(result.jobs[0]!.enabled).toBe(true);
      expect(result.jobs[0]!.schedule.kind).toBe("every");
      expect(result.jobs[0]!.consecutiveErrors).toBe(0);
      // Fields added for web UI
      expect(result.jobs[0]!.agentId).toBe("default");
      expect(result.jobs[0]!.sessionTarget).toBe("isolated");
      expect(result.jobs[0]!.payload).toEqual({ kind: "agent_turn", message: "hello" });
      expect(result.jobs[0]!.createdAtMs).toBe(1000);
    });

    it("uses _agentId from params to look up correct scheduler", async () => {
      const mockScheduler = makeMockScheduler();
      const deps = makeDeps({
        cronSchedulers: new Map([["agent-3", mockScheduler as never]]),
      });
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({ _agentId: "agent-3" })) as {
        jobs: Array<{ id: string }>;
      };

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]!.id).toBe("job-1");
    });

    it("returns empty jobs list when cron is not enabled for agent", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({ _agentId: "no-such-agent" })) as {
        jobs: unknown[];
      };

      expect(result.jobs).toEqual([]);
    });

    it("returns deliveryTarget when present on a job", async () => {
      const mockScheduler = makeMockScheduler();
      (mockScheduler._testJob as Record<string, unknown>).deliveryTarget = {
        channelId: "chan-1",
        userId: "user-1",
        tenantId: "tenant-1",
        channelType: "telegram",
      };
      const deps = makeDeps({
        cronSchedulers: new Map([["default", mockScheduler as never]]),
      });
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{ deliveryTarget?: { channelId: string; channelType?: string } }>;
      };

      expect(result.jobs[0]!.deliveryTarget).toEqual({
        channelId: "chan-1",
        userId: "user-1",
        tenantId: "tenant-1",
        channelType: "telegram",
      });
    });

    it("returns deliveryTarget as undefined when not set on a job", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{ deliveryTarget?: unknown }>;
      };

      expect(result.jobs[0]!.deliveryTarget).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // cron.update
  // -------------------------------------------------------------------------

  describe("cron.update", () => {
    it("updates job enabled field and returns success", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobName: "test-job",
        enabled: false,
      })) as { jobName: string; updated: boolean };

      expect(result.jobName).toBe("test-job");
      expect(result.updated).toBe(true);
    });

    it("throws when job is not found by name", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.update"]!({ jobName: "nonexistent-job", enabled: true }),
      ).rejects.toThrow("Job not found: nonexistent-job");
    });

    it("updates job name when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobName: "test-job",
        name: "renamed-job",
      })) as { updated: boolean };

      expect(result.updated).toBe(true);
    });

    it("resolves job by jobId (web UI path)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobId: "job-1",
        enabled: false,
      })) as { jobName: string; updated: boolean };

      expect(result.updated).toBe(true);
      expect(result.jobName).toBe("test-job");
    });

    it("throws when jobId not found", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.update"]!({ jobId: "nonexistent-id", enabled: true }),
      ).rejects.toThrow("Job not found: nonexistent-id");
    });

    it("updates sessionTarget, schedule, and message", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      // Get the shared scheduler instance to inspect mutations
      const scheduler = deps.getAgentCronScheduler("default");

      await handlers["cron.update"]!({
        jobId: "job-1",
        sessionTarget: "main",
        schedule: { kind: "every", everyMs: 120000 },
        message: "updated prompt",
      });

      const job = scheduler.getJobs()[0]!;
      expect(job.sessionTarget).toBe("main");
      expect(job.schedule).toEqual({ kind: "every", everyMs: 120000 });
      expect(job.payload.message).toBe("updated prompt");
    });

    it("sets deliveryTarget when provided as an object", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");

      const target = { channelId: "chan-1", userId: "user-1", tenantId: "t-1", channelType: "telegram" };
      await handlers["cron.update"]!({
        jobId: "job-1",
        deliveryTarget: target,
      });

      const job = scheduler.getJobs()[0]!;
      expect(job.deliveryTarget).toEqual(target);
    });

    it("clears deliveryTarget when set to null", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");
      // Pre-set a deliveryTarget
      const job = scheduler.getJobs()[0]!;
      (job as Record<string, unknown>).deliveryTarget = { channelId: "c", userId: "u", tenantId: "t" };

      await handlers["cron.update"]!({
        jobId: "job-1",
        deliveryTarget: null,
      });

      expect(scheduler.getJobs()[0]!.deliveryTarget).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // cron.remove
  // -------------------------------------------------------------------------

  describe("cron.remove", () => {
    it("removes job by name and returns removed: true", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.remove"]!({
        jobName: "test-job",
      })) as { jobName: string; removed: boolean };

      expect(result.jobName).toBe("test-job");
      expect(result.removed).toBe(true);
    });

    it("uses _agentId to look up correct scheduler", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.remove"]!({ jobName: "test-job", _agentId: "agent-5" });

      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("agent-5");
    });
  });

  // -------------------------------------------------------------------------
  // cron.status
  // -------------------------------------------------------------------------

  describe("cron.status", () => {
    it("returns running: true and jobCount when scheduler exists", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.status"]!({})) as {
        running: boolean;
        jobCount: number;
      };

      expect(result.running).toBe(true);
      expect(result.jobCount).toBe(1);
    });

    it("returns running: false, jobCount: 0 when no scheduler for agent", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.status"]!({
        _agentId: "unknown-agent",
      })) as { running: boolean; jobCount: number };

      expect(result.running).toBe(false);
      expect(result.jobCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // cron.runs
  // -------------------------------------------------------------------------

  describe("cron.runs", () => {
    it("returns execution history when tracker exists", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.runs"]!({
        jobName: "test-job",
      })) as { runs: Array<{ runId: string; startedAt: number }> };

      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.runId).toBe("r1");
    });

    it("returns empty runs array when no tracker exists", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.runs"]!({
        jobName: "test-job",
        _agentId: "no-tracker-agent",
      })) as { runs: unknown[] };

      expect(result.runs).toEqual([]);
    });

    it("passes limit parameter to tracker.getHistory (resolves name to id)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const tracker = deps.executionTrackers.get("default")!;

      await handlers["cron.runs"]!({ jobName: "test-job", limit: 5 });

      expect((tracker as unknown as { getHistory: ReturnType<typeof vi.fn> }).getHistory).toHaveBeenCalledWith("job-1", 5);
    });
  });

  // -------------------------------------------------------------------------
  // cron.run
  // -------------------------------------------------------------------------

  describe("cron.run", () => {
    it("force mode resolves job by name, executes via runMissedJobs, and returns triggered: true", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
        mode: "force",
      })) as { triggered: boolean; mode: string; jobName: string };

      expect(result.triggered).toBe(true);
      expect(result.mode).toBe("force");
      expect(result.jobName).toBe("test-job");
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });

    it("force mode sets nextRunAtMs to 0 on matched job before calling runMissedJobs", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      // Set a future nextRunAtMs so we can verify it gets reset to 0
      scheduler._testJob.nextRunAtMs = Date.now() + 999999;

      await handlers["cron.run"]!({ jobName: "test-job", mode: "force" });

      // Handler should have mutated the shared job reference to make it immediately due
      expect(scheduler._testJob.nextRunAtMs).toBe(0);
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });

    it("due mode calls runMissedJobs and returns triggered: true, mode: due", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
        mode: "due",
      })) as { triggered: boolean; mode: string };

      expect(result.triggered).toBe(true);
      expect(result.mode).toBe("due");
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });

    it("throws when job not found by name in force mode", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.run"]!({ jobName: "nonexistent", mode: "force" }),
      ).rejects.toThrow("Job not found: nonexistent");
    });

    it("defaults to force mode when mode param is not specified", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
      })) as { mode: string };

      expect(result.mode).toBe("force");
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // scheduler.wake
  // -------------------------------------------------------------------------

  describe("scheduler.wake", () => {
    it("calls wakeCoalescer.requestHeartbeatNow and returns woke: true", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["scheduler.wake"]!({})) as {
        woke: boolean;
        source: string;
      };

      expect(result.woke).toBe(true);
      expect(result.source).toBe("agent");
      expect(
        (deps.wakeCoalescer as unknown as { requestHeartbeatNow: ReturnType<typeof vi.fn> }).requestHeartbeatNow,
      ).toHaveBeenCalledWith("wake");
    });

    it("passes source param through when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["scheduler.wake"]!({
        source: "scheduler",
      })) as { source: string };

      expect(result.source).toBe("scheduler");
    });
  });
});
