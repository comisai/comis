// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SystemEventEntry } from "../system-events/system-event-types.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";
import {
  isQueueBusy,
  resolveHeartbeatSessionKey,
  createAgentHeartbeatSource,
} from "./agent-heartbeat-source.js";
import type { AgentHeartbeatSourceDeps, HeartbeatSessionOps } from "./agent-heartbeat-source.js";

// ---------------------------------------------------------------------------
// Helper: create mock deps
// ---------------------------------------------------------------------------

function mockConfig(overrides?: Partial<EffectiveHeartbeatConfig>): EffectiveHeartbeatConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    showOk: true,
    showAlerts: true,
    ...overrides,
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockDeps(overrides?: Partial<AgentHeartbeatSourceDeps>): AgentHeartbeatSourceDeps {
  const logger = mockLogger();
  return {
    getExecutor: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        response: "All systems operational.",
        sessionKey: { tenantId: "default", userId: "heartbeat", channelId: "heartbeat-agent1" },
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.001 },
        stepsExecuted: 1,
        llmCalls: 1,
        finishReason: "stop",
      }),
    }),
    assembleToolsForAgent: vi.fn().mockResolvedValue([]),
    getEffectiveConfig: vi.fn().mockReturnValue(mockConfig()),
    getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
    checkFileGate: vi.fn().mockResolvedValue(false), // Not empty -> proceed
    systemEventQueue: {
      enqueue: vi.fn(),
      peek: vi.fn().mockReturnValue([]),
      drain: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
      clearAll: vi.fn(),
      size: vi.fn().mockReturnValue(0),
    },
    deliveryBridge: {
      adaptersByType: new Map(),
      duplicateDetector: { isDuplicate: vi.fn().mockReturnValue(false), reset: vi.fn() },
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any,
      logger,
    },
    logger,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isQueueBusy
// ---------------------------------------------------------------------------

