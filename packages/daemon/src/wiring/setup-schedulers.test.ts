// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCreateCronScheduler = vi.hoisted(() => vi.fn(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
})));
const mockCreateCronStore = vi.hoisted(() => vi.fn(() => ({
  load: vi.fn(),
  save: vi.fn(),
})));
const mockCreateExecutionTracker = vi.hoisted(() => vi.fn(() => ({
  record: vi.fn(async () => {}),
  getRecent: vi.fn(() => []),
})));
const mockCreateSessionResetScheduler = vi.hoisted(() => vi.fn(() => ({
  start: vi.fn(),
  stop: vi.fn(),
})));
const mockCreateBrowserService = vi.hoisted(() => vi.fn(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
})));
const mockSafePath = vi.hoisted(() => vi.fn((...parts: string[]) => parts.join("/")));
const mockSkillsConfigSchemaParse = vi.hoisted(() => vi.fn(() => ({
  builtinTools: { browser: false, exec: false, process: false },
  toolPolicy: { profile: "default" },
})));
const mockMkdir = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@comis/scheduler", () => ({
  createCronScheduler: mockCreateCronScheduler,
  createCronStore: mockCreateCronStore,
  createExecutionTracker: mockCreateExecutionTracker,
  resolveEffectiveHeartbeatConfig: vi.fn(() => ({ enabled: false, intervalMs: 60000 })),
  resolveHeartbeatSessionKey: vi.fn(() => ({ tenantId: "test", userId: "heartbeat", channelId: "hb-agent-1" })),
}));

vi.mock("@comis/agent", () => ({
  createSessionResetScheduler: mockCreateSessionResetScheduler,
}));

vi.mock("@comis/skills", () => ({
  createBrowserService: mockCreateBrowserService,
}));

vi.mock("@comis/core", () => ({
  safePath: mockSafePath,
  SkillsConfigSchema: { parse: mockSkillsConfigSchemaParse },
  formatSessionKey: vi.fn(() => "test|heartbeat|hb-agent-1"),
  systemNowMs: () => Date.now(),
  systemSetTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
}));

// ---------------------------------------------------------------------------
// Helpers
function createMockSystemEventQueue() {
  return {
    enqueue: vi.fn(),
    peek: vi.fn(() => []),
    drain: vi.fn(() => []),
    clear: vi.fn(),
    clearAll: vi.fn(),
    size: vi.fn(() => 0),
  };
}

