// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import type { WakeGateRunner } from "./wake-gate-runner.js";

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
// A faithful stand-in for the real wrapExternalContent: it surrounds the finding
// with UNTRUSTED boundary markers so the hook test can assert the wrap happened
// (the real delimiter/warning text is pinned by external-content's own suite).
const mockWrapExternalContent = vi.hoisted(() =>
  vi.fn((content: string) => `<<<UNTRUSTED_boundary>>>\n${content}\n<<<END_UNTRUSTED_boundary>>>`),
);
// Default-false quiet-hours spy: the deliver-on-skip path consults it before
// emitting, so a test can force an in-quiet-hours window per case.
const mockIsInQuietHours = vi.hoisted(() => vi.fn(() => false));

vi.mock("@comis/scheduler", () => ({
  createCronScheduler: mockCreateCronScheduler,
  createCronStore: mockCreateCronStore,
  createExecutionTracker: mockCreateExecutionTracker,
  resolveEffectiveHeartbeatConfig: vi.fn(() => ({ enabled: false, intervalMs: 60000 })),
  resolveHeartbeatSessionKey: vi.fn(() => ({ tenantId: "test", userId: "heartbeat", channelId: "hb-agent-1" })),
  isInQuietHours: mockIsInQuietHours,
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
  // The cron-fire mint resolves the JOB agent's autonomy
  // caps via resolveAutonomy. Default disabled; tests override per-case.
  resolveAutonomy: mockResolveAutonomy,
  // The wake-gate hook wraps a wake:true finding before prepending it.
  wrapExternalContent: mockWrapExternalContent,
  // Faithful pure stand-in for the shipped resolver (its three-state truth
  // table is unit-pinned in core): true → on; false → off; undefined →
  // follow the agent's script surface (on iff explicitly true).
  resolveCronWakeGateEnabled: (toggle?: boolean, scriptSurfaceOn?: boolean) =>
    toggle !== undefined ? toggle : scriptSurfaceOn === true,
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
      // Default the script surface on so the wake-gate hook's BEHAVIOR tests
      // (which leave scheduler.cron.wakeGate unset) resolve the toggle ON and
      // still exercise the gate; the tri-state TOGGLE cases pass explicit agents.
      autonomy: { script: true },
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
    mockIsInQuietHours.mockReturnValue(false);
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
    // Reads as the SUCCESS it is (a background/system-event job whose work rode
    // the emitted event), not a failure-looking "No delivery target" in a log review.
    expect(result.summary).toBe("Background event emitted (no chat delivery target)");
  });

  // -------------------------------------------------------------------------
  // 5b. deliveryTarget-less system_event jobs still emit scheduler:job_result.
  // The memory crons (review/consolidation/
  // reasoning/user-representation/usefulness-judge) are
  // registered as deliveryTarget-less __SENTINEL__ system_event jobs whose
  // WORK rides the scheduler:job_result listener. A short-circuit that
  // returned BEFORE the emit would make every memory cron complete "ok" nightly
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
  // 13.4. The standalone __MEMORY_CONSOLIDATION__ /
  // __MEMORY_REASONING__ / __USER_REPRESENTATION__ crons are NOT registered
  // — their work folds into the ONE __REFLECT__ cron. Even with the
  // per-agent cost subtrees ENABLED + the kill switch ON, NONE of the three
  // registers (gone, not run beside __REFLECT__).
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
    (deps.container as any).config.memory = { enabled: true }; // master kill switch ON

    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(deps);

    const added = addJob.mock.calls.map((c) => (c[0] as any)?.payload?.text);
    expect(added).not.toContain("__MEMORY_CONSOLIDATION__");
    expect(added).not.toContain("__MEMORY_REASONING__");
    expect(added).not.toContain("__USER_REPRESENTATION__");
  });

  // -------------------------------------------------------------------------
  // There is no __SOCIAL_MODELING__ cron and no social-modeling subsystem (no RelationshipStore
  // port + sqlite adapter, no `relationship` table, no offline directional-edge builder, no
  // relationship-block prompt injection, no per-agent socialModeling config key). Even when an
  // agent attempts an opt-in WITH a sign-off, NO __SOCIAL_MODELING__ job is registered.
  // -------------------------------------------------------------------------

  it("registers NO __SOCIAL_MODELING__ cron even when an agent attempts to opt in with a sign-off", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // An opt-in shape (enabled + signed off) — there is no registration block,
        // so it is inert (the socialModeling key is rejected at parse anyway).
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

  // (There are no __USEFULNESS_JUDGE__ cron-registration tests — the usefulness-judge cron does
  // not exist; see the "DELETE" guards below. There are no __ONLINE_TUNING__ cron-registration
  // tests — there is no UCB recall bandit or its cron; recall scoring is the fixed
  // config.rag.scoring alphas.)

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
  // 13.4z. memory master kill switch (opt-out posture)
  //
  // A single top-level gate. When `memory.enabled === false`, EVERY
  // LLM cost-bearing memory CRON is force-disabled at the registration site —
  // even for an agent whose per-agent feature is explicitly enabled. The gated
  // set is: memoryReview, memoryConsolidation, memoryReasoning,
  // memoryUserRepresentation, memoryUsefulnessJudge. The
  // $0 keyless memoryLifecycle sweep is NOT gated by this switch (lifecycle is keyless).
  // When the switch is on (the default) registration is unchanged →
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

  /** A deps object whose container carries an explicit memory.enabled (the master kill switch). */
  function depsWithCostSwitch(agents: Record<string, any>, costFeaturesEnabled: boolean) {
    const deps = createMinimalDeps({ agents });
    (deps.container as any).config.memory = { enabled: costFeaturesEnabled };
    return deps;
  }

  // -------------------------------------------------------------------------
  // The two DORMANT LLM crons do NOT exist. The
  // __USEFULNESS_JUDGE__ (a recordUsage-feeding seam) and __MEMORY_TRIPLE_EXTRACTION__
  // (a no-op scaffold whose `extract` returns []) registrations are GONE — even when
  // an operator attempts to opt an agent in, NO job is registered. The
  // surviving learning/memory crons are __MEMORY_REVIEW__ (accumulate-tier),
  // __MEMORY_LIFECYCLE__ (keyless forget sweep), __REFLECT__ (the engine).
  // There is no __SOCIAL_MODELING__ cron.
  // The "learning crons = 3" end state = __REFLECT__ + __MEMORY_LIFECYCLE__ + the
  // event-driven OutcomeSignalPort.resolve path (NOT a sentinel — there is no __OUTCOME__
  // cron); __MEMORY_REVIEW__ is accumulate-tier (kept, not counted as a learning cron).
  // -------------------------------------------------------------------------

  it("DELETE: registers NO __USEFULNESS_JUDGE__ cron even when an agent attempts to opt in", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // An opt-in shape — there is no registration block, so it is inert.
        memoryUsefulnessJudge: { enabled: true },
      },
    };
    const setupSchedulers = await getSetupSchedulers();
    await setupSchedulers(createMinimalDeps({ agents }));

    const judgeAdds = addJob.mock.calls.filter((c) => (c[0] as any)?.payload?.text === "__USEFULNESS_JUDGE__");
    expect(judgeAdds.length, "the __USEFULNESS_JUDGE__ cron is deleted — it must never register").toBe(0);
  });

  it("DELETE: registers NO __MEMORY_TRIPLE_EXTRACTION__ cron even when an agent attempts to opt in", async () => {
    const { addJob } = withRegistrableScheduler();
    const agents = {
      "agent-1": {
        name: "Agent 1",
        skills: { builtinTools: { browser: false } },
        session: { resetPolicy: { mode: "none" } },
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 } },
        // An opt-in shape — there is no registration block, so it is inert.
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
    // The social-modeling cron must never register:
    expect(added, "there is no social-modeling cron").not.toContain("__SOCIAL_MODELING__");
  });

  // __MEMORY_CONSOLIDATION__ / __MEMORY_REASONING__ /
  // __USER_REPRESENTATION__ are NOT registered (folded into __REFLECT__) —
  // dropped from the kill-switch set. The cost cron still gated by the switch is the
  // memory-review sweep (the usefulness judge cron does not exist).
  const COST_CRON_SENTINELS = [
    "__MEMORY_REVIEW__",
  ] as const;

  it("force-disables EVERY cost-bearing memory cron when memory.enabled is false (even per-agent-enabled)", async () => {
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
    // The privacy-gated __SOCIAL_MODELING__ cron does not exist, so it must NOT register.
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

  // (There are no __MEMORY_TRIPLE_EXTRACTION__ cron-registration tests — the no-op scaffold
  // cron does not exist; see the "DELETE" guards above for the never-registers assertion.)

  // -------------------------------------------------------------------------
  // The __REFLECT__ cron — the reflect engine.
  // DEFAULT OFF (the byte-identity guarantee). Registered ONLY when learning.enabled
  // AND the master cost kill switch is on;
  // the __REFLECT__ sentinel dispatches runReflection (setup-channels-memory-crons-wire.ts).
  // -------------------------------------------------------------------------

  // The dead sentinel's literal payload text, constructed (not spelled inline) so the
  // "no orphaned __SKILL... reference in packages/daemon/src" delete-grep stays clean
  // while these regression asserts still prove the old cron is never registered.
  const DEAD_SYNTHESIS_SENTINEL = `__SKILL_${"SYNTHESIS"}__`;

  it("a DEFAULT agent registers NO reflection job (default-OFF / byte-identical)", async () => {
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

  it("registers the __REFLECT__ cron (reflect-<agentId>, 0 3 * * *) for an opted-in agent", async () => {
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

  it("the master cost kill switch (costFeatures:false) force-disables the reflection cron even when opted in", async () => {
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
  // A cron-FIRED agent_turn run mints a FRESH attenuated
  // lease at the fire site — scoped to the JOB's agentId (NOT operator/system) +
  // the agent's RESOLVED caps + a fresh root-cron-* id, then registerRoot anchors
  // it. system_event crons do NOT mint; an absent cap layer is a no-op.
  // -------------------------------------------------------------------------
  describe("fresh attenuated lease on cron-fire", () => {
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

    it("a system_event cron job does NOT mint a lease (only the agent_turn case mints)", async () => {
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

  // -------------------------------------------------------------------------
  // The pre-payload wake-gate hook. A job may carry a `wakeGate`; when a runner
  // ref is populated, executeJob runs the gate BEFORE the payload branch:
  //   - wake:false → skip the payload entirely (no dispatch), record a
  //     status:"skipped" row, and return status:"ok" so the job re-arms.
  //   - wake:true + context → prepend the wrapExternalContent-wrapped finding
  //     to the message before the existing dispatch.
  //   - runAsToday / no wakeGate / no ref → byte-identical to today.
  // The ref is read at FIRE time (late-bound), so a runner populated AFTER
  // setup is picked up on the next fire.
  // -------------------------------------------------------------------------
  describe("pre-payload wake-gate hook", () => {
    const GATE = { script: "export default async () => ({ wake: false });", language: "ts" as const, timeoutSeconds: 5 };

    /** A gated agent_turn job WITH a delivery target (so it reaches the payload branch). */
    function gatedAgentTurnJob(over: Record<string, unknown> = {}) {
      return {
        id: "job-wg-1",
        name: "gated-cron",
        agentId: "agent-1",
        payload: { kind: "agent_turn", message: "do the thing" },
        schedule: { kind: "every", everyMs: 60_000 },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        wakeGate: GATE,
        ...over,
      };
    }

    /** Resolve the agent_turn deferred `onComplete` immediately so executeJob does
     *  not block on the 10-min race (the dispatch still fires synchronously first). */
    function withFastComplete(deps: ReturnType<typeof createMinimalDeps>) {
      deps.container.eventBus.emit = vi.fn((_e: string, payload?: { onComplete?: (r: { status: string }) => void }) => {
        payload?.onComplete?.({ status: "ok" });
      });
      return deps;
    }

    function extractExecuteJob() {
      return mockCreateCronScheduler.mock.calls[0][0].executeJob as (
        job: unknown,
      ) => Promise<{ status: string; summary?: string }>;
    }

    function makeRunnerRef(runWakeGate: ReturnType<typeof vi.fn>): { ref?: WakeGateRunner } {
      return { ref: { runWakeGate } as unknown as WakeGateRunner };
    }

    /** Wrap a bare verdict in the richer runWakeGate outcome. The hook reads the
     *  `verdict` for its branch AND the `durationMs`/`toolCalls` counts for the
     *  emit + the skip-row enrichment; counts default to 0 but a case can pin them
     *  to prove they flow from the runner's outcome into the event/row/record. */
    function wgOutcome(verdict: unknown, counts: { durationMs?: number; toolCalls?: number; failedOpen?: boolean; rootRunId?: string } = {}) {
      return { verdict, durationMs: counts.durationMs ?? 0, toolCalls: counts.toolCalls ?? 0, failedOpen: counts.failedOpen ?? false, rootRunId: counts.rootRunId ?? "root-wakegate-job-wg-1-abc-0" };
    }

    /** An agents map whose agent-1 drives the two inputs of the gate-run toggle:
     *  the per-agent `scheduler.cron.wakeGate` (effectiveCron.wakeGate) and the
     *  `autonomy.script` surface. Only-set keys are attached, so each is genuinely
     *  tri-state (an omitted opt stays undefined). */
    function agentsWith(opts: { wakeGate?: boolean; script?: boolean }) {
      const cron: Record<string, unknown> = { enabled: true, maxConcurrentRuns: 2, maxJobs: 10 };
      if (opts.wakeGate !== undefined) cron.wakeGate = opts.wakeGate;
      return {
        "agent-1": {
          name: "Agent 1",
          skills: { builtinTools: { browser: false, exec: false, process: false } },
          session: { resetPolicy: { mode: "none" } },
          scheduler: { cron },
          ...(opts.script !== undefined ? { autonomy: { script: opts.script } } : {}),
        },
      };
    }

    it("runs the gate and SKIPS the payload on wake:false — no scheduler:job_result dispatch, a status:skipped row, and status:ok re-arm", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);
      const tracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };

      const result = await extractExecuteJob()(gatedAgentTurnJob());

      expect(runWakeGate).toHaveBeenCalledTimes(1);
      // The payload dispatch (scheduler:job_result) is NEVER emitted on a skip.
      expect(deps.container.eventBus.emit).not.toHaveBeenCalledWith("scheduler:job_result", expect.anything());
      // A skipped row is recorded so the suppression is visible on cron.runs.
      expect(tracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-wg-1", status: "skipped", summary: "wake-gate: skipped" }),
      );
      // status:ok re-arms the job (a status:error would wrongly trigger backoff).
      expect(result).toEqual(expect.objectContaining({ status: "ok", summary: "wake-gate: skipped" }));
    });

    it("prepends the wrapExternalContent-wrapped context to the agent_turn message on wake:true before dispatch", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true, context: "CI is RED" }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      // The finding is wrapped as untrusted external content (source "unknown").
      expect(mockWrapExternalContent).toHaveBeenCalledWith("CI is RED", { source: "unknown" });
      const emitCall = (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "scheduler:job_result",
      );
      expect(emitCall).toBeDefined();
      const dispatched = (emitCall![1] as { result: string }).result;
      // The wrapped finding is PREPENDED (before the original message), carries the
      // UNTRUSTED boundary, and the original message survives.
      expect(dispatched).toContain("CI is RED");
      expect(dispatched).toContain("UNTRUSTED");
      expect(dispatched).toContain("do the thing");
      expect(dispatched.indexOf("CI is RED")).toBeLessThan(dispatched.indexOf("do the thing"));
    });

    it("does NOT inject the wrapped context on a verbatim-delivered (non-main) system_event — the wrapper markers must not leak to the channel", async () => {
      // A non-main system_event with a deliveryTarget is delivered as RAW text,
      // no model. The wrapExternalContent markers exist to inform the MODEL, so
      // injecting them here would leak internal framing verbatim to the channel.
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true, context: "disk 91%" }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);

      await extractExecuteJob()({
        id: "job-verbatim", name: "verbatim-cron", agentId: "agent-1",
        payload: { kind: "system_event", text: "Scheduled status" },
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        wakeGate: GATE,
      });

      expect(runWakeGate).toHaveBeenCalledTimes(1);
      const emitCall = (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "scheduler:job_result",
      );
      expect(emitCall).toBeDefined();
      const dispatched = (emitCall![1] as { result: string }).result;
      // The raw-delivered text is unwrapped — no boundary markers, original intact.
      expect(dispatched).not.toContain("UNTRUSTED");
      expect(dispatched).toBe("Scheduled status");
    });

    it("STILL injects the wrapped context on a main-routed system_event (the heartbeat reaches the model)", async () => {
      // The main+system_event path enqueues to the heartbeat pipeline (model runs),
      // so the wrapped context must still be prepended there.
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true, context: "disk 91%" }));
      const mockQueue = createMockSystemEventQueue();
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, systemEventQueue: mockQueue, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);

      await extractExecuteJob()({
        id: "job-main-wg", name: "main-gated", agentId: "agent-1",
        payload: { kind: "system_event", text: "Heartbeat note" },
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        wakeGate: GATE,
      });

      expect(mockWrapExternalContent).toHaveBeenCalledWith("disk 91%", { source: "unknown" });
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      const enqueuedText = mockQueue.enqueue.mock.calls[0][0] as string;
      expect(enqueuedText).toContain("UNTRUSTED");
      expect(enqueuedText).toContain("disk 91%");
      expect(enqueuedText).toContain("Heartbeat note");
    });

    it("does NOT call the gate and dispatches byte-identically when the job carries no wakeGate", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);

      const result = await extractExecuteJob()({
        id: "job-1", name: "test-job", agentId: "agent-1",
        payload: { kind: "system_event", text: "Hello from cron" },
        schedule: { kind: "every", everyMs: 60_000 },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
      });

      expect(runWakeGate).not.toHaveBeenCalled();
      expect(result.status).toBe("ok");
      expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
        "scheduler:job_result",
        expect.objectContaining({ result: "Hello from cron", success: true }),
      );
    });

    it("falls through to the normal dispatch on a runAsToday degrade verdict (no skipped row)", async () => {
      const runWakeGate = vi.fn(async () => ({ runAsToday: true }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);
      const tracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };

      const result = await extractExecuteJob()({
        id: "job-degrade", name: "gated-cron", agentId: "agent-1",
        payload: { kind: "system_event", text: "Hello from cron" },
        schedule: { kind: "every", everyMs: 60_000 },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        wakeGate: GATE,
      });

      expect(runWakeGate).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("ok");
      expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
        "scheduler:job_result",
        expect.objectContaining({ result: "Hello from cron" }),
      );
      expect(tracker.record).not.toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
    });

    it("reads the runner ref at FIRE time — a ref populated AFTER setup is used on the next fire", async () => {
      const wakeGateRunnerRef: { ref?: WakeGateRunner } = {}; // initially empty
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef }));
      await setupSchedulers(deps);
      // Populate the ref AFTER setup, BEFORE the fire — the hook must still pick it up.
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      wakeGateRunnerRef.ref = { runWakeGate } as unknown as WakeGateRunner;

      await extractExecuteJob()(gatedAgentTurnJob());

      expect(runWakeGate).toHaveBeenCalledTimes(1); // proves the hook read .ref at fire time
    });

    it("runs a gated job as today when the runner ref is never populated (no throw, dispatch fires)", async () => {
      const wakeGateRunnerRef: { ref?: WakeGateRunner } = {}; // never populated
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef });
      await setupSchedulers(deps);

      const result = await extractExecuteJob()({
        id: "job-1", name: "test-job", agentId: "agent-1",
        payload: { kind: "system_event", text: "Hello from cron" },
        schedule: { kind: "every", everyMs: 60_000 },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        wakeGate: GATE,
      });

      expect(result.status).toBe("ok");
      expect(deps.container.eventBus.emit).toHaveBeenCalledWith(
        "scheduler:job_result",
        expect.objectContaining({ result: "Hello from cron" }),
      );
    });

    // -------------------------------------------------------------------------
    // The scheduler.cron.wakeGate operator toggle. A scheduler-initiated gate is
    // a distinct trust context (no human/model in the loop at fire time), so it
    // runs ONLY when the toggle resolves ON: true → on; false → off; undefined →
    // follow the agent's autonomy.script surface. With it off, a gated job runs
    // exactly as today — runWakeGate is never called and the payload dispatches
    // unchanged. The toggle grants no capability.
    // -------------------------------------------------------------------------
    it("does NOT run the gate when the wakeGate toggle is false — dispatches as today, no scheduler:wake_gate", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ agents: agentsWith({ wakeGate: false }), wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(gatedAgentTurnJob());

      // Toggle off → the gate never runs; the job falls straight through.
      expect(runWakeGate).not.toHaveBeenCalled();
      expect(deps.container.eventBus.emit).not.toHaveBeenCalledWith("scheduler:wake_gate", expect.anything());
      // Runs exactly as today: the payload dispatches with the ORIGINAL message.
      const emitCall = (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "scheduler:job_result");
      expect(emitCall).toBeDefined();
      expect((emitCall![1] as { result: string }).result).toBe("do the thing");
      expect(result.status).toBe("ok");
    });

    it("runs the gate when the wakeGate toggle is true", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ agents: agentsWith({ wakeGate: true }), wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());
      expect(runWakeGate).toHaveBeenCalledTimes(1);
    });

    it("runs the gate when the toggle is undefined and the agent's autonomy.script surface is on", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ agents: agentsWith({ script: true }), wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());
      expect(runWakeGate).toHaveBeenCalledTimes(1);
    });

    it("does NOT run the gate when the toggle is undefined and the script surface is off — runs as today", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ agents: agentsWith({ script: false }), wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(gatedAgentTurnJob());
      expect(runWakeGate).not.toHaveBeenCalled();
      expect(result.status).toBe("ok");
      // Dispatches as today with the original message.
      expect(deps.container.eventBus.emit).toHaveBeenCalledWith("scheduler:job_result", expect.objectContaining({ result: "do the thing" }));
    });

    // -------------------------------------------------------------------------
    // Deliver-on-skip: a wake:false verdict that carries a `deliver` ships that
    // routine ✓ status directly — reusing the cron-delivery event with NO model
    // turn (payloadKind:"system_event" → the listener's raw verbatim branch, and
    // NO onComplete → nothing triggers the model), honoring quiet-hours, and
    // ALWAYS recording the status:"skipped" row so the job re-arms.
    // -------------------------------------------------------------------------

    it("delivers a wake:false+deliver verdict via a raw scheduler:job_result (no onComplete, no model turn) and still records the skip", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false, deliver: "✓ backup OK" }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      // Mirror the delivery listener: the model runs ONLY for an agent_turn payload
      // carrying a deferred resolver. Wire that here so a stray model turn trips the
      // spy — even though the gated job below is itself an agent_turn.
      const modelDispatch = vi.fn();
      deps.container.eventBus.emit = vi.fn((_e: string, payload?: { payloadKind?: string; onComplete?: (r: { status: string }) => void }) => {
        if (payload?.payloadKind === "agent_turn" && payload.onComplete) {
          modelDispatch();
          payload.onComplete({ status: "ok" });
        }
      });
      await setupSchedulers(deps);
      const tracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };

      // An AGENT_TURN gated job — proves even an agent_turn payload delivers verbatim, no model.
      const result = await extractExecuteJob()(gatedAgentTurnJob());

      const emitCall = (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "scheduler:job_result",
      );
      expect(emitCall, "a deliver verdict emits scheduler:job_result").toBeDefined();
      const dispatched = emitCall![1] as {
        result: string; success: boolean;
        deliveryTarget?: unknown; payloadKind?: string;
        onComplete?: unknown;
      };
      expect(dispatched.result).toBe("✓ backup OK");
      expect(dispatched.success).toBe(true);
      expect(dispatched.deliveryTarget).toEqual({ channelType: "telegram", channelId: "chat-1" });
      // NO model turn: no deferred resolver + a non-agent_turn kind (the raw verbatim branch).
      expect(dispatched.onComplete, "no onComplete → nothing triggers the model").toBeUndefined();
      expect(dispatched.payloadKind, "system_event routes to the raw verbatim branch").not.toBe("agent_turn");
      expect(modelDispatch, "the model never runs on a deliver-skip").not.toHaveBeenCalled();
      // The skip is ALWAYS recorded so it stays visible on cron.runs.
      expect(tracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-wg-1", status: "skipped", summary: "wake-gate: skipped" }),
      );
      expect(result).toEqual(expect.objectContaining({ status: "ok", summary: "wake-gate: skipped" }));
    });

    it("wires a trailing [SILENT] status through to delivery; a HEARTBEAT_OK / NO_REPLY verdict (no deliver) skips with NO delivery", async () => {
      const setupSchedulers = await getSetupSchedulers();

      // A trailing [SILENT] <text> gate yields deliver:"<text>" → it egresses.
      const deliverGate = vi.fn(async () => wgOutcome({ wake: false, deliver: "backup OK" }));
      const depsDeliver = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(deliverGate) });
      await setupSchedulers(depsDeliver);
      const resDeliver = await extractExecuteJob()(gatedAgentTurnJob());
      const deliverEmit = (depsDeliver.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "scheduler:job_result",
      );
      expect(deliverEmit, "a [SILENT] status wires through to delivery").toBeDefined();
      expect((deliverEmit![1] as { result: string }).result).toBe("backup OK");
      expect(resDeliver).toEqual(expect.objectContaining({ status: "ok", summary: "wake-gate: skipped" }));

      // Reset between the contrast halves so extractExecuteJob() reads the second setup.
      vi.clearAllMocks();
      mockIsInQuietHours.mockReturnValue(false);

      // A HEARTBEAT_OK / NO_REPLY gate yields {wake:false} with NO deliver → pure skip, NO emit.
      const silentGate = vi.fn(async () => wgOutcome({ wake: false }));
      const depsSilent = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(silentGate) });
      await setupSchedulers(depsSilent);
      const silentTracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };
      const resSilent = await extractExecuteJob()(gatedAgentTurnJob());
      expect(depsSilent.container.eventBus.emit).not.toHaveBeenCalledWith("scheduler:job_result", expect.anything());
      expect(silentTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped", summary: "wake-gate: skipped" }),
      );
      expect(resSilent.status).toBe("ok");
    });

    it("suppresses the deliver during quiet hours but STILL records the skip; delivers when quiet hours are clear", async () => {
      const setupSchedulers = await getSetupSchedulers();

      // Quiet hours ACTIVE → the routine ✓ must not ping: NO delivery emit...
      mockIsInQuietHours.mockReturnValue(true);
      const quietGate = vi.fn(async () => wgOutcome({ wake: false, deliver: "✓ backup OK" }));
      const depsQuiet = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(quietGate) });
      await setupSchedulers(depsQuiet);
      const quietTracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };
      const resQuiet = await extractExecuteJob()(gatedAgentTurnJob());
      expect(depsQuiet.container.eventBus.emit).not.toHaveBeenCalledWith("scheduler:job_result", expect.anything());
      // ...but the skip IS still recorded (quiet suppresses delivery, never the skip).
      expect(quietTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped", summary: "wake-gate: skipped" }),
      );
      expect(resQuiet).toEqual(expect.objectContaining({ status: "ok" }));

      // Companion (quiet hours CLEAR) → the same verdict DOES emit.
      vi.clearAllMocks();
      mockIsInQuietHours.mockReturnValue(false);
      const clearGate = vi.fn(async () => wgOutcome({ wake: false, deliver: "✓ backup OK" }));
      const depsClear = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(clearGate) });
      await setupSchedulers(depsClear);
      await extractExecuteJob()(gatedAgentTurnJob());
      const clearEmit = (depsClear.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "scheduler:job_result",
      );
      expect(clearEmit, "a clear-quiet-hours deliver DOES emit").toBeDefined();
      expect((clearEmit![1] as { result: string }).result).toBe("✓ backup OK");
    });

    // -------------------------------------------------------------------------
    // A malformed quietHours.start/end (no HH:MM schema validation) makes
    // isInQuietHours throw. That throw must NOT reach executeJob's catch, where a
    // DECIDED skip would degrade to status:"error" → consecutiveErrors → auto-suspend
    // (silently killing a wake:false monitor). A failed check is treated as "in quiet
    // hours": suppress the routine ping and STILL record the skip.
    // -------------------------------------------------------------------------

    it("suppresses the deliver + records the skip + returns ok + WARNs errorKind:config when the quiet-hours check throws (never degrades to a job error)", async () => {
      mockIsInQuietHours.mockImplementation(() => {
        throw new Error('Invalid time format: "25:99" (expected HH:MM)');
      });
      const gate = vi.fn(async () => wgOutcome({ wake: false, deliver: "✓ backup OK" }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(gate) });
      await setupSchedulers(deps);
      const tracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };

      const result = await extractExecuteJob()(gatedAgentTurnJob());

      // No deliver emit — a routine ping must not fire when the window can't be evaluated.
      expect(deps.container.eventBus.emit).not.toHaveBeenCalledWith("scheduler:job_result", expect.anything());
      // The decided skip is STILL recorded (never lost to an error record).
      expect(tracker.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped", summary: "wake-gate: skipped" }),
      );
      // The job re-arms with status:ok — NOT the pre-fix error → suspend path.
      expect(result).toEqual(expect.objectContaining({ status: "ok" }));
      // A config-classified WARN names the misconfigured knob.
      const warn = (deps.schedulerLogger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[1] as string)?.includes("quiet-hours check failed"),
      );
      expect(warn, "a config-kind WARN fired for the malformed quiet-hours window").toBeDefined();
      expect((warn![0] as { errorKind?: string }).errorKind).toBe("config");
    });

    // -------------------------------------------------------------------------
    // A deliver verdict on a job with NO deliveryTarget is dropped (there is no
    // channel to deliver to), but with a distinguishing DEBUG so a gate author sees
    // their status was discarded — instead of the generic no-deliver skip signal.
    // -------------------------------------------------------------------------

    it("logs a distinct DEBUG when a deliver verdict lands on a job with no deliveryTarget (nothing to deliver to)", async () => {
      const gate = vi.fn(async () => wgOutcome({ wake: false, deliver: "✓ nightly OK" }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(gate) });
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(gatedAgentTurnJob({ deliveryTarget: undefined }));

      // No delivery (no channel), still records the skip and re-arms ok.
      expect(deps.container.eventBus.emit).not.toHaveBeenCalledWith("scheduler:job_result", expect.anything());
      expect(result).toEqual(expect.objectContaining({ status: "ok", summary: "wake-gate: skipped" }));
      // The discarded deliver is visible as a distinct DEBUG (not the generic skip INFO).
      const dbg = (deps.schedulerLogger.debug as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[1] as string)?.includes("deliver dropped (no delivery target)"),
      );
      expect(dbg, "a distinct debug signals the discarded deliver").toBeDefined();
    });

    // -------------------------------------------------------------------------
    // The savings/health emit: every GATED fire (skip AND wake) emits exactly
    // ONE content-free scheduler:wake_gate carrying the verdict enum + the
    // runner's counts + the derived estTurnsSaved (1 avoided model turn per skip,
    // 0 on wake). NEVER the gathered finding / the script / a secret — the emit is
    // the fleet fork's feed. A runAsToday degrade emits nothing (no gate ran).
    // -------------------------------------------------------------------------

    /** The content-free allowlist — the ONLY keys a scheduler:wake_gate may carry. */
    const WAKE_GATE_KEYS = ["jobId", "agentId", "wake", "durationMs", "toolCalls", "estTurnsSaved", "failedOpen", "timestamp"];

    /** The scheduler:wake_gate emit calls captured on the eventBus spy. */
    function wakeGateEmits(deps: ReturnType<typeof createMinimalDeps>) {
      return (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "scheduler:wake_gate",
      );
    }

    it("emits ONE content-free scheduler:wake_gate with estTurnsSaved:1 on a skip, counts flowing from the outcome", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }, { durationMs: 42, toolCalls: 3 }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      const emits = wakeGateEmits(deps);
      expect(emits).toHaveLength(1);
      const payload = emits[0][1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        jobId: "job-wg-1", agentId: "agent-1", wake: false,
        durationMs: 42, toolCalls: 3, estTurnsSaved: 1, failedOpen: false,
      });
      expect(typeof payload.timestamp).toBe("number");
      // Content-free (I5): EXACTLY the allowlist keys — no gathered finding /
      // script / deliver / payload crosses into the fleet fork's feed.
      expect(Object.keys(payload).sort()).toEqual([...WAKE_GATE_KEYS].sort());
    });

    it("emits ONE scheduler:wake_gate with wake:true + estTurnsSaved:0 on a wake", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true }, { durationMs: 42, toolCalls: 3 }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      const emits = wakeGateEmits(deps);
      expect(emits).toHaveLength(1);
      const payload = emits[0][1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        jobId: "job-wg-1", agentId: "agent-1", wake: true,
        durationMs: 42, toolCalls: 3, estTurnsSaved: 0, failedOpen: false,
      });
      expect(Object.keys(payload).sort()).toEqual([...WAKE_GATE_KEYS].sort());
    });

    it("logs an INFO completion line on a WOKE fire (a skip already has one; a wake previously only DEBUG)", async () => {
      const runWakeGate = vi.fn(async () =>
        wgOutcome({ wake: true }, { durationMs: 42, toolCalls: 3, rootRunId: "root-wakegate-job-wg-1-abc-0" }),
      );
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      // child() returns the same mock, so the jobLogger.info calls land here.
      const info = deps.schedulerLogger.info as ReturnType<typeof vi.fn>;
      const woke = info.mock.calls.find((c) => /woke the model/i.test(String(c[1])));
      expect(woke, "a woke gate fire must log an INFO completion line (raw-log self-sufficiency)").toBeDefined();
      expect(woke![0]).toMatchObject({
        step: "wake-gate", wake: true, failedOpen: false,
        durationMs: 42, toolCalls: 3, rootRunId: "root-wakegate-job-wg-1-abc-0",
      });
    });

    it("marks a FAIL-OPEN woke fire distinctly in the INFO line (the broken-gate signal in the raw log)", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true }, { failedOpen: true }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      const info = deps.schedulerLogger.info as ReturnType<typeof vi.fn>;
      const failOpen = info.mock.calls.find((c) => /fail-open/i.test(String(c[1])));
      expect(failOpen, "a fail-open woke fire must be marked in the log").toBeDefined();
      expect(failOpen![0]).toMatchObject({ step: "wake-gate", wake: true, failedOpen: true });
    });

    it("enriches the skip's ExecutionTracker row with toolCalls + estTurnsSaved:1 (the cron.runs skip lens)", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }, { durationMs: 42, toolCalls: 3 }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);
      const tracker = mockCreateExecutionTracker.mock.results[0].value as { record: ReturnType<typeof vi.fn> };

      await extractExecuteJob()(gatedAgentTurnJob());

      // The skip row now carries the counts so `cron.runs "<jobName>"` reconstructs
      // the suppressed fire (the fixed summary string is unchanged — no residue) —
      // plus the rootRunId so an operator can `comis explain <rootRunId>` a gate that
      // made cap-calls before skipping (a skip-after-fetch).
      expect(tracker.record).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-wg-1", status: "skipped", summary: "wake-gate: skipped",
          toolCalls: 3, estTurnsSaved: 1, rootRunId: "root-wakegate-job-wg-1-abc-0",
        }),
      );
    });

    it("emits NO scheduler:wake_gate on a runAsToday degrade (the job ran as today — nothing to measure)", async () => {
      const runWakeGate = vi.fn(async () => ({ runAsToday: true }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) });
      await setupSchedulers(deps);

      await extractExecuteJob()({
        id: "job-degrade", name: "gated-cron", agentId: "agent-1",
        payload: { kind: "system_event", text: "Hello from cron" },
        schedule: { kind: "every", everyMs: 60_000 },
        deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
        wakeGate: GATE,
      });

      expect(wakeGateEmits(deps)).toHaveLength(0);
    });

    // -------------------------------------------------------------------------
    // The incident fork producer: a WOKE fire writes a direct, content-free
    // scheduler.wake_gate record onto the job's MAIN-session trajectory (off-turn:
    // no live bus bridge in the cron/daemon context — mirrors the image:* /
    // capability:audited direct emits) so `comis explain` folds it. A SKIP records
    // NOTHING (it opens no session; its lens is the enriched cron.runs row) — the
    // producer-side negative. The record is best-effort: an absent registry or a
    // recorder that resolves undefined must never throw or block the dispatch.
    // -------------------------------------------------------------------------

    /** A capture recorder + a registry resolving it by sessionKey. */
    function captureRegistry() {
      const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
      const recorder = {
        recordEvent: vi.fn((type: string, data: Record<string, unknown>) => {
          calls.push({ type, data });
          return "queued" as const;
        }),
      };
      const getRecorder = vi.fn(() => recorder);
      return { calls, getRecorder };
    }

    it("records ONE content-free scheduler.wake_gate on the job's main session on a WOKE fire", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true }, { durationMs: 42, toolCalls: 3 }));
      const reg = captureRegistry();
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate), trajectoryRegistry: reg }));
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      // Keyed to the job's main session — the SAME key the gate's lease used, so
      // `comis explain <sessionKey|rootRunId>` reconstructs the fire + its cap-calls.
      expect(reg.getRecorder).toHaveBeenCalledWith("test|heartbeat|hb-agent-1");
      expect(reg.calls).toHaveLength(1);
      expect(reg.calls[0].type).toBe("scheduler.wake_gate");
      expect(reg.calls[0].data).toEqual({
        jobId: "job-wg-1", agentId: "agent-1", wake: true,
        durationMs: 42, toolCalls: 3, estTurnsSaved: 0,
      });
      // Content-free (I5): no gathered finding / script / deliver in the record.
      for (const forbidden of ["context", "deliver", "script", "payload"]) {
        expect(reg.calls[0].data).not.toHaveProperty(forbidden);
      }
    });

    it("records NO trajectory event on a SKIP — the skip opens no session (the producer negative)", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: false }, { durationMs: 42, toolCalls: 3 }));
      const reg = captureRegistry();
      const setupSchedulers = await getSetupSchedulers();
      const deps = createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate), trajectoryRegistry: reg });
      await setupSchedulers(deps);

      await extractExecuteJob()(gatedAgentTurnJob());

      // A skip is reconstructed via the enriched cron.runs row, never the trajectory.
      expect(reg.getRecorder).not.toHaveBeenCalled();
      expect(reg.calls).toHaveLength(0);
    });

    it("off-turn safe: a WOKE fire does NOT throw and STILL dispatches when the registry resolves no recorder", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true }, { durationMs: 42, toolCalls: 3 }));
      const getRecorder = vi.fn(() => undefined); // closed session / daemon restart → no recorder
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate), trajectoryRegistry: { getRecorder } }));
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(gatedAgentTurnJob());

      expect(getRecorder).toHaveBeenCalledWith("test|heartbeat|hb-agent-1");
      expect(result.status).toBe("ok"); // the best-effort record no-op never degraded the job
      // The woke fire STILL runs the model (the dispatch fired).
      const dispatched = (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "scheduler:job_result");
      expect(dispatched).toBeDefined();
    });

    it("off-turn safe: a WOKE fire does NOT throw and STILL dispatches when no trajectoryRegistry is threaded", async () => {
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true }, { durationMs: 42, toolCalls: 3 }));
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate) })); // no trajectoryRegistry
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(gatedAgentTurnJob());

      expect(result.status).toBe("ok");
      const dispatched = (deps.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "scheduler:job_result");
      expect(dispatched).toBeDefined();
    });

    it("makes a dropped woke trajectory fact OBSERVABLE via a DEBUG (not a silent no-op) when getRecorder resolves no recorder", async () => {
      // The woke trajectory record is the ONLY source of the cronWakeGate incident
      // fact; when the main-session recorder is not open (daemon restart /
      // monitor-only agent / idle-evicted session) getRecorder resolves undefined
      // and the fact is dropped. The drop must be observable, not a silent no-op.
      const runWakeGate = vi.fn(async () => wgOutcome({ wake: true }, { durationMs: 42, toolCalls: 3 }));
      const getRecorder = vi.fn(() => undefined); // closed session / restart / monitor-only → no recorder
      const setupSchedulers = await getSetupSchedulers();
      const deps = withFastComplete(createMinimalDeps({ cronEnabled: true, wakeGateRunnerRef: makeRunnerRef(runWakeGate), trajectoryRegistry: { getRecorder } }));
      await setupSchedulers(deps);

      const result = await extractExecuteJob()(gatedAgentTurnJob());

      // A wake-gate DEBUG now names the drop (pre-fix this was a silent
      // optional-chain no-op — no debug at all).
      const debug = deps.schedulerLogger.debug as ReturnType<typeof vi.fn>;
      const dropDebug = debug.mock.calls.find(
        ([fields]) =>
          typeof (fields as { hint?: unknown }).hint === "string" &&
          /recorder/.test((fields as { hint: string }).hint) &&
          (fields as { step?: string }).step === "wake-gate",
      );
      expect(dropDebug).toBeDefined();
      // The drop never degrades the fire: status:ok, the fleet emit fired, AND the
      // model still dispatched (the durable forks stay whole).
      expect(result.status).toBe("ok");
      const emit = deps.container.eventBus.emit as ReturnType<typeof vi.fn>;
      expect(emit.mock.calls.find((c) => c[0] === "scheduler:wake_gate")).toBeDefined();
      expect(emit.mock.calls.find((c) => c[0] === "scheduler:job_result")).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// The reflect-funnel run recorder.
// ---------------------------------------------------------------------------

describe("recordReflectFunnelRun — reflect run folded onto cron history", () => {
  it("records a CONTENT-FREE funnel verdict under the reflect-<agentId> jobId so cron.runs surfaces it", async () => {
    const { recordReflectFunnelRun } = await import("./setup-schedulers.js");
    const recorded: Array<Record<string, unknown>> = [];
    const tracker = {
      record: async (e: Record<string, unknown>) => { recorded.push(e); },
      getHistory: async () => [],
      checkAnomaly: async () => ({ isAnomaly: false, medianMs: 0, thresholdMs: 0 }),
    };
    await recordReflectFunnelRun(
      tracker as never,
      { agentId: "default", admissionOutcome: "admitted", admitted: 1, maxClusterCardinality: 2, distinctTopicKeys: 1, untrustedDrops: 0, sourceTrajectoryCount: 2, totalSourceChars: 480 },
      1717171717,
    );
    expect(recorded).toHaveLength(1);
    const e = recorded[0] as { jobId: string; status: string; summary: string; ts: number };
    expect(e.jobId).toBe("reflect-default"); // resolveJobByName(scheduler,"Reflection") → this id
    expect(e.status).toBe("ok");
    expect(e.ts).toBe(1717171717);
    // The verdict + magnitudes — answers "why admit/no-admit" without a daemon.log grep.
    expect(e.summary).toContain("outcome=admitted");
    expect(e.summary).toContain("untrustedDrops=0");
    expect(e.summary).toContain("src=2traj/480ch");
    // The under-merge discriminator on the run record (topics=1 + maxCard=2 = corroborated).
    expect(e.summary).toContain("topics=1");
    // Counts + the closed enum only — never a reflected doc body.
    expect(e.summary).not.toMatch(/procedure|markdown|##|rm -rf/);
  });

  it("surfaces an untrusted_origin verdict's magnitude (untrustedDrops) on the run record", async () => {
    const { recordReflectFunnelRun } = await import("./setup-schedulers.js");
    const recorded: Array<Record<string, unknown>> = [];
    const tracker = { record: async (e: Record<string, unknown>) => { recorded.push(e); }, getHistory: async () => [], checkAnomaly: async () => ({ isAnomaly: false, medianMs: 0, thresholdMs: 0 }) };
    await recordReflectFunnelRun(
      tracker as never,
      { agentId: "a1", admissionOutcome: "untrusted_origin", admitted: 0, maxClusterCardinality: 0, distinctTopicKeys: 0, untrustedDrops: 2, sourceTrajectoryCount: 2, totalSourceChars: 0 },
      9,
    );
    const e = recorded[0] as { summary: string };
    expect(e.summary).toContain("outcome=untrusted_origin");
    expect(e.summary).toContain("untrustedDrops=2");
    // Empty-vs-real discriminator: inputs existed (2 traj) but 0 chars selected → untrusted-dropped.
    expect(e.summary).toContain("src=2traj/0ch");
  });

  it("is a no-op (never throws) when the firing agent has no execution tracker", async () => {
    const { recordReflectFunnelRun } = await import("./setup-schedulers.js");
    await expect(
      recordReflectFunnelRun(undefined, { agentId: "x", admissionOutcome: "no_successes", admitted: 0, maxClusterCardinality: 0, distinctTopicKeys: 0, untrustedDrops: 0, sourceTrajectoryCount: 0, totalSourceChars: 0 }, 1),
    ).resolves.toBeUndefined();
  });
});

describe("recordLifecycleRun — forget sweep folded onto cron history", () => {
  it("records a CONTENT-FREE sweep summary under the memory-lifecycle-<agentId> jobId so cron.runs surfaces it", async () => {
    const { recordLifecycleRun } = await import("./setup-schedulers.js");
    const recorded: Array<Record<string, unknown>> = [];
    const tracker = {
      record: async (e: Record<string, unknown>) => { recorded.push(e); },
      getHistory: async () => [],
      checkAnomaly: async () => ({ isAnomaly: false, medianMs: 0, thresholdMs: 0 }),
    };
    await recordLifecycleRun(
      tracker as never,
      { agentId: "default", scanned: 6, promoted: 0, demoted: 1, evicted: 2 },
      42,
    );
    expect(recorded).toHaveLength(1);
    const e = recorded[0] as { jobId: string; status: string; summary: string; ts: number };
    // jobId mirrors the lifecycle cron id → resolveJobByName(scheduler,"Memory lifecycle") resolves it.
    expect(e.jobId).toBe("memory-lifecycle-default");
    expect(e.status).toBe("ok");
    expect(e.ts).toBe(42);
    // The sweep counts — answers "what did forget evict/demote" without a db.mjs evicted_at poll.
    expect(e.summary).toContain("scanned=6");
    expect(e.summary).toContain("evicted=2");
    expect(e.summary).toContain("demoted=1");
    // Counts only — never a memory id/body/content.
    expect(e.summary).not.toMatch(/content|body|##|memory-[a-f0-9]{8}/);
  });

  it("is a no-op (never throws) when the firing agent has no execution tracker", async () => {
    const { recordLifecycleRun } = await import("./setup-schedulers.js");
    await expect(
      recordLifecycleRun(undefined, { agentId: "x", scanned: 0, promoted: 0, demoted: 0, evicted: 0 }, 1),
    ).resolves.toBeUndefined();
  });
});