describe("isQueueBusy", () => {
  it("returns false when activeRunRegistry is undefined", () => {
    expect(isQueueBusy(undefined, "some-key")).toBe(false);
  });

  it("returns false when session has no active run", () => {
    const registry = { has: vi.fn().mockReturnValue(false) };
    expect(isQueueBusy(registry as any, "some-key")).toBe(false);
    expect(registry.has).toHaveBeenCalledWith("some-key");
  });

  it("returns true when session has an active run", () => {
    const registry = { has: vi.fn().mockReturnValue(true) };
    expect(isQueueBusy(registry as any, "some-key")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveHeartbeatSessionKey
// ---------------------------------------------------------------------------

describe("resolveHeartbeatSessionKey", () => {
  it("returns session key from config target + session", () => {
    const config = mockConfig({
      target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
      session: "custom-session",
    });
    const result = resolveHeartbeatSessionKey("agent1", config, "my-tenant");
    expect(result).toEqual({
      tenantId: "my-tenant",
      userId: "custom-session",
      channelId: "chat-123",
    });
  });

  it("returns fallback session key when no target", () => {
    const config = mockConfig();
    const result = resolveHeartbeatSessionKey("agent1", config, "default");
    expect(result).toEqual({
      tenantId: "default",
      userId: "heartbeat",
      channelId: "heartbeat-agent1",
    });
  });

  it("returns session key with default userId when target exists but no session", () => {
    const config = mockConfig({
      target: { channelType: "discord", channelId: "ch-2", chatId: "chat-456" },
    });
    const result = resolveHeartbeatSessionKey("agent1", config, "default");
    expect(result).toEqual({
      tenantId: "default",
      userId: "heartbeat",
      channelId: "chat-456",
    });
  });
});

// ---------------------------------------------------------------------------
// createAgentHeartbeatSource -- onTick
// ---------------------------------------------------------------------------

describe("createAgentHeartbeatSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: calls executor.execute with synthetic heartbeat message", async () => {
    const deps = createMockDeps();
    const source = createAgentHeartbeatSource(deps);

    await source.onTick("agent1");

    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(executor.execute).toHaveBeenCalledOnce();

    const [msg, sessionKey, tools, agentId, overrides] = executor.execute.mock.calls[0]!;

    // NormalizedMessage shape
    expect(msg.id).toMatch(/^heartbeat-/);
    expect(msg.senderId).toBe("system");
    expect(msg.metadata.trigger).toBe("heartbeat");
    expect(msg.metadata.isScheduled).toBe(true);

    // Tools from assembleToolsForAgent are passed
    expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("agent1");

    // 5-param signature: agentId at position 3, overrides at position 4
    expect(agentId).toBe("agent1");
    expect(overrides).toEqual({
      model: "claude-sonnet",
      operationType: "heartbeat",
    });
  });

  it("skips execution when queue is busy", async () => {
    const registry = {
      has: vi.fn().mockReturnValue(true),
      register: vi.fn(),
      deregister: vi.fn(),
      get: vi.fn(),
      size: 1,
    };
    const mockExecute = vi.fn();
    const deps = createMockDeps({
      activeRunRegistry: registry as any,
      getExecutor: vi.fn().mockReturnValue({ execute: mockExecute }),
    });
    const source = createAgentHeartbeatSource(deps);

    await source.onTick("agent1");

    // getExecutor should not have been called (early return before executor needed)
    expect(mockExecute).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalled();
  });

  it("skips execution for interval trigger with empty HEARTBEAT.md", async () => {
    const mockExecute = vi.fn();
    const deps = createMockDeps({
      checkFileGate: vi.fn().mockResolvedValue(true), // effectively empty
      getExecutor: vi.fn().mockReturnValue({ execute: mockExecute }),
    });
    // No system events -> interval trigger
    const source = createAgentHeartbeatSource(deps);

    await source.onTick("agent1");

    expect(mockExecute).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalled();
  });

  it("bypasses file gate for event-driven triggers", async () => {
    const execEvents: SystemEventEntry[] = [
      { text: "git pull done", contextKey: "exec:cmd-1", enqueuedAt: 1000 },
    ];
    const deps = createMockDeps({
      checkFileGate: vi.fn().mockResolvedValue(true), // File is empty
    });
    // Mock peek to return exec events (so trigger = exec-event)
    (deps.systemEventQueue.peek as ReturnType<typeof vi.fn>).mockReturnValue(execEvents);
    (deps.systemEventQueue.drain as ReturnType<typeof vi.fn>).mockReturnValue(execEvents);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    // Should execute despite empty file because exec-event bypasses gate
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it("catches execution errors without throwing", async () => {
    const deps = createMockDeps();
    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>)();
    executor.execute.mockRejectedValue(new Error("LLM timeout"));
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);

    // Should NOT throw
    await expect(source.onTick("agent1")).resolves.toBeUndefined();

    // Should log WARN
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        agentId: "agent1",
        hint: expect.any(String),
        errorKind: "internal",
      }),
      expect.stringContaining("Heartbeat execution failed"),
    );
  });

  it("delivers response via delivery bridge after execution", async () => {
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123", isDm: true },
        allowDm: true,
      })),
    });

    // We need to spy on deliverHeartbeatNotification -- but since it's imported,
    // we'll verify the delivery bridge deps are used correctly by checking the
    // adapter lookup happens. For a pure unit test, we verify the notification shape.
    // Let's add a mock adapter so delivery actually proceeds.
    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    // Verify adapter.sendMessage was called (delivery went through)
    // Allow delivery to complete (fire-and-forget with microtask)
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAdapter.sendMessage).toHaveBeenCalledWith(
      "chat-123",
      "All systems operational.",
    );
  });

  it("does not attempt delivery when no target configured", async () => {
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig()), // no target
    });

    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    await vi.advanceTimersByTimeAsync(0);
    expect(mockAdapter.sendMessage).not.toHaveBeenCalled();
  });

  it("drains system events after successful execution", async () => {
    const deps = createMockDeps();
    const source = createAgentHeartbeatSource(deps);

    await source.onTick("agent1");

    expect(deps.systemEventQueue.drain).toHaveBeenCalled();
  });

  it("does not throw when delivery fails", async () => {
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
      })),
    });

    // No adapter for telegram -> delivery will be skipped (no-adapter gate)
    // but should not throw
    const source = createAgentHeartbeatSource(deps);
    await expect(source.onTick("agent1")).resolves.toBeUndefined();
  });

  it("logs heartbeat run at INFO level", async () => {
    const deps = createMockDeps();
    const source = createAgentHeartbeatSource(deps);

    await source.onTick("agent1");

    // Should have an INFO log for heartbeat start
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent1" }),
      expect.stringContaining("Heartbeat"),
    );
  });

  // -----------------------------------------------------------------------
  // Response processing integration (RPROC wiring in onTick)
  // -----------------------------------------------------------------------

  it("suppresses delivery when executor returns HEARTBEAT_OK", async () => {
    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
      })),
    });
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    // Mock executor to return HEARTBEAT_OK
    const executor = { execute: vi.fn().mockResolvedValue({ response: "HEARTBEAT_OK" }) };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");
    await vi.advanceTimersByTimeAsync(0);

    // Delivery should NOT happen
    expect(mockAdapter.sendMessage).not.toHaveBeenCalled();

    // Should log DEBUG for classification
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent1", reason: "token" }),
      expect.stringContaining("suppressing delivery"),
    );
  });

  it("delivers response when executor returns non-OK text", async () => {
    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
      })),
    });
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    const executor = { execute: vi.fn().mockResolvedValue({ response: "Alert: CPU at 95%" }) };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAdapter.sendMessage).toHaveBeenCalledWith("chat-123", "Alert: CPU at 95%");
  });

  it("treats empty executor response as HEARTBEAT_OK", async () => {
    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
      })),
    });
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    const executor = { execute: vi.fn().mockResolvedValue({ response: "" }) };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");
    await vi.advanceTimersByTimeAsync(0);

    // Empty response treated as OK -- no delivery
    expect(mockAdapter.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers when response has MEDIA: prefix line", async () => {
    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
      })),
    });
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    // MEDIA: prefix line + HEARTBEAT_OK: media bypass should force delivery
    const executor = {
      execute: vi.fn().mockResolvedValue({ response: "MEDIA:image/png:base64data\nHEARTBEAT_OK" }),
    };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");
    await vi.advanceTimersByTimeAsync(0);

    // Should deliver because media bypass overrides token detection
    expect(mockAdapter.sendMessage).toHaveBeenCalled();
  });

  it("strips response prefix before delivery", async () => {
    const mockAdapter = {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, value: "msg-id" }),
      getStatus: vi.fn().mockReturnValue({ connected: true }),
    };
    const deps = createMockDeps({
      getEffectiveConfig: vi.fn().mockReturnValue(mockConfig({
        target: { channelType: "telegram", channelId: "ch-1", chatId: "chat-123" },
        responsePrefix: "Agent: ",
      })),
    });
    deps.deliveryBridge.adaptersByType = new Map([["telegram", mockAdapter as any]]);

    const executor = {
      execute: vi.fn().mockResolvedValue({ response: "Agent: Alert: CPU high" }),
    };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");
    await vi.advanceTimersByTimeAsync(0);

    // Delivered text should have prefix stripped
    expect(mockAdapter.sendMessage).toHaveBeenCalledWith("chat-123", "Alert: CPU high");
  });

  it("calls sessionOps.pruneLastTurn on HEARTBEAT_OK", async () => {
    const sessionOps: HeartbeatSessionOps = {
      pruneLastTurn: vi.fn().mockResolvedValue(undefined),
      preserveUpdatedAt: vi.fn().mockResolvedValue(undefined),
      storeLastHeartbeat: vi.fn(),
      getLastHeartbeat: vi.fn().mockReturnValue(undefined),
    };
    const deps = createMockDeps({ sessionOps });

    const executor = { execute: vi.fn().mockResolvedValue({ response: "HEARTBEAT_OK" }) };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    expect(sessionOps.pruneLastTurn).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat"),
    );
  });

  it("calls sessionOps.storeLastHeartbeat on HEARTBEAT_OK outcome", async () => {
    const sessionOps: HeartbeatSessionOps = {
      pruneLastTurn: vi.fn().mockResolvedValue(undefined),
      preserveUpdatedAt: vi.fn().mockResolvedValue(undefined),
      storeLastHeartbeat: vi.fn(),
      getLastHeartbeat: vi.fn().mockReturnValue(undefined),
    };
    const deps = createMockDeps({ sessionOps });

    const executor = { execute: vi.fn().mockResolvedValue({ response: "HEARTBEAT_OK" }) };
    (deps.getExecutor as ReturnType<typeof vi.fn>).mockReturnValue(executor);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    expect(sessionOps.storeLastHeartbeat).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat"),
      "",  // cleanedText after token removal is empty
      expect.any(Number),
    );
  });

  it("calls sessionOps.storeLastHeartbeat on deliver outcome", async () => {
    const sessionOps: HeartbeatSessionOps = {
      pruneLastTurn: vi.fn().mockResolvedValue(undefined),
      preserveUpdatedAt: vi.fn().mockResolvedValue(undefined),
      storeLastHeartbeat: vi.fn(),
      getLastHeartbeat: vi.fn().mockReturnValue(undefined),
    };
    const deps = createMockDeps({ sessionOps });

    // Default executor returns "All systems operational." which classifies as "deliver"
    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    expect(sessionOps.storeLastHeartbeat).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat"),
      "All systems operational.",
      expect.any(Number),
    );
    // pruneLastTurn should NOT be called for deliver outcomes
    expect(sessionOps.pruneLastTurn).not.toHaveBeenCalled();
  });

  it("bypasses file gate for cron trigger when file is empty", async () => {
    const cronEvents: SystemEventEntry[] = [
      { text: "Cron job completed", contextKey: "cron:job-1:summary", enqueuedAt: 1000 },
    ];
    const deps = createMockDeps({
      checkFileGate: vi.fn().mockResolvedValue(true), // File is empty
    });
    // Mock peek/drain to return cron events (trigger resolves to "cron")
    (deps.systemEventQueue.peek as ReturnType<typeof vi.fn>).mockReturnValue(cronEvents);
    (deps.systemEventQueue.drain as ReturnType<typeof vi.fn>).mockReturnValue(cronEvents);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    // Should execute despite empty file because cron bypasses file gate
    expect(executor.execute).toHaveBeenCalledOnce();
    // Verify checkFileGate was NOT called (cron trigger bypasses before checking)
    expect(deps.checkFileGate).not.toHaveBeenCalled();
  });

  it("includes cron events in heartbeat prompt via full onTick pipeline", async () => {
    const cronEvents: SystemEventEntry[] = [
      { text: "Daily backup completed successfully", contextKey: "cron:backup-daily:summary", enqueuedAt: 1000 },
    ];
    const deps = createMockDeps();
    (deps.systemEventQueue.peek as ReturnType<typeof vi.fn>).mockReturnValue(cronEvents);
    (deps.systemEventQueue.drain as ReturnType<typeof vi.fn>).mockReturnValue(cronEvents);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(executor.execute).toHaveBeenCalledOnce();

    // Verify the NormalizedMessage text includes the cron event text
    const [msg] = executor.execute.mock.calls[0]!;
    expect(msg.text).toContain("Daily backup completed successfully");
    expect(msg.text).toContain("scheduled reminder");
    expect(msg.metadata.triggerKind).toBe("cron");
  });

  it("resolves trigger kind from cron contextKey prefix in system events", async () => {
    const cronEvents: SystemEventEntry[] = [
      { text: "Report generated", contextKey: "cron:weekly-report:summary", enqueuedAt: 1000 },
    ];
    const deps = createMockDeps();
    (deps.systemEventQueue.peek as ReturnType<typeof vi.fn>).mockReturnValue(cronEvents);
    (deps.systemEventQueue.drain as ReturnType<typeof vi.fn>).mockReturnValue(cronEvents);

    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    // Verify INFO log shows trigger = "cron"
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent1", trigger: "cron" }),
      expect.stringContaining("Heartbeat run starting"),
    );
  });

  // -----------------------------------------------------------------------
  // Operation model resolution + overrides threading
  // -----------------------------------------------------------------------

  it("passes overrides with resolved model and operationType to executor", async () => {
    const deps = createMockDeps();
    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(executor.execute).toHaveBeenCalledOnce();

    const callArgs = executor.execute.mock.calls[0]!;
    // 5th positional arg is overrides (index 4)
    const overrides = callArgs[4];
    expect(overrides).toEqual({
      model: "claude-sonnet",
      operationType: "heartbeat",
    });
  });

  it("resolves model from agentConfig.model", async () => {
    const deps = createMockDeps({
      getAgentConfig: vi.fn().mockReturnValue({ model: "google:gemini-2.5-flash", tenantId: "default" }),
    });
    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");

    const executor = (deps.getExecutor as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const callArgs = executor.execute.mock.calls[0]!;
    const overrides = callArgs[4];
    expect(overrides.model).toBe("google:gemini-2.5-flash");
  });

  it("logs resolved model in heartbeat run starting", async () => {
    const deps = createMockDeps({
      getAgentConfig: vi.fn().mockReturnValue({ model: "google:gemini-2.5-flash", tenantId: "default" }),
    });
    const source = createAgentHeartbeatSource(deps);
    await source.onTick("agent1");
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ model: "google:gemini-2.5-flash" }),
      "Heartbeat run starting",
    );
  });
});
