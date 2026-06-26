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

const mockResolveAutonomy = vi.hoisted(() => vi.fn((_autonomy?: unknown) => ({ enabled: false, capabilities: [] as string[] })));

vi.mock("@comis/core", () => ({
  safePath: mockSafePath,
  SkillsConfigSchema: { parse: mockSkillsConfigSchemaParse },
  formatSessionKey: vi.fn(() => "test|heartbeat|hb-agent-1"),
  systemNowMs: () => Date.now(),
  systemSetTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  // Phase 213-08 (RATE-02): the cron-fire mint resolves the JOB agent's autonomy
  // caps via resolveAutonomy. Default disabled; tests override per-case.
  resolveAutonomy: mockResolveAutonomy,
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
    mockResolveAutonomy.mockReturnValue({ enabled: false, capabilities: [] });
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
  // reasoning/user-representation/usefulness-judge) are
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
  // 13.4. (Phase 225 FOLD §3.2) The standalone __MEMORY_CONSOLIDATION__ /
  // __MEMORY_REASONING__ / __USER_REPRESENTATION__ cron registrations were REMOVED
  // — their work folds into the ONE __REFLECT__ cron (Plan 04). Even with the
  // per-agent cost subtrees ENABLED + the kill switch ON, NONE of the three
  // registers (the I1 model: gone, not run beside __REFLECT__).
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

  it("registers NONE of the 3 folded crons (__MEMORY_CONSOLIDATION__/__MEMORY_REASONING__/__USER_REPRESENTATION__) even when enabled + kill switch on", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // All three explicitly ENABLED — they STILL must not register (folded into __REFLECT__).
        memoryConsolidation: { enabled: true },
        memoryReasoning: { enabled: true },
        memoryUserRepresentation: { enabled: true },
      },
    };
    const deps = createMinimalDeps({ agents });
    (deps.container as any).config.memory = { enabled: true }; // master kill switch ON (Phase 226)

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(deps);

    const added = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    expect(added).not.toContain("__MEMORY_CONSOLIDATION__");
    expect(added).not.toContain("__MEMORY_REASONING__");
    expect(added).not.toContain("__USER_REPRESENTATION__");
  });

  // -------------------------------------------------------------------------
  // Phase 226-04 (SIMPLIFY-03 part 2): the __SOCIAL_MODELING__ cron is DELETED with
  // the ENTIRE social-modeling subsystem (the RelationshipStore port + sqlite adapter,
  // the `relationship` table, the offline directional-edge builder, the relationship-block
  // prompt injection, the per-agent socialModeling config key). Even when an agent attempts
  // a (legacy-shaped) opt-in WITH a sign-off, NO __SOCIAL_MODELING__ job is registered.
  // -------------------------------------------------------------------------

  it("DELETE (226-04): registers NO __SOCIAL_MODELING__ cron even when an agent attempts to opt in with a sign-off", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // A legacy-shaped opt-in (enabled + signed off) — the registration block is gone,
        // so it is inert (the socialModeling key is now rejected at parse anyway).
        socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" },
      },
    };

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const socialAdds = addJob.mock.calls.filter(
      (c) => (c[0] as any)?.payload?.text === "__SOCIAL_MODELING__",
    );
    expect(socialAdds.length, "the __SOCIAL_MODELING__ cron is deleted — it must never register").toBe(0);
  });

  // (The __USEFULNESS_JUDGE__ cron-registration tests were removed in Phase 226 SIMPLIFY-03 —
  // the dormant usefulness-judge cron is DELETED; see the "DELETE (SIMPLIFY-03)" guards below.
  // The __ONLINE_TUNING__ cron-registration tests were removed in Phase 224 — the UCB recall
  // bandit + its cron were deleted; recall scoring is the fixed config.rag.scoring alphas.)

  // -------------------------------------------------------------------------
  // __MEMORY_LIFECYCLE__ cron registration. OFF
  // by default. Registered ONLY when the operator sets memoryLifecycle.enabled; a
  // default agent registers NO job → byte-identical with the config absent. Default
  // 0 9 * * *. The sentinel dispatch is KEYLESS (no model/key). Even when enabled the
  // sweep is DORMANT (evicts/demotes 0).
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
    // Default schedule 0 9 * * *.
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
  // memoryUserRepresentation, memoryUsefulnessJudge. (memoryOnlineTuning — the bandit
  // cron — was deleted in Phase 224.) The
  // $0 keyless memoryLifecycle sweep is NOT gated by this switch (lifecycle is keyless).
  // (The privacy-gated socialModeling cron was DELETED in Phase 226-04 with the rest of
  // that subsystem.) When the switch is on (the default) registration is unchanged →
  // byte-identical.
  // -------------------------------------------------------------------------

  /** A fully-enabled agent: every cost cron + the keyless lifecycle sweep on. */
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
      memoryLifecycle: { enabled: true },
    };
  }

  /** A deps object whose container carries an explicit memory.enabled (the Phase 226 master kill switch). */
  function depsWithCostSwitch(agents: Record<string, any>, costFeaturesEnabled: boolean) {
    const deps = createMinimalDeps({ agents });
    (deps.container as any).config.memory = { enabled: costFeaturesEnabled };
    return deps;
  }

  // -------------------------------------------------------------------------
  // Phase 226 SIMPLIFY-03 (D-03): the two DORMANT LLM crons are DELETED. The
  // __USEFULNESS_JUDGE__ (a recordUsage-feeding seam) and __MEMORY_TRIPLE_EXTRACTION__
  // (a no-op scaffold whose `extract` returns []) registrations are GONE — even when
  // an operator attempts to opt a (legacy-shaped) agent in, NO job is registered. The
  // surviving learning/memory crons are __MEMORY_REVIEW__ (accumulate-tier),
  // __MEMORY_LIFECYCLE__ (keyless forget sweep), __REFLECT__ (the engine).
  // (__SOCIAL_MODELING__ was DELETED in Phase 226-04 with the rest of that subsystem.)
  // The "learning crons = 3" end state = __REFLECT__ + __MEMORY_LIFECYCLE__ + the
  // event-driven OutcomeSignalPort.resolve path (NOT a sentinel — there is no __OUTCOME__
  // cron); __MEMORY_REVIEW__ is accumulate-tier (kept, not counted as a learning cron).
  // -------------------------------------------------------------------------

  it("DELETE (SIMPLIFY-03): registers NO __USEFULNESS_JUDGE__ cron even when an agent attempts to opt in", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // A legacy-shaped opt-in — the registration block is gone, so it is inert.
        memoryUsefulnessJudge: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const judgeAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__USEFULNESS_JUDGE__");
    expect(judgeAdds.length, "the __USEFULNESS_JUDGE__ cron is deleted — it must never register").toBe(0);
  });

  it("DELETE (SIMPLIFY-03): registers NO __MEMORY_TRIPLE_EXTRACTION__ cron even when an agent attempts to opt in", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // A legacy-shaped opt-in — the registration block is gone, so it is inert.
        memoryTripleExtraction: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const tripleAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__MEMORY_TRIPLE_EXTRACTION__");
    expect(tripleAdds.length, "the __MEMORY_TRIPLE_EXTRACTION__ cron is deleted — it must never register").toBe(0);
  });

  it("the surviving learning/memory crons (__MEMORY_REVIEW__ / __MEMORY_LIFECYCLE__ / __REFLECT__) still register for an opted-in agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryReview: { enabled: true },
        memoryLifecycle: { enabled: true },
        learning: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const added = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    expect(added, "memory review survives").toContain("__MEMORY_REVIEW__");
    expect(added, "memory lifecycle (keyless forget sweep) survives").toContain("__MEMORY_LIFECYCLE__");
    expect(added, "reflection (the engine) survives").toContain("__REFLECT__");
    expect(added, "the deleted usefulness judge must NOT appear").not.toContain("__USEFULNESS_JUDGE__");
    expect(added, "the deleted triple-extraction must NOT appear").not.toContain("__MEMORY_TRIPLE_EXTRACTION__");
    expect(added, "the deleted social-modeling cron must NOT appear (226-04)").not.toContain("__SOCIAL_MODELING__");
  });

  it("the learning crons are exactly 3 (__REFLECT__ + __MEMORY_LIFECYCLE__ + the event-driven resolution path) — no __SOCIAL_MODELING__, no __OUTCOME__ sentinel", async () => {
    // The "learning crons = 3" end state after 226-04: __REFLECT__ (the reflection engine)
    // + __MEMORY_LIFECYCLE__ (the keyless forget sweep) + the event-driven
    // OutcomeSignalPort.resolve path (which is NOT a scheduler sentinel — it rides the event
    // bus, so it never appears in addJob). __MEMORY_REVIEW__ is accumulate-tier (kept, not
    // counted). __SOCIAL_MODELING__ is gone (226-04); no __OUTCOME__ cron ever existed.
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        memoryReview: { enabled: true },
        memoryLifecycle: { enabled: true },
        learning: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const added = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    // The two learning crons that DO register as scheduler sentinels:
    expect(added, "reflection engine").toContain("__REFLECT__");
    expect(added, "keyless forget sweep").toContain("__MEMORY_LIFECYCLE__");
    // The third learning path (outcome resolution) is event-driven — NOT a sentinel:
    expect(added, "outcome resolution rides the event bus, not the scheduler").not.toContain("__OUTCOME__");
    // The deleted social-modeling cron must never register:
    expect(added, "social-modeling deleted in 226-04").not.toContain("__SOCIAL_MODELING__");
  });

  // Phase 225 FOLD §3.2: __MEMORY_CONSOLIDATION__ / __MEMORY_REASONING__ /
  // __USER_REPRESENTATION__ are NO LONGER registered (folded into __REFLECT__, Plan 04) —
  // dropped from the kill-switch set. The cost cron still gated by the switch is the
  // memory-review sweep (the usefulness judge was DELETED in Phase 226 SIMPLIFY-03).
  const COST_CRON_SENTINELS = [
    "__MEMORY_REVIEW__",
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

  it("leaves the $0 keyless lifecycle sweep UNAFFECTED by the cost kill switch", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(depsWithCostSwitch({ "agent-1": allFeaturesOnAgent() }, false));

    const addedSentinels = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    // The keyless lifecycle sweep is NOT a cost feature → still registered.
    expect(addedSentinels).toContain("__MEMORY_LIFECYCLE__");
    // (The privacy-gated __SOCIAL_MODELING__ cron — which this also used to assert — was
    //  DELETED in Phase 226-04 with the rest of that subsystem, so it must NOT register.)
    expect(addedSentinels).not.toContain("__SOCIAL_MODELING__");
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
      (c: any[]) => JSON.stringify(c).includes("memory.enabled: false"),
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
      (c: any[]) => JSON.stringify(c).includes("memory.enabled: false"),
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

  // (The __MEMORY_TRIPLE_EXTRACTION__ / WIRE-01 cron-registration tests were removed in
  // Phase 226 SIMPLIFY-03 — the no-op scaffold cron is DELETED; see the "DELETE (SIMPLIFY-03)"
  // guards above for the never-registers assertion.)

  // -------------------------------------------------------------------------
  // REFLECT-01 (v2.31 Reflection, Phase 223 Plan 05): the __REFLECT__ cron — the
  // reflect-engine replacement for the dead procedural-synthesis clustering cron.
  // DEFAULT OFF (the byte-identity guarantee). Registered ONLY when learningSkills.enabled
  // (the config key is REUSED until Phase 226) AND the master cost kill switch is on;
  // the __REFLECT__ sentinel dispatches runReflection (setup-channels-memory-crons-wire.ts).
  // -------------------------------------------------------------------------

  // The dead sentinel's literal payload text, constructed (not spelled inline) so the
  // "no orphaned __SKILL... reference in packages/daemon/src" delete-grep stays clean
  // while these regression asserts still prove the old cron is never registered.
  const DEAD_SYNTHESIS_SENTINEL = `__SKILL_${"SYNTHESIS"}__`;

  it("REFLECT-01: a DEFAULT agent registers NO reflection job (default-OFF / byte-identical)", async () => {
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

    const reflectAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__REFLECT__");
    expect(reflectAdds.length, "a default agent must add ZERO reflection jobs").toBe(0);
    // and the dead sentinel is gone entirely (no alias).
    const deadAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === DEAD_SYNTHESIS_SENTINEL);
    expect(deadAdds.length, "the dead procedural-synthesis cron must never be registered").toBe(0);
  });

  it("REFLECT-01: registers the __REFLECT__ cron (reflect-<agentId>, 0 3 * * *) for an opted-in agent", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        learning: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const reflectAdd = addJob.mock.calls
      .map((c) => c[0] as any)
      .find((j) => j?.payload?.text === "__REFLECT__");
    expect(reflectAdd, "an opted-in agent registers the reflection job").toBeDefined();
    expect(reflectAdd.id).toBe("reflect-agent-1");
    expect(reflectAdd.name).toBe("Reflection");
    expect(reflectAdd.payload.text).toBe("__REFLECT__");
    expect(reflectAdd.schedule).toEqual({ kind: "cron", expr: "0 3 * * *" });
    expect(reflectAdd.sessionTarget).toBe("isolated");
    expect(reflectAdd.sessionStrategy).toBe("fresh");
    // The dead sentinel/jobId is gone (no alias, no double-registration).
    expect(addJob.mock.calls.map((c) => (c[0] as any)?.id)).not.toContain("skill-synthesis-agent-1");
  });

  it("REFLECT-01: the master cost kill switch (costFeatures:false) force-disables the reflection cron even when opted in", async () => {
    const { addJob } = withRegistrableScheduler();
    const setupSchedulers = await getSetupSchedulers();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        learning: { enabled: true },
      },
    };
    await setupSchedulers(depsWithCostSwitch(agents, false));

    const reflectAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__REFLECT__");
    expect(reflectAdds.length, "the kill switch force-disables the reflection cron").toBe(0);
  });

  // -------------------------------------------------------------------------
  // RATE-02 (Phase 213-08): a cron-FIRED agent_turn run mints a FRESH attenuated
  // lease at the fire site — scoped to the JOB's agentId (NOT operator/system) +
  // the agent's RESOLVED caps + a fresh root-cron-* id, then registerRoot anchors
  // it. system_event crons do NOT mint; an absent cap layer is a no-op.
  // -------------------------------------------------------------------------
  describe("RATE-02 — fresh attenuated lease on cron-fire", () => {
    /** A leaseManager spy whose mintLease returns a stable issued lease. */
    function makeLeaseManager() {
      const mintLease = vi.fn(() => ({ leaseId: "lease-cron-1", bearer: "bearer-xyz" }));
      return { mintLease } as unknown as { mintLease: ReturnType<typeof vi.fn> };
    }

    /** Extract the executeJob callback from the (single) createCronScheduler call. */
    function extractExecuteJob() {
      const cronArgs = mockCreateCronScheduler.mock.calls[0][0];
      return cronArgs.executeJob as (job: unknown) => Promise<{ status: string }>;
    }

    /** An agent_turn cron job WITH a delivery target (so it reaches the execution branch). */
    function agentTurnJob(overrides: Record<string, unknown> = {}) {
      return {
        id: "job-at-1",
        name: "agent-turn-cron",
        agentId: "agent-1",
        payload: { kind: "agent_turn", message: "do the thing" },
        schedule: { kind: "every", everyMs: 60_000 },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        ...overrides,
      };
    }

    /** Deps whose eventBus.emit resolves the agent_turn deferred `onComplete`
     *  immediately, so `executeJob` returns fast (the mint runs synchronously
     *  BEFORE the await — we just don't want to block on the 10-min race). */
    function depsWithFastComplete(over: Record<string, unknown>) {
      const deps = createMinimalDeps({ cronEnabled: true, ...over });
      deps.container.eventBus.emit = vi.fn((_event: string, payload?: { onComplete?: (r: { status: string }) => void }) => {
        payload?.onComplete?.({ status: "ok" });
      });
      return deps;
    }

    it("mints a FRESH lease scoped to the JOB's agentId + its RESOLVED caps + a fresh root-cron-* id (no parentLeaseId)", async () => {
      mockResolveAutonomy.mockReturnValue({ enabled: true, capabilities: ["orch:read", "orch:web"] });
      const leaseManager = makeLeaseManager();
      const registerRoot = vi.fn();
      const setupSchedulers = await getSetupSchedulers();
      const deps = depsWithFastComplete({
        leaseManager,
        boundedAutonomyHolder: { current: { registerRoot } },
      });
      await setupSchedulers(deps);

      await extractExecuteJob()(agentTurnJob());

      expect(leaseManager.mintLease).toHaveBeenCalledTimes(1);
      const mintArg = leaseManager.mintLease.mock.calls[0][0];
      expect(mintArg.agentId).toBe("agent-1"); // the JOB's agent — NOT a system/operator identity
      expect(mintArg.caps).toEqual(["orch:read", "orch:web"]); // attenuated to the agent's OWN resolved caps
      expect(mintArg.rootRunId).toMatch(/^root-cron-job-at-1-/); // a FRESH root id for this cron run
      expect(mintArg.parentLeaseId).toBeUndefined(); // a cron-fired run is a NEW root
    });

    it("registerRoot anchors the minted lease (rootRunId + returned leaseId)", async () => {
      mockResolveAutonomy.mockReturnValue({ enabled: true, capabilities: ["orch:read"] });
      const leaseManager = makeLeaseManager();
      const registerRoot = vi.fn();
      const setupSchedulers = await getSetupSchedulers();
      const deps = depsWithFastComplete({
        leaseManager,
        boundedAutonomyHolder: { current: { registerRoot } },
      });
      await setupSchedulers(deps);

      await extractExecuteJob()(agentTurnJob());

      const mintArg = leaseManager.mintLease.mock.calls[0][0];
      expect(registerRoot).toHaveBeenCalledWith(mintArg.rootRunId, "lease-cron-1");
    });

    it("a system_event cron job does NOT mint a lease (RATE-02 is the agent_turn case)", async () => {
      mockResolveAutonomy.mockReturnValue({ enabled: true, capabilities: ["orch:read"] });
      const leaseManager = makeLeaseManager();
      const registerRoot = vi.fn();
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({
        cronEnabled: true,
        leaseManager,
        boundedAutonomyHolder: { current: { registerRoot } },
      });
      await setupSchedulers(deps);

      // A memory cron (system_event) — must NOT mint.
      await extractExecuteJob()({
        id: "memory-review-agent-1",
        name: "Memory review",
        agentId: "agent-1",
        payload: { kind: "system_event", text: "__MEMORY_REVIEW__" },
        schedule: { kind: "cron", expr: "0 2 * * *" },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
      });

      expect(leaseManager.mintLease).not.toHaveBeenCalled();
      expect(registerRoot).not.toHaveBeenCalled();
    });

    it("absent cap layer (no holder / no leaseManager) is a no-op — an agent_turn fire does NOT throw and does NOT mint", async () => {
      mockResolveAutonomy.mockReturnValue({ enabled: true, capabilities: ["orch:read"] });
      const leaseManager = makeLeaseManager();
      const setupSchedulers = await getSetupSchedulers();
      // No boundedAutonomyHolder at all → the mint is skipped (byte-identical).
      const deps = depsWithFastComplete({ leaseManager });
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(agentTurnJob());
      expect(result.status).toBe("ok");
      expect(leaseManager.mintLease).not.toHaveBeenCalled();
    });

    it("a disabled-autonomy agent (resolveAutonomy.enabled false) does NOT mint even with the cap layer present", async () => {
      mockResolveAutonomy.mockReturnValue({ enabled: false, capabilities: [] });
      const leaseManager = makeLeaseManager();
      const registerRoot = vi.fn();
      const setupSchedulers = await getSetupSchedulers();
      const deps = depsWithFastComplete({
        leaseManager,
        boundedAutonomyHolder: { current: { registerRoot } },
      });
      await setupSchedulers(deps);

      await extractExecuteJob()(agentTurnJob());
      expect(leaseManager.mintLease).not.toHaveBeenCalled();
    });
  });
});