function createContainer(opts: {
  agents?: Record<string, any>;
  cronEnabled?: boolean;
} = {}) {
  const agents = opts.agents ?? {
    "agent-1": {
      name: "Agent 1",
      skills: {
        builtinTools: { browser: false, exec: false, process: false },
      },
      session: { resetPolicy: { mode: "none" } },
    },
  };

  return {
    config: {
      tenantId: "test",
      agents,
      scheduler: {
        cron: {
          enabled: opts.cronEnabled ?? false,
          maxConcurrentRuns: 3,
          defaultTimezone: "UTC",
          maxJobs: 50,
        },
        heartbeat: { intervalMs: 60000 },
        quietHours: { enabled: false },
        tasks: { enabled: false },
      },
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

function createMinimalDeps(overrides: Record<string, any> = {}) {
  return {
    container: createContainer(overrides),
    workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
    sessionStore: { loadByFormattedKey: vi.fn(), save: vi.fn(), delete: vi.fn() } as any,
    sessionManager: { getOrCreate: vi.fn(), reset: vi.fn() } as any,
    schedulerLogger: createMockLogger() as any,
    agentLogger: createMockLogger() as any,
    skillsLogger: createMockLogger() as any,
    // Stub clock + timers required by SetupSchedulersDeps.
    clock: { now: () => Date.now(), nowDate: () => new Date() } as any,
    timers: { setTimeout: vi.fn(), setInterval: vi.fn() } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupSchedulers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillsConfigSchemaParse.mockReturnValue({
      builtinTools: { browser: false, exec: false, process: false },
      toolPolicy: { profile: "default" },
    });
  });

  async function getSetupSchedulers() {
    const mod = await import("./setup-schedulers.js");
    return mod.setupSchedulers;
  }

  // -------------------------------------------------------------------------
  // 1. No cron schedulers when cron.enabled is false
  // -------------------------------------------------------------------------

  it("creates no cron schedulers when cron.enabled is false", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ cronEnabled: false }));

    expect(result.cronSchedulers.size).toBe(0);
    expect(mockCreateCronScheduler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Creates per-agent cron scheduler when enabled
  // -------------------------------------------------------------------------

  it("creates per-agent cron scheduler when cron.enabled is true and calls start()", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ cronEnabled: true }));

    expect(result.cronSchedulers.size).toBe(1);
    expect(mockCreateCronScheduler).toHaveBeenCalledOnce();
    const scheduler = result.cronSchedulers.get("agent-1");
    expect(scheduler).toBeDefined();
    expect(scheduler!.start).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Creates CronStore in agent workspace directory
  // -------------------------------------------------------------------------

  it("creates CronStore in agent workspace directory", async () => {
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ cronEnabled: true }));

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockCreateCronStore).toHaveBeenCalled();
    // safePath should be called for the cron-jobs.json path
    expect(mockSafePath).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. executeJob callback emits scheduler:job_result on success
  // -------------------------------------------------------------------------

  it("executeJob callback emits scheduler:job_result event on success", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    // Extract the executeJob callback from createCronScheduler call
    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-1",
      name: "test-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Hello from cron" },
      schedule: { kind: "every", everyMs: 60_000 },
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    const result = await executeJob(job);

    expect(result.status).toBe("ok");
    expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:job_result",
      expect.objectContaining({
        jobId: "job-1",
        jobName: "test-job",
        result: "Hello from cron",
        success: true,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 5. executeJob warns when no deliveryTarget
  // -------------------------------------------------------------------------

  it("executeJob callback logs warn when no deliveryTarget", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-2",
      name: "orphan-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "No target" },
      deliveryTarget: undefined,
    };

    const result = await executeJob(job);

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("No delivery target (event emitted)");
  });

  // -------------------------------------------------------------------------
  // 5b. deliveryTarget-less system_event jobs still emit scheduler:job_result
  // (live finding 2026-06-11): the memory crons (review/consolidation/
  // reasoning/user-representation/usefulness-judge/online-tuning) are
  // registered as deliveryTarget-less __SENTINEL__ system_event jobs whose
  // WORK rides the scheduler:job_result listener. The old short-circuit
  // returned BEFORE the emit, so every memory cron completed "ok" nightly
  // while doing NOTHING — zero entities/causal edges/observations on a live
  // daemon with days of conversations.
  // -------------------------------------------------------------------------

  it("a deliveryTarget-less system_event job (memory cron sentinel) still emits scheduler:job_result so its work runs", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "memory-review-agent-1",
      name: "Memory review",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "__MEMORY_REVIEW__" },
      schedule: { kind: "cron", expr: "0 2 * * *" },
      deliveryTarget: undefined,
      sessionTarget: "isolated",
    };

    const result = await executeJob(job);

    expect(result.status).toBe("ok");
    expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:job_result",
      expect.objectContaining({
        jobId: "memory-review-agent-1",
        agentId: "agent-1",
        result: "__MEMORY_REVIEW__",
        success: true,
      }),
    );
  });

  it("a deliveryTarget-less agent_turn job keeps the old short-circuit (no emit, no execution)", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-3",
      name: "orphan-agent-turn",
      agentId: "agent-1",
      payload: { kind: "agent_turn", message: "do things" },
      deliveryTarget: undefined,
    };

    const result = await executeJob(job);

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("No delivery target");
    expect(deps.container.eventBus.emit).not.toHaveBeenCalledWith(
      "scheduler:job_result",
      expect.anything(),
    );
  });

  // -------------------------------------------------------------------------
  // 6. executeJob handles errors and records error status
  // -------------------------------------------------------------------------

  it("executeJob callback handles errors and records error status", async () => {
    const mockTracker = {
      record: vi.fn(async () => {}),
      getRecent: vi.fn(() => []),
    };
    mockCreateExecutionTracker.mockReturnValue(mockTracker);

    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });

    // Make eventBus.emit throw to simulate error
    deps.container.eventBus.emit = vi.fn(() => { throw new Error("Bus error"); });

    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-3",
      name: "failing-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Will fail" },
      schedule: { kind: "every", everyMs: 60_000 },
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    const result = await executeJob(job);

    expect(result.status).toBe("error");
    expect(result.error).toBe("Bus error");
    expect(mockTracker.record).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-3",
        status: "error",
        error: "Bus error",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 7. getAgentCronScheduler returns scheduler for known agent
  // -------------------------------------------------------------------------

  it("getAgentCronScheduler returns scheduler for known agent", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ cronEnabled: true }));

    const scheduler = result.getAgentCronScheduler("agent-1");
    expect(scheduler).toBeDefined();
    expect(scheduler.start).toBeDefined();
  });

  it("getAgentCronScheduler throws for unknown agent", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ cronEnabled: true }));

    expect(() => result.getAgentCronScheduler("unknown")).toThrow(
      /CronScheduler not enabled for agent "unknown"/,
    );
  });

  // -------------------------------------------------------------------------
  // 8. Creates BrowserService with unique CDP ports per agent
  // -------------------------------------------------------------------------

  it("creates BrowserService with unique CDP ports per agent (9222, 9223, ...)", async () => {
    mockSkillsConfigSchemaParse.mockReturnValue({
      builtinTools: { browser: true, exec: false, process: false },
      toolPolicy: { profile: "default" },
    });

    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: true } },
        session: { resetPolicy: { mode: "none" } },
      },
      "agent-2": {
        name: "Agent 2",
        skills: { builtinTools: { browser: true } },
        session: { resetPolicy: { mode: "none" } },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({
      agents,
      workspaceDirs: new Map([
        ["agent-1", "/workspace/agent-1"],
        ["agent-2", "/workspace/agent-2"],
      ]),
    }));

    expect(result.browserServices.size).toBe(2);
    expect(mockCreateBrowserService).toHaveBeenCalledTimes(2);

    const calls = mockCreateBrowserService.mock.calls;
    expect(calls[0][0]).toEqual({ cdpPort: 9222 });
    expect(calls[1][0]).toEqual({ cdpPort: 9223 });
  });

  // -------------------------------------------------------------------------
  // 9. Skips BrowserService when browser is false
  // -------------------------------------------------------------------------

  it("skips BrowserService when builtinTools.browser is false", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps());

    expect(result.browserServices.size).toBe(0);
    expect(mockCreateBrowserService).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 10. getAgentBrowserService returns/throws correctly
  // -------------------------------------------------------------------------

  it("getAgentBrowserService returns service for known agent", async () => {
    mockSkillsConfigSchemaParse.mockReturnValue({
      builtinTools: { browser: true, exec: false, process: false },
      toolPolicy: { profile: "default" },
    });

    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: true } },
        session: { resetPolicy: { mode: "none" } },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ agents }));

    const service = result.getAgentBrowserService("agent-1");
    expect(service).toBeDefined();
  });

  it("getAgentBrowserService throws for unknown agent", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps());

    expect(() => result.getAgentBrowserService("unknown")).toThrow(
      /Browser not enabled for agent "unknown"/,
    );
  });

  // -------------------------------------------------------------------------
  // 11. Creates SessionResetScheduler when resetPolicy.mode is not "none"
  // -------------------------------------------------------------------------

  it("creates SessionResetScheduler per agent when resetPolicy.mode is not 'none'", async () => {
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "time-based", maxAgeMs: 3600000, resetTriggers: [] } },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ agents }));

    expect(result.resetSchedulers.size).toBe(1);
    expect(mockCreateSessionResetScheduler).toHaveBeenCalledOnce();
    const resetScheduler = result.resetSchedulers.get("agent-1");
    expect(resetScheduler).toBeDefined();
    expect(resetScheduler!.start).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 12. Skips session reset when mode is "none" or undefined
  // -------------------------------------------------------------------------

  it("skips session reset when resetPolicy.mode is 'none'", async () => {
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ agents }));

    expect(result.resetSchedulers.size).toBe(0);
    expect(mockCreateSessionResetScheduler).not.toHaveBeenCalled();
  });

  it("skips session reset when resetPolicy is undefined", async () => {
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: {},
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({ agents }));

    expect(result.resetSchedulers.size).toBe(0);
    expect(mockCreateSessionResetScheduler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 13. Multiple agents with different configurations
  // -------------------------------------------------------------------------

  it("handles multiple agents with different scheduler configurations", async () => {
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "time-based", resetTriggers: [] } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
      },
      "agent-2": {
        name: "Agent 2",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        // No per-agent cron override, uses global (disabled)
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    const result = await setupSchedulers(createMinimalDeps({
      agents,
      workspaceDirs: new Map([
        ["agent-1", "/workspace/agent-1"],
        ["agent-2", "/workspace/agent-2"],
      ]),
    }));

    // agent-1 has cron enabled via per-agent override
    expect(result.cronSchedulers.size).toBe(1);
    expect(result.cronSchedulers.has("agent-1")).toBe(true);

    // agent-1 has reset, agent-2 does not
    expect(result.resetSchedulers.size).toBe(1);
    expect(result.resetSchedulers.has("agent-1")).toBe(true);
    expect(result.resetSchedulers.has("agent-2")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 13.4. Memory consolidation cron — the opt-in gate
  // OFF by default: a default-config agent registers NO consolidation job; an
  // operator-enabled agent registers __MEMORY_CONSOLIDATION__ (default 30 3 * * *).
  // -------------------------------------------------------------------------

  /** A cron-scheduler stub that supports the registration path (getJobs/addJob). */
  function withRegistrableScheduler() {
    const addJob = vi.fn(async () => {});
    const getJobs = vi.fn(() => []);
    mockCreateCronScheduler.mockReturnValue({
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      getJobs,
      addJob,
    } as any);
    return { addJob, getJobs };
  }

  it("registers NO consolidation cron for a default (consolidation-off) agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // memoryConsolidation undefined => default OFF (the cost gate).
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    // No __MEMORY_CONSOLIDATION__ job is ever added.
    const consolidationAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__MEMORY_CONSOLIDATION__",
    );
    expect(consolidationAdds.length).toBe(0);
  });

  it("registers the __MEMORY_CONSOLIDATION__ cron (default 30 3 * * *) for an enabled agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryConsolidation: { enabled: true },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const consolidationAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_CONSOLIDATION__");
    expect(consolidationAdd).toBeDefined();
    expect(consolidationAdd.id).toBe("memory-consolidation-agent-1");
    expect(consolidationAdd.name).toBe("Memory consolidation");
    // Default schedule runs AFTER memory-review's 0 2 so review-minted memories
    // are consolidation candidates the same night.
    expect(consolidationAdd.schedule).toEqual({ kind: "cron", expr: "30 3 * * *" });
    expect(consolidationAdd.sessionTarget).toBe("isolated");
    expect(consolidationAdd.sessionStrategy).toBe("fresh");
  });

  it("honors a custom consolidation schedule when the operator overrides it", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryConsolidation: { enabled: true, schedule: "15 4 * * 0" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const consolidationAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_CONSOLIDATION__");
    expect(consolidationAdd?.schedule).toEqual({ kind: "cron", expr: "15 4 * * 0" });
  });

  // -------------------------------------------------------------------------
  // 13.4b. Memory reasoning cron — the opt-in gate
  // OFF by default: a default-config agent registers NO reasoning job; an
  // operator-enabled agent registers __MEMORY_REASONING__ (default 0 4 * * *,
  // AFTER consolidation's 30 3 so reasoning runs over freshly-consolidated
  // observations). Mirrors the consolidation gate 1:1.
  // -------------------------------------------------------------------------

  it("registers NO reasoning cron for a default (reasoning-off) agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // memoryReasoning undefined => default OFF (the cost gate — byte-identical).
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    // No __MEMORY_REASONING__ job is ever added.
    const reasoningAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__MEMORY_REASONING__",
    );
    expect(reasoningAdds.length).toBe(0);
  });

  it("registers the __MEMORY_REASONING__ cron (default 0 4 * * *) for an enabled agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryReasoning: { enabled: true },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const reasoningAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_REASONING__");
    expect(reasoningAdd).toBeDefined();
    expect(reasoningAdd.id).toBe("memory-reasoning-agent-1");
    expect(reasoningAdd.name).toBe("Memory reasoning");
    // Default schedule runs AFTER consolidation's 30 3 so reasoning works over
    // freshly-consolidated observations the same night.
    expect(reasoningAdd.schedule).toEqual({ kind: "cron", expr: "0 4 * * *" });
    expect(reasoningAdd.sessionTarget).toBe("isolated");
    expect(reasoningAdd.sessionStrategy).toBe("fresh");
    expect(reasoningAdd.payload).toEqual({ kind: "system_event", text: "__MEMORY_REASONING__" });
  });

  it("honors a custom reasoning schedule when the operator overrides it", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryReasoning: { enabled: true, schedule: "45 5 * * 0" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const reasoningAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_REASONING__");
    expect(reasoningAdd?.schedule).toEqual({ kind: "cron", expr: "45 5 * * 0" });
  });

  // -------------------------------------------------------------------------
  // __SOCIAL_MODELING__ cron registration. The gate
  // is STRICTER than the other memory crons: register ONLY when enabled AND a
  // recorded privacy-review sign-off (privacyReviewSignedOffBy) is present.
  // A knob-on-but-no-sign-off agent registers NO job (byte-identical).
  // -------------------------------------------------------------------------

  it("registers NO __SOCIAL_MODELING__ cron for a default (social-off) agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // socialModeling undefined => default OFF (the cost gate — byte-identical).
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const socialAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__SOCIAL_MODELING__",
    );
    expect(socialAdds.length).toBe(0);
  });

  it("registers NO __SOCIAL_MODELING__ cron when enabled but NO privacy-review sign-off (the privacy-review gate)", async () => {
    // The knob alone does NOT register a job — a recorded sign-off is required.
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        socialModeling: { enabled: true },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const socialAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__SOCIAL_MODELING__",
    );
    expect(socialAdds.length).toBe(0);
  });

  it("registers the __SOCIAL_MODELING__ cron (default 0 6 * * *) only when enabled AND signed-off", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const socialAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__SOCIAL_MODELING__");
    expect(socialAdd).toBeDefined();
    expect(socialAdd.id).toBe("memory-social-modeling-agent-1");
    expect(socialAdd.name).toBe("Memory social modeling");
    // Default schedule runs AFTER the representation cron's 0 5 so relationships are
    // built over freshly-reasoned/profiled memories the same night.
    expect(socialAdd.schedule).toEqual({ kind: "cron", expr: "0 6 * * *" });
    expect(socialAdd.sessionTarget).toBe("isolated");
    expect(socialAdd.sessionStrategy).toBe("fresh");
    expect(socialAdd.payload).toEqual({ kind: "system_event", text: "__SOCIAL_MODELING__" });
  });

  // -------------------------------------------------------------------------
  // __USEFULNESS_JUDGE__ cron registration. OFF
  // by default (a cost gate — an OFFLINE cheap-model judge). Registered ONLY
  // when the operator sets memoryUsefulnessJudge.enabled; a default agent
  // registers NO job → byte-identical with the config absent. Default 0 7 * * *
  // runs AFTER social's 0 6. Mirrors the reasoning gate 1:1.
  // -------------------------------------------------------------------------

  it("registers NO __USEFULNESS_JUDGE__ cron for a default (judge-off) agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // memoryUsefulnessJudge undefined => default OFF (the cost gate — byte-identical).
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const judgeAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__USEFULNESS_JUDGE__",
    );
    expect(judgeAdds.length).toBe(0);
  });

  it("registers the __USEFULNESS_JUDGE__ cron (default 0 7 * * *) for an enabled agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryUsefulnessJudge: { enabled: true },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const judgeAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__USEFULNESS_JUDGE__");
    expect(judgeAdd).toBeDefined();
    expect(judgeAdd.id).toBe("memory-usefulness-judge-agent-1");
    expect(judgeAdd.name).toBe("Memory usefulness judge");
    // Default schedule runs AFTER social's 0 6 so the judge scores over a
    // fully-settled night.
    expect(judgeAdd.schedule).toEqual({ kind: "cron", expr: "0 7 * * *" });
    expect(judgeAdd.sessionTarget).toBe("isolated");
    expect(judgeAdd.sessionStrategy).toBe("fresh");
    expect(judgeAdd.payload).toEqual({ kind: "system_event", text: "__USEFULNESS_JUDGE__" });
  });

  it("honors a custom usefulness-judge schedule when the operator overrides it", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryUsefulnessJudge: { enabled: true, schedule: "30 8 * * 0" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const judgeAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__USEFULNESS_JUDGE__");
    expect(judgeAdd?.schedule).toEqual({ kind: "cron", expr: "30 8 * * 0" });
  });

  // -------------------------------------------------------------------------
  // __ONLINE_TUNING__ cron registration. OFF by
  // default. Registered ONLY when the operator sets memoryOnlineTuning.enabled; a
  // default agent registers NO job → byte-identical with the config absent. Default
  // 0 8 * * * runs AFTER the judge's 0 7 so the FEED signal is fully settled. The
  // sentinel dispatch is KEYLESS (no model/key) — the registration mirrors the judge.
  // -------------------------------------------------------------------------

  it("registers NO __ONLINE_TUNING__ cron for a default (tuning-off) agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // memoryOnlineTuning undefined => default OFF (the opt-in gate — byte-identical).
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const tuningAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__ONLINE_TUNING__",
    );
    expect(tuningAdds.length).toBe(0);
  });

  it("registers the __ONLINE_TUNING__ cron (default 0 8 * * *) for an enabled agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryOnlineTuning: { enabled: true },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const tuningAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__ONLINE_TUNING__");
    expect(tuningAdd).toBeDefined();
    expect(tuningAdd.id).toBe("memory-online-tuning-agent-1");
    expect(tuningAdd.name).toBe("Memory online tuning");
    // Default schedule runs AFTER the judge's 0 7 so the FEED signal is fully settled.
    expect(tuningAdd.schedule).toEqual({ kind: "cron", expr: "0 8 * * *" });
    expect(tuningAdd.sessionTarget).toBe("isolated");
    expect(tuningAdd.sessionStrategy).toBe("fresh");
    expect(tuningAdd.payload).toEqual({ kind: "system_event", text: "__ONLINE_TUNING__" });
  });

  it("honors a custom online-tuning schedule when the operator overrides it", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryOnlineTuning: { enabled: true, schedule: "30 9 * * 0" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const tuningAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__ONLINE_TUNING__");
    expect(tuningAdd?.schedule).toEqual({ kind: "cron", expr: "30 9 * * 0" });
  });

  // -------------------------------------------------------------------------
  // __MEMORY_LIFECYCLE__ cron registration. OFF
  // by default. Registered ONLY when the operator sets memoryLifecycle.enabled; a
  // default agent registers NO job → byte-identical with the config absent. Default
  // 0 9 * * * runs AFTER online-tuning's 0 8. Like the bandit (NOT the LLM crons)
  // the sentinel dispatch is KEYLESS (no model/key) — the registration mirrors the
  // online-tuning block. Even when enabled the sweep is DORMANT (evicts/demotes 0).
  // -------------------------------------------------------------------------

  it("registers NO __MEMORY_LIFECYCLE__ cron for a default (lifecycle-off) agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // memoryLifecycle undefined => default OFF (the opt-in gate — byte-identical).
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const lifecycleAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__MEMORY_LIFECYCLE__",
    );
    expect(lifecycleAdds.length).toBe(0);
  });

  it("registers the __MEMORY_LIFECYCLE__ cron (default 0 9 * * *) for an enabled agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryLifecycle: { enabled: true },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const lifecycleAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_LIFECYCLE__");
    expect(lifecycleAdd).toBeDefined();
    expect(lifecycleAdd.id).toBe("memory-lifecycle-agent-1");
    expect(lifecycleAdd.name).toBe("Memory lifecycle");
    // Default schedule runs AFTER online-tuning's 0 8.
    expect(lifecycleAdd.schedule).toEqual({ kind: "cron", expr: "0 9 * * *" });
    expect(lifecycleAdd.sessionTarget).toBe("isolated");
    expect(lifecycleAdd.sessionStrategy).toBe("fresh");
    expect(lifecycleAdd.payload).toEqual({ kind: "system_event", text: "__MEMORY_LIFECYCLE__" });
  });

  it("honors a custom memory-lifecycle schedule when the operator overrides it", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryLifecycle: { enabled: true, schedule: "15 4 * * 1" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const lifecycleAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_LIFECYCLE__");
    expect(lifecycleAdd?.schedule).toEqual({ kind: "cron", expr: "15 4 * * 1" });
  });

  // -------------------------------------------------------------------------
  // 13.4z. memory.costFeatures master kill switch (opt-out posture)
  //
  // A single top-level gate. When `memory.costFeatures.enabled === false`, EVERY
  // LLM cost-bearing memory CRON is force-disabled at the registration site —
  // even for an agent whose per-agent feature is explicitly enabled. The gated
  // set is: memoryReview, memoryConsolidation, memoryReasoning,
  // memoryUserRepresentation, memoryUsefulnessJudge, memoryOnlineTuning. The
  // $0 keyless memoryLifecycle sweep and the privacy-gated socialModeling cron
  // are NOT gated by this switch (lifecycle is keyless; social has its OWN
  // privacy sign-off gate). When the switch is on (the default) registration is
  // unchanged → byte-identical.
  // -------------------------------------------------------------------------

  /** A fully-enabled agent: every cost cron + lifecycle on; social on AND signed off. */
  function allFeaturesOnAgent() {
    return {
      name: "Agent 1",
      skills: { builtinTools: { browser: false } },
      session: { resetPolicy: { mode: "none" } },
      scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
      memoryReview: { enabled: true },
      memoryConsolidation: { enabled: true },
      memoryReasoning: { enabled: true },
      memoryUserRepresentation: { enabled: true },
      memoryUsefulnessJudge: { enabled: true },
      memoryOnlineTuning: { enabled: true },
      memoryLifecycle: { enabled: true },
      socialModeling: { enabled: true, privacyReviewSignedOffBy: "operator@example.com" },
    };
  }

  /** A deps object whose container carries an explicit memory.costFeatures.enabled. */
  function depsWithCostSwitch(agents: Record<string, any>, costFeaturesEnabled: boolean) {
    const deps = createMinimalDeps({ agents });
    (deps.container as any).config.memory = { costFeatures: { enabled: costFeaturesEnabled } };
    return deps;
  }

  const COST_CRON_SENTINELS = [
    "__MEMORY_REVIEW__",
    "__MEMORY_CONSOLIDATION__",
    "__MEMORY_REASONING__",
    "__USER_REPRESENTATION__",
    "__USEFULNESS_JUDGE__",
    "__ONLINE_TUNING__",
  ] as const;

  it("force-disables EVERY cost-bearing memory cron when memory.costFeatures.enabled is false (even per-agent-enabled)", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(depsWithCostSwitch({ "agent-1": allFeaturesOnAgent() }, false));

    const addedSentinels = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    for (const sentinel of COST_CRON_SENTINELS) {
      expect(addedSentinels, `${sentinel} must NOT be registered when the kill switch is off`).not.toContain(sentinel);
    }
  });

  /**
   * KILL SWITCH BEATS DEFAULT-ON. The cost-bearing memory
   * subtrees now default `{ enabled: true }` at the schema level (the opt-out
   * posture). A real daemon parses the config, so every cost subtree arrives
   * present + enabled WITHOUT the operator opting in. This agent mirrors that
   * PARSED-default shape (the cron subtrees populated + enabled, exactly as
   * PerAgentConfigSchema.parse({}) now yields — @comis/core is mocked here so the
   * default object is constructed inline). With the kill switch OFF, NOT ONE cost
   * cron may register — proving the kill switch wins over the new default-ON.
   */
  function defaultOnParsedAgent() {
    return {
      name: "Agent 1",
      skills: { builtinTools: { browser: false } },
      session: { resetPolicy: { mode: "none" } },
      scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
      // The post-flip PARSED defaults: each cost subtree present + enabled with no opt-in.
      memoryReview: { enabled: true, schedule: "0 2 * * *" },
      memoryConsolidation: { enabled: true, schedule: "30 3 * * *" },
      memoryReasoning: { enabled: true, schedule: "0 4 * * *" },
      memoryUserRepresentation: { enabled: true, schedule: "0 5 * * *" },
      memoryUsefulnessJudge: { enabled: true, schedule: "0 7 * * *" },
      memoryOnlineTuning: { enabled: true, schedule: "0 8 * * *" },
    };
  }

  it("KILL SWITCH BEATS DEFAULT-ON: with the now-default-ON cost subtrees, costFeatures:false registers NO cost cron", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    // Default-ON subtrees (no explicit operator opt-in) + kill switch OFF.
    await setupSchedulers(depsWithCostSwitch({ "agent-1": defaultOnParsedAgent() }, false));

    const addedSentinels = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    for (const sentinel of COST_CRON_SENTINELS) {
      expect(
        addedSentinels,
        `${sentinel} must NOT register when the kill switch is off, even though the per-agent default is ON`,
      ).not.toContain(sentinel);
    }
  });

  it("KILL SWITCH ON (default): the now-default-ON cost subtrees DO register every cost cron (opt-out posture live)", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    // Same default-ON subtrees + kill switch ON → every cost cron registers without any opt-in.
    await setupSchedulers(depsWithCostSwitch({ "agent-1": defaultOnParsedAgent() }, true));

    const addedSentinels = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    for (const sentinel of COST_CRON_SENTINELS) {
      expect(
        addedSentinels,
        `${sentinel} must register by default (opt-out) when the kill switch is on`,
      ).toContain(sentinel);
    }
  });

  it("leaves the $0 lifecycle sweep and the privacy-gated social cron UNAFFECTED by the cost kill switch", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(depsWithCostSwitch({ "agent-1": allFeaturesOnAgent() }, false));

    const addedSentinels = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    // The keyless lifecycle sweep is NOT a cost feature → still registered.
    expect(addedSentinels).toContain("__MEMORY_LIFECYCLE__");
    // socialModeling has its OWN privacy gate (independent of the cost switch) → still registered.
    expect(addedSentinels).toContain("__SOCIAL_MODELING__");
  });

  it("registers ALL cost-bearing memory crons when the kill switch is on (the default — byte-identical)", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(depsWithCostSwitch({ "agent-1": allFeaturesOnAgent() }, true));

    const addedSentinels = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    for (const sentinel of COST_CRON_SENTINELS) {
      expect(addedSentinels, `${sentinel} must be registered when the kill switch is on`).toContain(sentinel);
    }
  });

  // The first-run cost-disclosure notice is invoked from inside setupSchedulers (the cron-wiring
  // seam) — a forward-presence belt that it actually fires. The REAL notice helper runs (it is
  // not mocked), so a WARN naming the off-switch lands on schedulerLogger.warn.

  it("emits the first-run cost-disclosure WARN when the kill switch is on and a cost feature is active", async () => {
    withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    const deps = depsWithCostSwitch({ "agent-1": { ...allFeaturesOnAgent() } }, true);
    await setupSchedulers(deps);

    const disclosureWarn = (deps.schedulerLogger.warn as any).mock.calls.find(
      (c: any[]) => JSON.stringify(c).includes("memory.costFeatures.enabled: false"),
    );
    expect(disclosureWarn, "a cost-disclosure WARN naming the off-switch was emitted").toBeDefined();
  });

  it("emits NO cost-disclosure WARN for a default (no cost feature active) agent", async () => {
    withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    const deps = depsWithCostSwitch(
      { "agent-1": { name: "Agent 1", skills: { builtinTools: { browser: false } }, session: { resetPolicy: { mode: "none" } }, scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } } } },
      true,
    );
    await setupSchedulers(deps);

    const disclosureWarn = (deps.schedulerLogger.warn as any).mock.calls.find(
      (c: any[]) => JSON.stringify(c).includes("memory.costFeatures.enabled: false"),
    );
    expect(disclosureWarn, "no cost-disclosure WARN when nothing is active").toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 13.5. sessionStrategy and maxHistoryTurns propagated in event emission
  // -------------------------------------------------------------------------

  it("propagates sessionStrategy and maxHistoryTurns in scheduler:job_result event", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-strategy",
      name: "strategy-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Hello" },
      schedule: { kind: "every", everyMs: 60_000 },
      sessionStrategy: "rolling",
      maxHistoryTurns: 5,
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    await executeJob(job);

    expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:job_result",
      expect.objectContaining({
        sessionStrategy: "rolling",
        maxHistoryTurns: 5,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 13.6. cadenceMs derived from schedule.everyMs (kind === "every")
  // -------------------------------------------------------------------------

  it("propagates cadenceMs from schedule.everyMs when kind === 'every'", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-every",
      name: "every-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Hello" },
      schedule: { kind: "every", everyMs: 900_000 },
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    await executeJob(job);

    expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:job_result",
      expect.objectContaining({
        cadenceMs: 900_000,
      }),
    );
  });

  it("emits cadenceMs as undefined for cron-expression schedule (kind === 'cron')", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-cron-expr",
      name: "cron-expr-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Hello" },
      schedule: { kind: "cron", expr: "0 * * * *" },
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    await executeJob(job);

    const emitCall = vi.mocked(deps.container.eventBus.emit).mock.calls.find(
      (c) => c[0] === "scheduler:job_result",
    );
    expect(emitCall).toBeDefined();
    const payload = emitCall![1] as { cadenceMs?: number };
    expect(payload.cadenceMs).toBeUndefined();
  });

  it("emits cadenceMs as undefined for one-shot 'at' schedule", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const deps = createMinimalDeps({ cronEnabled: true });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-at",
      name: "at-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Hello" },
      schedule: { kind: "at", at: "2026-12-25T00:00:00Z" },
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    await executeJob(job);

    const emitCall = vi.mocked(deps.container.eventBus.emit).mock.calls.find(
      (c) => c[0] === "scheduler:job_result",
    );
    expect(emitCall).toBeDefined();
    const payload = emitCall![1] as { cadenceMs?: number };
    expect(payload.cadenceMs).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 14. executeJob enqueues to systemEventQueue for main+systemEvent
  // -------------------------------------------------------------------------

  it("executeJob enqueues to systemEventQueue for main+systemEvent jobs instead of emitting event", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const mockQueue = createMockSystemEventQueue();
    const deps = createMinimalDeps({
      cronEnabled: true,
      systemEventQueue: mockQueue,
    });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-main",
      name: "main-cron",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Reminder: check status" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    const result = await executeJob(job);

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("Enqueued to heartbeat pipeline");
    expect(mockQueue.enqueue).toHaveBeenCalledWith(
      "Reminder: check status",
      expect.objectContaining({ contextKey: "cron:job-main" }),
    );
    // Must NOT emit scheduler:job_result (prevents double delivery)
    expect(deps.container.eventBus.emit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 15. executeJob calls onCronWake for wakeMode "now"
  // -------------------------------------------------------------------------

  it("executeJob calls onCronWake when wakeMode is 'now'", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const mockQueue = createMockSystemEventQueue();
    const mockWake = vi.fn();
    const deps = createMinimalDeps({
      cronEnabled: true,
      systemEventQueue: mockQueue,
      onCronWake: mockWake,
    });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-wake",
      name: "wake-cron",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Wake up" },
      sessionTarget: "main",
      wakeMode: "now",
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    await executeJob(job);
    expect(mockWake).toHaveBeenCalledWith("cron");
  });

  // -------------------------------------------------------------------------
  // 16. executeJob forwards isolated result when forwardToMain
  // -------------------------------------------------------------------------

  it("executeJob forwards isolated result to main session when forwardToMain is true", async () => {
    const setupSchedulers = await getSetupSchedulers();
    const mockQueue = createMockSystemEventQueue();
    const deps = createMinimalDeps({
      cronEnabled: true,
      systemEventQueue: mockQueue,
    });
    await setupSchedulers(deps);

    const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
    const executeJob = cronArgs.executeJob;

    const job = {
      id: "job-fwd",
      name: "forward-job",
      agentId: "agent-1",
      payload: { kind: "system_event", text: "Isolated result" },
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      forwardToMain: true,
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    };

    await executeJob(job);

    // Should emit event bus for isolated path
    expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:job_result",
      expect.objectContaining({ jobId: "job-fwd" }),
    );
    // AND forward to main session queue
    expect(mockQueue.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("forward-job"),
      expect.objectContaining({ contextKey: "cron:job-fwd:summary" }),
    );
  });

  // -------------------------------------------------------------------------
  // WIRE-01: schedule runMemoryTripleExtraction behind a per-agent flag, DEFAULT
  // OFF. The keystone — a default agent registers ZERO triple-extraction jobs
  // (byte-identical with the config absent / zero added cost). Opt-in registers
  // __MEMORY_TRIPLE_EXTRACTION__; the master cost kill switch force-disables it.
  // -------------------------------------------------------------------------

  it("WIRE-01: a DEFAULT agent registers NO memory-triple-extraction job (default-OFF / byte-identical)", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // memoryTripleExtraction undefined => default OFF: NO job, zero cost.
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const tripleAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__MEMORY_TRIPLE_EXTRACTION__");
    expect(tripleAdds.length, "a default agent must add ZERO triple-extraction jobs").toBe(0);
  });

  it("WIRE-01: registers the __MEMORY_TRIPLE_EXTRACTION__ cron (default 0 6 * * *) for an opted-in agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryTripleExtraction: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const tripleAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__MEMORY_TRIPLE_EXTRACTION__");
    expect(tripleAdd, "an opted-in agent registers the triple-extraction job").toBeDefined();
    expect(tripleAdd.id).toBe("memory-triple-extraction-agent-1");
    expect(tripleAdd.schedule).toEqual({ kind: "cron", expr: "0 6 * * *" });
  });

  it("WIRE-01: the master cost kill switch (costFeatures:false) force-disables the triple-extraction cron even when opted in", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryTripleExtraction: { enabled: true },
      },
    };
    await setupSchedulers(depsWithCostSwitch(agents, false));

    const tripleAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__MEMORY_TRIPLE_EXTRACTION__");
    expect(tripleAdds.length, "the kill switch force-disables the triple-extraction cron").toBe(0);
  });

  // -------------------------------------------------------------------------
  // SKILL-08/09 (Plan 07): the __SKILL_SYNTHESIS__ cron. DEFAULT OFF (the
  // byte-identity guarantee). Registered ONLY when learningSkills.enabled AND the
  // master cost kill switch is on; the __SKILL_SYNTHESIS__ sentinel dispatches the
  // procedural-synthesis job (setup-channels-memory-crons-wire.ts).
  // -------------------------------------------------------------------------

  it("SKILL-09: a DEFAULT agent registers NO skill-synthesis job (default-OFF / byte-identical)", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // learningSkills undefined => default OFF: NO job, zero cost.
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const skillAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__SKILL_SYNTHESIS__");
    expect(skillAdds.length, "a default agent must add ZERO skill-synthesis jobs").toBe(0);
  });

  it("SKILL-09: registers the __SKILL_SYNTHESIS__ cron (30 9 * * *) for an opted-in agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        learningSkills: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const skillAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__SKILL_SYNTHESIS__");
    expect(skillAdd, "an opted-in agent registers the skill-synthesis job").toBeDefined();
    expect(skillAdd.id).toBe("skill-synthesis-agent-1");
    expect(skillAdd.name).toBe("Skill synthesis");
    expect(skillAdd.schedule).toEqual({ kind: "cron", expr: "30 9 * * *" });
    expect(skillAdd.sessionTarget).toBe("isolated");
    expect(skillAdd.sessionStrategy).toBe("fresh");
  });

  it("SKILL-09: the master cost kill switch (costFeatures:false) force-disables the skill-synthesis cron even when opted in", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        learningSkills: { enabled: true },
      },
    };
    await setupSchedulers(depsWithCostSwitch(agents, false));

    const skillAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__SKILL_SYNTHESIS__");
    expect(skillAdds.length, "the kill switch force-disables the skill-synthesis cron").toBe(0);
  });
});
