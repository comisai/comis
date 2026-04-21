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
const mockCreateTaskExtractor = vi.hoisted(() => vi.fn(() => ({
  extract: vi.fn(async () => []),
})));
const mockCreateTaskStore = vi.hoisted(() => vi.fn(() => ({
  load: vi.fn(),
  save: vi.fn(),
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
  createTaskExtractor: mockCreateTaskExtractor,
  createTaskStore: mockCreateTaskStore,
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
    expect(result.summary).toBe("No delivery target");
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
});

// ===========================================================================
// Task Extraction tests
// ===========================================================================

function createTaskContainer(tasksEnabled: boolean, agents: Record<string, any> = {}) {
  return {
    config: {
      scheduler: {
        tasks: {
          enabled: tasksEnabled,
          confidenceThreshold: 0.7,
        },
      },
      agents,
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

describe("setupTaskExtraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupTaskExtraction() {
    const mod = await import("./setup-schedulers.js");
    return mod.setupTaskExtraction;
  }

  // -------------------------------------------------------------------------
  // 1. Returns empty map and no-op when disabled
  // -------------------------------------------------------------------------

  it("returns empty taskExtractors map and no-op extractFromConversation when disabled", async () => {
    const setupTaskExtraction = await getSetupTaskExtraction();
    const result = setupTaskExtraction({
      container: createTaskContainer(false),
      workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
      schedulerLogger: createMockLogger() as any,
    });

    expect(result.taskExtractors.size).toBe(0);
    expect(typeof result.extractFromConversation).toBe("function");

    // No-op: should complete without error
    await expect(result.extractFromConversation("text", "session", "agent-1")).resolves.toBeUndefined();
    expect(mockCreateTaskExtractor).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Creates per-agent task extractors when enabled
  // -------------------------------------------------------------------------

  it("creates per-agent task extractors when enabled, one per agent with workspace", async () => {
    const agents = {
      "agent-1": { name: "Agent 1" },
      "agent-2": { name: "Agent 2" },
    };
    const setupTaskExtraction = await getSetupTaskExtraction();
    const result = setupTaskExtraction({
      container: createTaskContainer(true, agents),
      workspaceDirs: new Map([
        ["agent-1", "/workspace/agent-1"],
        ["agent-2", "/workspace/agent-2"],
      ]),
      schedulerLogger: createMockLogger() as any,
    });

    expect(result.taskExtractors.size).toBe(2);
    expect(result.taskExtractors.has("agent-1")).toBe(true);
    expect(result.taskExtractors.has("agent-2")).toBe(true);
    expect(mockCreateTaskExtractor).toHaveBeenCalledTimes(2);
    expect(mockCreateTaskStore).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 3. Skips agents without workspace directory
  // -------------------------------------------------------------------------

  it("skips agents without workspace directory", async () => {
    const agents = {
      "agent-1": { name: "Agent 1" },
      "agent-2": { name: "Agent 2" },
    };
    const setupTaskExtraction = await getSetupTaskExtraction();
    const result = setupTaskExtraction({
      container: createTaskContainer(true, agents),
      workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
      schedulerLogger: createMockLogger() as any,
    });

    expect(result.taskExtractors.size).toBe(1);
    expect(result.taskExtractors.has("agent-1")).toBe(true);
    expect(result.taskExtractors.has("agent-2")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. extractFromConversation calls extractor.extract and logs on success
  // -------------------------------------------------------------------------

  it("extractFromConversation calls extractor.extract and logs on success", async () => {
    const mockExtractor = {
      extract: vi.fn(async () => [{ id: "task-1", text: "Do something" }]),
    };
    mockCreateTaskExtractor.mockReturnValue(mockExtractor);

    const agents = { "agent-1": { name: "Agent 1" } };
    const schedulerLogger = createMockLogger();
    const setupTaskExtraction = await getSetupTaskExtraction();
    const result = setupTaskExtraction({
      container: createTaskContainer(true, agents),
      workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
      schedulerLogger: schedulerLogger as any,
    });

    await result.extractFromConversation("conversation text", "session-key", "agent-1");

    expect(mockExtractor.extract).toHaveBeenCalledWith("conversation text", "session-key");
    expect(schedulerLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        taskCount: 1,
        sessionKey: "session-key",
      }),
      "Tasks extracted from conversation",
    );
  });

  // -------------------------------------------------------------------------
  // 5. extractFromConversation is no-op for unknown agentId
  // -------------------------------------------------------------------------

  it("extractFromConversation is no-op for unknown agentId", async () => {
    const agents = { "agent-1": { name: "Agent 1" } };
    const setupTaskExtraction = await getSetupTaskExtraction();
    const result = setupTaskExtraction({
      container: createTaskContainer(true, agents),
      workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
      schedulerLogger: createMockLogger() as any,
    });

    // Should complete without error for unknown agent
    await expect(
      result.extractFromConversation("text", "session", "unknown-agent"),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. extractFromConversation catches errors and logs warn
  // -------------------------------------------------------------------------

  it("extractFromConversation catches errors and logs warn (does not throw)", async () => {
    const mockExtractor = {
      extract: vi.fn(async () => { throw new Error("LLM timeout"); }),
    };
    mockCreateTaskExtractor.mockReturnValue(mockExtractor);

    const agents = { "agent-1": { name: "Agent 1" } };
    const schedulerLogger = createMockLogger();
    const setupTaskExtraction = await getSetupTaskExtraction();
    const result = setupTaskExtraction({
      container: createTaskContainer(true, agents),
      workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
      schedulerLogger: schedulerLogger as any,
    });

    // Should not throw
    await expect(
      result.extractFromConversation("text", "session", "agent-1"),
    ).resolves.toBeUndefined();

    expect(schedulerLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        err: "LLM timeout",
        hint: "Task extraction failed but does not block message processing",
        errorKind: "internal",
      }),
      "Task extraction error",
    );
  });

  // -------------------------------------------------------------------------
  // 7. Passes correct config to createTaskExtractor
  // -------------------------------------------------------------------------

  it("passes correct config including confidenceThreshold to createTaskExtractor", async () => {
    const agents = { "agent-1": { name: "Agent 1" } };
    const schedulerLogger = createMockLogger();
    const setupTaskExtraction = await getSetupTaskExtraction();
    const container = createTaskContainer(true, agents);
    container.config.scheduler.tasks.confidenceThreshold = 0.85;

    setupTaskExtraction({
      container,
      workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
      schedulerLogger: schedulerLogger as any,
    });

    expect(mockCreateTaskExtractor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          enabled: true,
          confidenceThreshold: 0.85,
        },
        eventBus: container.eventBus,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 8. Logs extractor count when extractors created
  // -------------------------------------------------------------------------

  it("logs extractor count when task extractors created", async () => {
    const agents = {
      "agent-1": { name: "Agent 1" },
      "agent-2": { name: "Agent 2" },
    };
    const schedulerLogger = createMockLogger();
    const setupTaskExtraction = await getSetupTaskExtraction();

    setupTaskExtraction({
      container: createTaskContainer(true, agents),
      workspaceDirs: new Map([
        ["agent-1", "/workspace/agent-1"],
        ["agent-2", "/workspace/agent-2"],
      ]),
      schedulerLogger: schedulerLogger as any,
    });

    expect(schedulerLogger.info).toHaveBeenCalledWith(
      { extractorCount: 2 },
      "Task extraction enabled for agents",
    );
  });
});
