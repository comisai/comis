// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SUB_AGENT_TOOL_DENYLIST, MIN_SUB_AGENT_STEPS, resolveGraphCacheRetention } from "./setup-cross-session.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCreateCrossSessionSender = vi.hoisted(() => vi.fn(() => ({
  send: vi.fn(),
  ping: vi.fn(),
})));
const mockCreateSubAgentRunner = vi.hoisted(() => vi.fn(() => ({
  spawn: vi.fn(),
  shutdown: vi.fn(async () => {}),
})));
const mockRandomUUID = vi.hoisted(() => vi.fn(() => "test-uuid-1234"));
const mockDeliverToChannel = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  value: {
    ok: true,
    totalChunks: 1,
    deliveredChunks: 1,
    failedChunks: 0,
    chunks: [{ ok: true, messageId: "mock-msg-id", charCount: 10, retried: false }],
    totalChars: 10,
  },
})));
const mockTypingControllerInstance = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  refreshTtl: vi.fn(),
  isActive: true,
  startedAt: 0,
  isSealed: false,
}));
const mockCreateTypingController = vi.hoisted(() => vi.fn(() => ({
  ...mockTypingControllerInstance,
})));

const mockStepCounterInstance = vi.hoisted(() => ({
  increment: vi.fn().mockReturnValue(1),
  shouldHalt: vi.fn().mockReturnValue(false),
  reset: vi.fn(),
  getCount: vi.fn().mockReturnValue(0),
}));
const mockCreateStepCounter = vi.hoisted(() => vi.fn(() => ({ ...mockStepCounterInstance })));

vi.mock("../cross-session-sender.js", () => ({
  createCrossSessionSender: mockCreateCrossSessionSender,
}));

vi.mock("../sub-agent-runner.js", () => ({
  createSubAgentRunner: mockCreateSubAgentRunner,
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("@comis/channels", () => ({
  deliverToChannel: mockDeliverToChannel,
  createTypingController: mockCreateTypingController,
}));

const mockCreateResultCondenser = vi.hoisted(() => vi.fn(() => ({
  condense: vi.fn(async () => ({
    level: 1 as const,
    result: { taskComplete: true, summary: "test", conclusions: ["done"] },
    originalTokens: 100,
    condensedTokens: 100,
    compressionRatio: 1,
    diskPath: "/tmp/test.json",
  })),
})));

const mockCreateNarrativeCaster = vi.hoisted(() => vi.fn(() => ({
  cast: vi.fn((params: { task: string }) => `[Subagent Result: ${params.task}] mocked`),
})));

const mockCreateLifecycleHooks = vi.hoisted(() => vi.fn(() => ({
  prepareSpawn: vi.fn(async () => ({ rollback: vi.fn(async () => {}) })),
  onEnded: vi.fn(async () => {}),
})));

const mockResolveWorkspaceDir = vi.hoisted(() => vi.fn((_config: any, agentId: string) => `/mock/workspace/${agentId}`));

const mockCreateEphemeralComisSessionManager = vi.hoisted(() => vi.fn((_cwd: string) => ({
  withSession: vi.fn(),
  destroySession: vi.fn(),
  getSessionStats: vi.fn(),
  writeSessionMetadata: vi.fn(),
})));

const mockCreateComisSessionManager = vi.hoisted(() => vi.fn((_deps: any) => ({
  withSession: vi.fn(),
  destroySession: vi.fn(),
  getSessionStats: vi.fn(),
  writeSessionMetadata: vi.fn(),
})));

// Mock resolveOperationModel and resolveProviderFamily for sub-agent model resolution
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  model: "anthropic:claude-sonnet-4-5-20250929",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5-20250929",
  source: "family_default" as const,
  operationType: "subagent" as const,
  timeoutMs: 120_000,
  cacheRetention: "short" as const,
})));
const mockResolveProviderFamily = vi.hoisted(() => vi.fn(() => "anthropic"));

vi.mock("@comis/agent", () => ({
  createStepCounter: mockCreateStepCounter,
  createResultCondenser: mockCreateResultCondenser,
  createNarrativeCaster: mockCreateNarrativeCaster,
  createLifecycleHooks: mockCreateLifecycleHooks,
  resolveWorkspaceDir: mockResolveWorkspaceDir,
  createEphemeralComisSessionManager: mockCreateEphemeralComisSessionManager,
  createComisSessionManager: mockCreateComisSessionManager,
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: mockResolveProviderFamily,
}));

// ---------------------------------------------------------------------------
// Helpers
/** Minimal event bus that supports on/emit for proxy typing tests. */
function createFunctionalEventBus() {
  const listeners = new Map<string, Set<(evt: any) => void>>();
  return {
    on: vi.fn((event: string, handler: (evt: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn() };
    }),
    emit: vi.fn((event: string, payload: any) => {
      const handlers = listeners.get(event);
      if (handlers) {
        for (const h of handlers) h(payload);
      }
    }),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

function createMinimalDeps(overrides: Record<string, any> = {}) {
  return {
    sessionStore: {
      loadByFormattedKey: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    },
    container: {
      config: {
        agents: {
          "default": { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
          "agent-1": { name: "Agent 1", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
          "agent-2": { name: "Agent 2", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
        },
        security: {
          agentToAgent: {
            enabled: true,
            allowList: ["agent-1", "agent-2"],
            subAgentMaxSteps: 50,
            subAgentToolGroups: ["coding"],
            subAgentMcpTools: "inherit",
          },
        },
        tenantId: "test-tenant",
      },
      eventBus: { on: vi.fn(), emit: vi.fn() },
    },
    assembleToolsForAgent: vi.fn(async () => [{ name: "tool-1" }]),
    getExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({
        response: "Agent response",
        tokensUsed: { total: 100 },
        cost: { total: 0.01 },
        finishReason: "stop",
      })),
    })),
    adaptersByType: new Map([
      ["telegram", { channelType: "telegram", sendMessage: vi.fn(async () => ({ ok: true, value: "mock-msg-id" })), platformAction: vi.fn(async () => ({ ok: true, value: undefined })) }],
    ]),
    logger: createMockLogger() as any,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupCrossSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupCrossSession() {
    const mod = await import("./setup-cross-session.js");
    return mod.setupCrossSession;
  }

  // -------------------------------------------------------------------------
  // 1. Returns crossSessionSender and subAgentRunner
  // -------------------------------------------------------------------------

  it("returns crossSessionSender and subAgentRunner", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const result = setupCrossSession(createMinimalDeps());

    expect(result.crossSessionSender).toBeDefined();
    expect(result.subAgentRunner).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 2. executeInSession builds NormalizedMessage and calls executor
  // -------------------------------------------------------------------------

  it("builds executeInSession that constructs NormalizedMessage and calls getExecutor().execute", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    // Extract the executeInSession callback passed to createCrossSessionSender
    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const executeInSession = senderArgs.executeInSession;

    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    const result = await executeInSession("agent-1", sessionKey, "Hello agent");

    expect(deps.getExecutor).toHaveBeenCalledWith("agent-1");
    expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("agent-1");
    expect(result).toEqual({
      response: "Agent response",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
    });
  });

  // -------------------------------------------------------------------------
  // 3. sendToChannel looks up adapter and sends message
  // -------------------------------------------------------------------------

  it("builds sendToChannel that delegates to deliverToChannel", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const sendToChannel = senderArgs.sendToChannel;

    const result = await sendToChannel("telegram", "chat-123", "Hello channel");

    const adapter = deps.adaptersByType.get("telegram");
    expect(mockDeliverToChannel).toHaveBeenCalledWith(
      adapter, "chat-123", "Hello channel", undefined,
      undefined,
    );
    expect(result).toBe(true);
  });

  it("sendToChannel returns false for unknown channel type", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const sendToChannel = senderArgs.sendToChannel;

    const result = await sendToChannel("unknown", "chat-123", "Hello");
    expect(result).toBe(false);
  });

  it("sendToChannel passes options to deliverToChannel for thread context", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const sendToChannel = senderArgs.sendToChannel;

    const result = await sendToChannel("telegram", "chat-123", "# Hello", { threadId: "thread-42" });

    const adapter = deps.adaptersByType.get("telegram");
    expect(mockDeliverToChannel).toHaveBeenCalledWith(
      adapter, "chat-123", "# Hello", { threadId: "thread-42" },
      undefined,
    );
    expect(result).toBe(true);
  });

  it("sendToChannel bypasses deliverToChannel for gateway", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const gatewaySendRef = vi.fn(() => true);
    const deps = createMinimalDeps({
      gatewaySend: { ref: gatewaySendRef },
    });
    setupCrossSession(deps);

    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const sendToChannel = senderArgs.sendToChannel;

    mockDeliverToChannel.mockClear();
    const result = await sendToChannel("gateway", "ws-123", "# Raw markdown");

    expect(mockDeliverToChannel).not.toHaveBeenCalled();
    expect(gatewaySendRef).toHaveBeenCalledWith("ws-123", "# Raw markdown");
    expect(result).toBe(true);
  });

  it("sendToChannel returns false when deliverToChannel returns error Result", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const sendToChannel = senderArgs.sendToChannel;

    mockDeliverToChannel.mockResolvedValueOnce({ ok: false, error: new Error("delivery failed") });
    const result = await sendToChannel("telegram", "chat-123", "Hello");
    expect(result).toBe(false);
  });

  it("sendToChannel returns false when deliverToChannel reports failed chunks", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    const senderArgs = mockCreateCrossSessionSender.mock.calls[0][0];
    const sendToChannel = senderArgs.sendToChannel;

    mockDeliverToChannel.mockResolvedValueOnce({
      ok: true,
      value: { ok: false, totalChunks: 1, deliveredChunks: 0, failedChunks: 1, chunks: [], totalChars: 10 },
    });
    const result = await sendToChannel("telegram", "chat-123", "Hello");
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. executeSubAgent calls assembleToolsForAgent with tool groups from config
  // -------------------------------------------------------------------------

  it("builds executeSubAgent that calls assembleToolsForAgent with tool groups from config", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    // executeSubAgent is passed to createSubAgentRunner
    const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
    const executeAgent = runnerArgs.executeAgent;

    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    await executeAgent("agent-2", sessionKey, "Execute this task");

    expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("agent-2", {
      includePlatformTools: true,
      toolGroups: ["coding"],
      includeMcpTools: true,
    });
  });

  // -------------------------------------------------------------------------
  // 5. Passes correct config to createCrossSessionSender
  // -------------------------------------------------------------------------

  it("passes security.agentToAgent config to createCrossSessionSender", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    expect(mockCreateCrossSessionSender).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ enabled: true, allowList: ["agent-1", "agent-2"] }),
        eventBus: deps.container.eventBus,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 6. Passes correct config to createSubAgentRunner including tenantId
  // -------------------------------------------------------------------------

  it("passes correct config to createSubAgentRunner including tenantId", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    expect(mockCreateSubAgentRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ enabled: true, allowList: ["agent-1", "agent-2"] }),
        tenantId: "test-tenant",
        eventBus: deps.container.eventBus,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 7. announceToParent delivers to channel when response is non-empty
  // -------------------------------------------------------------------------

  it("announceToParent delivers to channel when response is non-empty and not NO_REPLY", async () => {
    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps();
    setupCrossSession(deps);

    // announceToParent is passed to createSubAgentRunner
    const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
    const announceToParent = runnerArgs.announceToParent;

    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    await announceToParent("agent-1", sessionKey, "Sub-agent done", "telegram", "chat-123");

    // Should have called deliverToChannel (via sendToChannel delegation) with the response
    const adapter = deps.adaptersByType.get("telegram");
    expect(mockDeliverToChannel).toHaveBeenCalledWith(
      adapter, "chat-123", "Agent response", undefined,
      undefined,
    );

    // Verify proxy typing events emitted around announcement
    const emitCalls = deps.container.eventBus.emit.mock.calls;
    const proxyStartCall = emitCalls.find((c: any[]) => c[0] === "typing:proxy_start");
    const proxyStopCall = emitCalls.find((c: any[]) => c[0] === "typing:proxy_stop");

    expect(proxyStartCall).toBeDefined();
    expect(proxyStartCall![1]).toMatchObject({
      channelType: "telegram",
      channelId: "chat-123",
      agentId: "agent-1",
    });
    expect(proxyStartCall![1].runId).toMatch(/^announce-/);

    expect(proxyStopCall).toBeDefined();
    expect(proxyStopCall![1]).toMatchObject({
      channelType: "telegram",
      channelId: "chat-123",
      reason: "completed",
    });
    // proxy_start and proxy_stop share the same runId
    expect(proxyStopCall![1].runId).toBe(proxyStartCall![1].runId);

    // proxy_start emitted before executeInSession (before deliverToChannel)
    const startIdx = emitCalls.indexOf(proxyStartCall);
    const stopIdx = emitCalls.indexOf(proxyStopCall);
    expect(startIdx).toBeLessThan(stopIdx);
  });

  // -------------------------------------------------------------------------
  // 8. announceToParent does NOT deliver when response is NO_REPLY
  // -------------------------------------------------------------------------

  it("announceToParent does NOT deliver when response is NO_REPLY", async () => {
    const mockExecutor = {
      execute: vi.fn(async () => ({
        response: "NO_REPLY",
        tokensUsed: { total: 50 },
        cost: { total: 0.005 },
        finishReason: "stop",
      })),
    };

    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps({
      getExecutor: vi.fn(() => mockExecutor),
    });
    setupCrossSession(deps);

    const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
    const announceToParent = runnerArgs.announceToParent;

    mockDeliverToChannel.mockClear();
    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    await announceToParent("agent-1", sessionKey, "Done", "telegram", "chat-123");

    expect(mockDeliverToChannel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. announceToParent does NOT deliver when response is empty
  // -------------------------------------------------------------------------

  it("announceToParent does NOT deliver when response is empty", async () => {
    const mockExecutor = {
      execute: vi.fn(async () => ({
        response: "  ",
        tokensUsed: { total: 50 },
        cost: { total: 0.005 },
        finishReason: "stop",
      })),
    };

    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps({
      getExecutor: vi.fn(() => mockExecutor),
    });
    setupCrossSession(deps);

    const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
    const announceToParent = runnerArgs.announceToParent;

    mockDeliverToChannel.mockClear();
    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    await announceToParent("agent-1", sessionKey, "Done", "telegram", "chat-123");

    expect(mockDeliverToChannel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9b. announceToParent emits proxy_stop even on executeInSession failure
  // -------------------------------------------------------------------------

  it("announceToParent emits proxy_stop even when executeInSession throws", async () => {
    const mockExecutor = {
      execute: vi.fn(async () => { throw new Error("executor failure"); }),
    };

    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps({
      getExecutor: vi.fn(() => mockExecutor),
    });
    setupCrossSession(deps);

    const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
    const announceToParent = runnerArgs.announceToParent;

    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    await expect(
      announceToParent("agent-1", sessionKey, "Done", "telegram", "chat-123"),
    ).rejects.toThrow("executor failure");

    // proxy_stop must still be emitted via the finally block
    const emitCalls = deps.container.eventBus.emit.mock.calls;
    const proxyStopCall = emitCalls.find((c: any[]) => c[0] === "typing:proxy_stop");
    expect(proxyStopCall).toBeDefined();
    expect(proxyStopCall![1]).toMatchObject({
      channelType: "telegram",
      channelId: "chat-123",
      reason: "completed",
    });
  });

  // -------------------------------------------------------------------------
  // 9c. announceToParent emits proxy_stop on NO_REPLY (no channel send)
  // -------------------------------------------------------------------------

  it("announceToParent emits proxy_stop when response is NO_REPLY (no channel send)", async () => {
    const mockExecutor = {
      execute: vi.fn(async () => ({
        response: "NO_REPLY",
        tokensUsed: { total: 50 },
        cost: { total: 0.005 },
        finishReason: "stop",
      })),
    };

    const setupCrossSession = await getSetupCrossSession();
    const deps = createMinimalDeps({
      getExecutor: vi.fn(() => mockExecutor),
    });
    setupCrossSession(deps);

    const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
    const announceToParent = runnerArgs.announceToParent;

    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
    await announceToParent("agent-1", sessionKey, "Done", "telegram", "chat-123");

    // No channel delivery, but typing still stops
    expect(mockDeliverToChannel).not.toHaveBeenCalled();
    const emitCalls = deps.container.eventBus.emit.mock.calls;
    const proxyStartCall = emitCalls.find((c: any[]) => c[0] === "typing:proxy_start");
    const proxyStopCall = emitCalls.find((c: any[]) => c[0] === "typing:proxy_stop");
    expect(proxyStartCall).toBeDefined();
    expect(proxyStopCall).toBeDefined();
    expect(proxyStopCall![1].runId).toBe(proxyStartCall![1].runId);
  });

  // -------------------------------------------------------------------------
  // 10. Sub-agent step counter isolation
  // -------------------------------------------------------------------------

  describe("sub-agent step counter isolation", () => {
    it("creates fresh StepCounter per executeSubAgent call", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 5,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Verify executor was called with overrides containing a stepCounter
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "agent-2", undefined, undefined,
        expect.objectContaining({ stepCounter: expect.any(Object) }),
      );
    });

    it("concurrent sub-agents get independent StepCounters", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 3,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await Promise.all([
        executeAgent("agent-2", sessionKey, "task-1"),
        executeAgent("agent-2", sessionKey, "task-2"),
      ]);

      // Each call should create a separate StepCounter instance
      expect(mockCreateStepCounter).toHaveBeenCalledTimes(2);
      expect(capturedOverrides[0].stepCounter).not.toBe(capturedOverrides[1].stepCounter);
    });

    it("passes tool groups from config to assembleToolsForAgent", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const deps = createMinimalDeps();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("agent-2", {
        includePlatformTools: true,
        toolGroups: ["coding"],
        includeMcpTools: true,
      });
    });

    it("threads stepsExecuted in executeSubAgent result", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 7,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      const result = await executeAgent("agent-2", sessionKey, "task");

      expect(result.stepsExecuted).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // skipRag for graph sub-agents
  // -------------------------------------------------------------------------

  describe("skipRag for graph sub-agents", () => {
    it("passes skipRag: true when graphSharedDir is present in session metadata", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 5,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      // Mock session metadata with graphSharedDir
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: { graphSharedDir: "/tmp/graph-shared" },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(capturedOverrides[0].skipRag).toBe(true);
    });

    it("passes skipRag: false when graphSharedDir is absent", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 5,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      // No graphSharedDir in session metadata
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: {},
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(capturedOverrides[0].skipRag).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Graph sub-agent cache retention precedence
  // -------------------------------------------------------------------------

  describe("graph sub-agent cache retention precedence", () => {
    it("graph sub-agents get 'long' retention even when model resolution returns 'short'", async () => {
      // First call is condensation (at setup time), second is subagent (at executeAgent time)
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        })
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "subagent" as const,
          timeoutMs: 120_000,
          cacheRetention: "short" as const,
        });

      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 5,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      // Mock session metadata with graphSharedDir (marks this as a graph sub-agent)
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: { graphSharedDir: "/tmp/graph-shared" },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Graph sub-agents MUST get "long" even when resolution says "short"
      expect(capturedOverrides[0].cacheRetention).toBe("long");
    });

    it("non-graph sub-agents still respect model resolution cacheRetention", async () => {
      // First call is condensation (at setup time), second is subagent (at executeAgent time)
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        })
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "subagent" as const,
          timeoutMs: 120_000,
          cacheRetention: "none" as const,
        });

      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 5,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      // No graphSharedDir -- not a graph sub-agent
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: {},
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Non-graph sub-agents use resolution's cacheRetention
      expect(capturedOverrides[0].cacheRetention).toBe("none");
    });
  });

  // -------------------------------------------------------------------------
  // Sub-agent max_steps floor
  // -------------------------------------------------------------------------

  describe("sub-agent max_steps floor", () => {
    it("raises max_steps below MIN_SUB_AGENT_STEPS to the floor", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 5,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      mockCreateStepCounter.mockClear();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task", 10);

      expect(mockCreateStepCounter).toHaveBeenCalledWith(MIN_SUB_AGENT_STEPS);
    });

    it("preserves max_steps at or above MIN_SUB_AGENT_STEPS", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 5,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      mockCreateStepCounter.mockClear();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task", 40);

      expect(mockCreateStepCounter).toHaveBeenCalledWith(40);
    });

    it("uses config default when no max_steps provided (still subject to floor)", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 5,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      mockCreateStepCounter.mockClear();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Config default is 50, which is above floor of 30
      expect(mockCreateStepCounter).toHaveBeenCalledWith(50);
    });

    it("floor applies even when config default is below MIN_SUB_AGENT_STEPS", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 5,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "default": { name: "Default" },
              "agent-2": { name: "Agent 2" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: ["agent-2"],
                subAgentMaxSteps: 15,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      mockCreateStepCounter.mockClear();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Config default is 15, below floor -- should be raised to MIN_SUB_AGENT_STEPS (30)
      expect(mockCreateStepCounter).toHaveBeenCalledWith(MIN_SUB_AGENT_STEPS);
    });
  });

  // -------------------------------------------------------------------------
  // Sub-agent tool denylist
  // -------------------------------------------------------------------------

  describe("sub-agent tool denylist", () => {
    it("removes denied tools from sub-agent tool set", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async () => [
          { name: "gateway" },
          { name: "channels_manage" },
          { name: "exec" },
          { name: "read" },
        ]),
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      const passedTools = mockExecutor.execute.mock.calls[0][2];
      const toolNames = passedTools.map((t: { name: string }) => t.name);
      expect(toolNames).toEqual(["exec", "read"]);
      expect(toolNames).not.toContain("gateway");
      expect(toolNames).not.toContain("channels_manage");
    });

    it("logs denied tools at DEBUG level", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const logger = createMockLogger();
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async () => [
          { name: "gateway" },
          { name: "channels_manage" },
          { name: "exec" },
        ]),
        getExecutor: vi.fn(() => mockExecutor),
        logger,
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          deniedTools: expect.arrayContaining(["gateway", "channels_manage"]),
        }),
        "Sub-agent tool denylist applied",
      );
    });

    it("denylist applies even without callerAgentId", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async () => [
          { name: "agents_manage" },
          { name: "exec" },
          { name: "read" },
        ]),
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      // Call WITHOUT callerAgentId (skip parent tool intersection path)
      await executeAgent("agent-2", sessionKey, "task", false, undefined, undefined);

      const passedTools = mockExecutor.execute.mock.calls[0][2];
      const toolNames = passedTools.map((t: { name: string }) => t.name);
      expect(toolNames).toEqual(["exec", "read"]);
      expect(toolNames).not.toContain("agents_manage");
    });

    it("denylist composes with inheritance intersection", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async (agentId: string, _options?: any) => {
          if (agentId === "parent-agent") {
            // Parent has: exec, read, gateway
            return [{ name: "exec" }, { name: "read" }, { name: "gateway" }];
          }
          // Sub-agent ceiling: exec, read, gateway, channels_manage
          return [{ name: "exec" }, { name: "read" }, { name: "gateway" }, { name: "channels_manage" }];
        }),
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      // Pass callerAgentId to trigger parent tool intersection
      await executeAgent("agent-2", sessionKey, "task", false, undefined, "parent-agent");

      // After parent intersection: exec, read, gateway (channels_manage dropped)
      // After denylist: exec, read (gateway dropped)
      const passedTools = mockExecutor.execute.mock.calls[0][2];
      const toolNames = passedTools.map((t: { name: string }) => t.name);
      expect(toolNames).toEqual(["exec", "read"]);
    });

    it("passes includeMcpTools: false when subAgentMcpTools is none", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "default": { name: "Default" },
              "agent-1": { name: "Agent 1" },
              "agent-2": { name: "Agent 2" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: ["agent-1", "agent-2"],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "none",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("agent-2", {
        includePlatformTools: true,
        toolGroups: ["coding"],
        includeMcpTools: false,
      });
    });

    it("SUB_AGENT_TOOL_DENYLIST contains expected tools", () => {
      expect(SUB_AGENT_TOOL_DENYLIST).toBeInstanceOf(Set);
      expect(SUB_AGENT_TOOL_DENYLIST.size).toBe(9);
      expect(SUB_AGENT_TOOL_DENYLIST.has("gateway")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("channels_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("agents_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("models_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("tokens_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("skills_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("sessions_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("memory_manage")).toBe(true);
      expect(SUB_AGENT_TOOL_DENYLIST.has("heartbeat_manage")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // builtinTools ceiling defense-in-depth
  // -------------------------------------------------------------------------

  describe("builtinTools ceiling defense-in-depth", () => {
    it("re-applies target agent builtinTools ceiling after parent intersection", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async (agentId: string, _options?: any) => {
          if (agentId === "parent-agent") {
            // Parent has exec and read
            return [{ name: "exec" }, { name: "read" }];
          }
          // effectiveAgentId was permissive, so exec is present in assembled tools
          return [{ name: "exec" }, { name: "read" }];
        }),
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "target-agent": {
                name: "Target",
                skills: { builtinTools: { exec: false, process: true, browser: false } },
              },
              "parent-agent": { name: "Parent" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
          secretManager: { get: vi.fn(), has: vi.fn() },
          providers: { entries: {} },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("target-agent", sessionKey, "task", undefined, "parent-agent");

      const passedTools = mockExecutor.execute.mock.calls[0][2];
      const toolNames = passedTools.map((t: { name: string }) => t.name);
      // ceiling should remove exec (target agent has exec: false)
      expect(toolNames).not.toContain("exec");
      // read is unaffected
      expect(toolNames).toContain("read");
    });

    it("logs dropped tools at DEBUG level when ceiling applied", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const logger = createMockLogger();
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async (agentId: string, _options?: any) => {
          if (agentId === "parent-agent") {
            return [{ name: "exec" }, { name: "read" }];
          }
          return [{ name: "exec" }, { name: "read" }];
        }),
        getExecutor: vi.fn(() => mockExecutor),
        logger,
        container: {
          config: {
            agents: {
              "target-agent": {
                name: "Target",
                skills: { builtinTools: { exec: false, process: true, browser: false } },
              },
              "parent-agent": { name: "Parent" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
          secretManager: { get: vi.fn(), has: vi.fn() },
          providers: { entries: {} },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("target-agent", sessionKey, "task", undefined, "parent-agent");

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "target-agent",
          droppedByCeiling2: ["exec"],
        }),
        "builtinTools ceiling defense-in-depth applied",
      );
    });

    it("is no-op when target agent has no dedicated config", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async () => [
          { name: "exec" }, { name: "read" },
        ]),
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              // No entry for "ephemeral-agent"
              "default": { name: "Default" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
          secretManager: { get: vi.fn(), has: vi.fn() },
          providers: { entries: {} },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      // No callerAgentId -- direct execution without parent intersection
      await executeAgent("ephemeral-agent", sessionKey, "task");

      const passedTools = mockExecutor.execute.mock.calls[0][2];
      const toolNames = passedTools.map((t: { name: string }) => t.name);
      // exec is still present (ceiling skipped -- no config for ephemeral-agent, no TypeError)
      expect(toolNames).toContain("exec");
      expect(toolNames).toContain("read");
    });

    it("ceiling runs before denylist (ordering verification)", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        assembleToolsForAgent: vi.fn(async (agentId: string, _options?: any) => {
          if (agentId === "parent-agent") {
            // Parent has all three tools
            return [{ name: "exec" }, { name: "gateway" }, { name: "read" }];
          }
          // Sub-agent ceiling: exec, gateway, read (effectiveAgentId was permissive)
          return [{ name: "exec" }, { name: "gateway" }, { name: "read" }];
        }),
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "target-agent": {
                name: "Target",
                skills: { builtinTools: { exec: false, process: true, browser: false } },
              },
              "parent-agent": { name: "Parent" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
          secretManager: { get: vi.fn(), has: vi.fn() },
          providers: { entries: {} },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("target-agent", sessionKey, "task", undefined, "parent-agent");

      const passedTools = mockExecutor.execute.mock.calls[0][2];
      const toolNames = passedTools.map((t: { name: string }) => t.name);
      // exec removed by ceiling (target has exec: false)
      // gateway removed by denylist (in SUB_AGENT_TOOL_DENYLIST)
      // Only read remains
      expect(toolNames).toEqual(["read"]);
    });
  });

  // -------------------------------------------------------------------------
  // Sub-agent workspace inheritance (WORKSPACE-INHERIT)
  // -------------------------------------------------------------------------

  describe("sub-agent workspace inheritance (WORKSPACE-INHERIT)", () => {
    it("uses callerAgentId for tool assembly when sub-agent has no dedicated config", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "technical-analyst": { name: "TA" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("sub-agent-xyz", sessionKey, "task", undefined, "technical-analyst");

      // assembleToolsForAgent should be called with "technical-analyst" (effectiveAgentId)
      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("technical-analyst", expect.objectContaining({
        includePlatformTools: true,
      }));

      // getExecutor should be called with "technical-analyst" (effectiveAgentId)
      expect(deps.getExecutor).toHaveBeenCalledWith("technical-analyst");
    });

    it("uses agentId directly when sub-agent has its own config", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "technical-analyst": { name: "TA" },
              "sub-agent-xyz": { name: "Sub" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("sub-agent-xyz", sessionKey, "task", undefined, "technical-analyst");

      // assembleToolsForAgent should be called with "sub-agent-xyz" (its own agentId)
      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("sub-agent-xyz", expect.objectContaining({
        includePlatformTools: true,
      }));

      // getExecutor should be called with "sub-agent-xyz"
      expect(deps.getExecutor).toHaveBeenCalledWith("sub-agent-xyz");
    });

    it("falls back to agentId when no callerAgentId provided", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "technical-analyst": { name: "TA" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      // No callerAgentId -- original fallback behavior
      await executeAgent("sub-agent-xyz", sessionKey, "task", undefined, undefined);

      // assembleToolsForAgent should be called with "sub-agent-xyz" (agentId, original behavior)
      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("sub-agent-xyz", expect.objectContaining({
        includePlatformTools: true,
      }));

      // getExecutor should be called with "sub-agent-xyz"
      expect(deps.getExecutor).toHaveBeenCalledWith("sub-agent-xyz");
    });

    it("still uses callerAgentId for tool ceiling intersection when workspace inherited", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const assembleToolsCalls: string[] = [];
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        assembleToolsForAgent: vi.fn(async (agentId: string) => {
          assembleToolsCalls.push(agentId);
          return [{ name: "tool-1" }];
        }),
        container: {
          config: {
            agents: {
              "technical-analyst": { name: "TA" },
              // "sub-agent-xyz" intentionally NOT present -- triggers WORKSPACE-INHERIT
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: [],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("sub-agent-xyz", sessionKey, "task", undefined, "technical-analyst");

      // assembleToolsForAgent should be called TWICE:
      // 1st: "technical-analyst" (effectiveAgentId for tool assembly -- WORKSPACE-INHERIT)
      // 2nd: "technical-analyst" (callerAgentId for parent ceiling intersection)
      expect(assembleToolsCalls).toEqual(["technical-analyst", "technical-analyst"]);
    });
  });

  // -------------------------------------------------------------------------
  // Proxy typing listener
  // -------------------------------------------------------------------------

  describe("proxy typing listener", () => {
    function createProxyDeps(overrides: Record<string, any> = {}) {
      const eventBus = createFunctionalEventBus();
      return {
        deps: createMinimalDeps({
          container: {
            config: {
              agents: { "default": { name: "Default" } },
              security: {
                agentToAgent: {
                  enabled: true,
                  allowList: [],
                  subAgentMaxSteps: 50,
                  subAgentToolGroups: ["coding"],
                  subAgentMcpTools: "inherit",
                },
              },
              tenantId: "test-tenant",
              dataDir: "/tmp/test",
            },
            eventBus,
            secretManager: { get: vi.fn(), has: vi.fn() },
            providers: { entries: {} },
          },
          adaptersByType: new Map([
            ["telegram", {
              channelType: "telegram",
              sendMessage: vi.fn(async () => ({ ok: true, value: "mock-msg-id" })),
              platformAction: vi.fn(async () => ({ ok: true, value: undefined })),
            }],
          ]),
          ...overrides,
        }),
        eventBus,
      };
    }

    it("proxy_start creates controller and starts typing", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      eventBus.emit("typing:proxy_start", {
        runId: "run-1",
        channelType: "telegram",
        channelId: "chat-100",
        parentSessionKey: "session-key-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      expect(mockCreateTypingController).toHaveBeenCalledTimes(1);
      expect(mockCreateTypingController).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "thinking", refreshMs: 4000, ttlMs: 300_000 }),
        expect.any(Function),
        expect.any(Object),
      );
      // The returned controller's start() should have been called with channelId
      const controllerInstance = mockCreateTypingController.mock.results[0].value;
      expect(controllerInstance.start).toHaveBeenCalledWith("chat-100");
    });

    it("proxy_stop stops controller and removes map entry", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      eventBus.emit("typing:proxy_start", {
        runId: "run-2",
        channelType: "telegram",
        channelId: "chat-200",
        parentSessionKey: "session-key-2",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      const controllerInstance = mockCreateTypingController.mock.results[0].value;
      controllerInstance.stop.mockClear();

      eventBus.emit("typing:proxy_stop", {
        runId: "run-2",
        channelType: "telegram",
        channelId: "chat-200",
        reason: "completed",
        durationMs: 5000,
        timestamp: Date.now(),
      });

      expect(controllerInstance.stop).toHaveBeenCalledTimes(1);

      // A second stop for same runId should be no-op (map entry removed)
      controllerInstance.stop.mockClear();
      eventBus.emit("typing:proxy_stop", {
        runId: "run-2",
        channelType: "telegram",
        channelId: "chat-200",
        reason: "completed",
        durationMs: 5000,
        timestamp: Date.now(),
      });
      expect(controllerInstance.stop).not.toHaveBeenCalled();
    });

    it("duplicate proxy_start for same runId is ignored", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      const evt = {
        runId: "run-dup",
        channelType: "telegram",
        channelId: "chat-300",
        parentSessionKey: "session-key-3",
        agentId: "agent-1",
        timestamp: Date.now(),
      };

      eventBus.emit("typing:proxy_start", evt);
      eventBus.emit("typing:proxy_start", evt);

      expect(mockCreateTypingController).toHaveBeenCalledTimes(1);
    });

    it("proxy_start skipped for unsupported channel type", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      eventBus.emit("typing:proxy_start", {
        runId: "run-irc",
        channelType: "irc",
        channelId: "irc-chan",
        parentSessionKey: "session-key-irc",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      expect(mockCreateTypingController).not.toHaveBeenCalled();
    });

    it("proxy_start skipped when adapter not in adaptersByType", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      // discord has typing support in PROXY_TYPING_REFRESH but no adapter registered
      eventBus.emit("typing:proxy_start", {
        runId: "run-discord",
        channelType: "discord",
        channelId: "discord-chan",
        parentSessionKey: "session-key-discord",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      expect(mockCreateTypingController).not.toHaveBeenCalled();
    });

    it("TTL sweep removes stale entries", async () => {
      vi.useFakeTimers();
      try {
        const setupCrossSession = await getSetupCrossSession();
        const { deps, eventBus } = createProxyDeps();
        mockCreateTypingController.mockClear();

        setupCrossSession(deps);

        // Create an entry via proxy_start
        eventBus.emit("typing:proxy_start", {
          runId: "run-stale",
          channelType: "telegram",
          channelId: "chat-stale",
          parentSessionKey: "session-key-stale",
          agentId: "agent-1",
          timestamp: Date.now(),
        });

        const controllerInstance = mockCreateTypingController.mock.results[0].value;
        controllerInstance.stop.mockClear();

        // Advance past TTL (300s) + sweep interval (60s)
        vi.advanceTimersByTime(360_001);

        expect(controllerInstance.stop).toHaveBeenCalledTimes(1);

        // Verify entry was removed -- proxy_stop should be no-op
        controllerInstance.stop.mockClear();
        eventBus.emit("typing:proxy_stop", {
          runId: "run-stale",
          channelType: "telegram",
          channelId: "chat-stale",
          reason: "completed",
          durationMs: 0,
          timestamp: Date.now(),
        });
        expect(controllerInstance.stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("system:shutdown stops all controllers and clears map", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();

      // Return distinct controller instances so stop() calls are independently trackable
      const stopA = vi.fn();
      const stopB = vi.fn();
      mockCreateTypingController
        .mockClear()
        .mockReturnValueOnce({ start: vi.fn(), stop: stopA, refreshTtl: vi.fn(), isActive: true, startedAt: Date.now(), isSealed: false })
        .mockReturnValueOnce({ start: vi.fn(), stop: stopB, refreshTtl: vi.fn(), isActive: true, startedAt: Date.now(), isSealed: false });

      setupCrossSession(deps);

      // Start two proxy controllers
      eventBus.emit("typing:proxy_start", {
        runId: "run-a",
        channelType: "telegram",
        channelId: "chat-a",
        parentSessionKey: "session-key-a",
        agentId: "agent-1",
        timestamp: Date.now(),
      });
      eventBus.emit("typing:proxy_start", {
        runId: "run-b",
        channelType: "telegram",
        channelId: "chat-b",
        parentSessionKey: "session-key-b",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      // Emit shutdown
      eventBus.emit("system:shutdown", { reason: "test", graceful: true });

      expect(stopA).toHaveBeenCalledTimes(1);
      expect(stopB).toHaveBeenCalledTimes(1);

      // Verify map was cleared -- proxy_stop should be no-op
      stopA.mockClear();
      eventBus.emit("typing:proxy_stop", {
        runId: "run-a",
        channelType: "telegram",
        channelId: "chat-a",
        reason: "completed",
        durationMs: 0,
        timestamp: Date.now(),
      });
      expect(stopA).not.toHaveBeenCalled();
    });

    it("proxy_start passes threadId to platformAction when present", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const { deps, eventBus } = createProxyDeps();
      mockCreateTypingController.mockClear();

      // Make createTypingController call sendTyping immediately (capture the callback)
      let capturedSendTyping: ((chatId: string) => Promise<void>) | undefined;
      mockCreateTypingController.mockImplementationOnce((config: any, sendTyping: any, logger: any) => {
        capturedSendTyping = sendTyping;
        return {
          start: vi.fn(),
          stop: vi.fn(),
          refreshTtl: vi.fn(),
          isActive: true,
          startedAt: Date.now(),
          isSealed: false,
        };
      });

      setupCrossSession(deps);

      eventBus.emit("typing:proxy_start", {
        runId: "run-thread",
        channelType: "telegram",
        channelId: "chat-thread",
        parentSessionKey: "session-key-thread",
        agentId: "agent-1",
        threadId: "topic-42",
        timestamp: Date.now(),
      });

      expect(capturedSendTyping).toBeDefined();
      await capturedSendTyping!("chat-thread");

      const adapter = deps.adaptersByType.get("telegram")!;
      expect(adapter.platformAction).toHaveBeenCalledWith("sendTyping", {
        chatId: "chat-thread",
        threadId: "topic-42",
      });
    });

    it("proxy_start logs at DEBUG level", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const logger = createMockLogger();
      const { deps, eventBus } = createProxyDeps({ logger });
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      eventBus.emit("typing:proxy_start", {
        runId: "run-log",
        channelType: "telegram",
        channelId: "chat-log",
        parentSessionKey: "session-key-log",
        agentId: "agent-log",
        timestamp: Date.now(),
      });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-log",
          channelType: "telegram",
          channelId: "chat-log",
          agentId: "agent-log",
        }),
        "Proxy typing started for sub-agent run",
      );
    });

    it("proxy_stop logs at DEBUG level", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const logger = createMockLogger();
      const { deps, eventBus } = createProxyDeps({ logger });
      mockCreateTypingController.mockClear();

      setupCrossSession(deps);

      eventBus.emit("typing:proxy_start", {
        runId: "run-log2",
        channelType: "telegram",
        channelId: "chat-log2",
        parentSessionKey: "session-key-log2",
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      eventBus.emit("typing:proxy_stop", {
        runId: "run-log2",
        channelType: "telegram",
        channelId: "chat-log2",
        reason: "failed",
        durationMs: 3000,
        timestamp: Date.now(),
      });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-log2",
          reason: "failed",
          durationMs: 3000,
        }),
        "Proxy typing stopped for sub-agent run",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Sub-agent session persistence
  // -------------------------------------------------------------------------

  describe("sub-agent session persistence", () => {
    it("uses ephemeral session adapter when subAgentSessionPersistence is false (default)", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "default": { name: "Default" },
              "agent-2": { name: "Agent 2" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
                subAgentSessionPersistence: false,
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      mockCreateEphemeralComisSessionManager.mockClear();
      mockCreateComisSessionManager.mockClear();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Ephemeral adapter should be used, not the disk-backed one
      expect(mockCreateEphemeralComisSessionManager).toHaveBeenCalled();
      expect(mockCreateComisSessionManager).not.toHaveBeenCalled();
    });

    it("uses disk-backed session adapter when subAgentSessionPersistence is true", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "default": { name: "Default" },
              "agent-2": { name: "Agent 2" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
                subAgentSessionPersistence: true,
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      mockCreateEphemeralComisSessionManager.mockClear();
      mockCreateComisSessionManager.mockClear();
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Disk-backed adapter should be used, not the ephemeral one
      expect(mockCreateComisSessionManager).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionBaseDir: expect.stringContaining("sessions"),
          lockDir: expect.stringContaining(".locks"),
          cwd: expect.any(String),
        }),
      );
      expect(mockCreateEphemeralComisSessionManager).not.toHaveBeenCalled();
    });

    it("passes disk-backed adapter through executor overrides when persistence enabled", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const diskAdapter = {
        withSession: vi.fn(),
        destroySession: vi.fn(),
        getSessionStats: vi.fn(),
        writeSessionMetadata: vi.fn(),
      };
      mockCreateComisSessionManager.mockReturnValue(diskAdapter);

      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {
              "default": { name: "Default" },
              "agent-2": { name: "Agent 2" },
            },
            security: {
              agentToAgent: {
                enabled: true,
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
                subAgentSessionPersistence: true,
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Verify the disk-backed adapter was passed in the executor overrides
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "agent-2", undefined, undefined,
        expect.objectContaining({ ephemeralSessionAdapter: diskAdapter }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Sub-agent model resolution via resolveOperationModel
  // -------------------------------------------------------------------------

  describe("sub-agent model resolution", () => {
    it("passes resolved model (not raw modelOverride) in execution overrides", async () => {
      // First call is condensation (at setup time), second is subagent (at executeAgent time)
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        })
        .mockReturnValueOnce({
          model: "anthropic:claude-haiku-4-5-20251001",
          provider: "anthropic",
          modelId: "claude-haiku-4-5-20251001",
          source: "family_default" as const,
          operationType: "subagent" as const,
          timeoutMs: 120_000,
          cacheRetention: "short" as const,
        });

      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 3,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // executor should receive the resolved model, not raw modelOverride
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "agent-2", undefined, undefined,
        expect.objectContaining({ model: "anthropic:claude-haiku-4-5-20251001" }),
      );
    });

    it("sets operationType 'subagent' in execution overrides", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "agent-2", undefined, undefined,
        expect.objectContaining({ operationType: "subagent" }),
      );
    });

    it("sets promptTimeout from resolution.timeoutMs in execution overrides", async () => {
      // First call is condensation (at setup time), second is subagent (at executeAgent time)
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        })
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "subagent" as const,
          timeoutMs: 90_000,
          cacheRetention: "short" as const,
        });

      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "agent-2", undefined, undefined,
        expect.objectContaining({ promptTimeout: { promptTimeoutMs: 90_000 } }),
      );
    });

    it("passes SpawnParams.model as invocationOverride to resolveOperationModel", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        sessionStore: {
          loadByFormattedKey: vi.fn(() => ({
            metadata: { modelOverride: "openai:gpt-4o" },
          })),
          save: vi.fn(),
          delete: vi.fn(),
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // resolveOperationModel should be called with invocationOverride from session meta
      expect(mockResolveOperationModel).toHaveBeenCalledWith(
        expect.objectContaining({
          operationType: "subagent",
          invocationOverride: "openai:gpt-4o",
        }),
      );
    });

    it("reads parentModel from ALS context (tryGetContext().resolvedModel)", async () => {
      // Import runWithContext to set up the ALS context with resolvedModel
      const { runWithContext } = await import("@comis/core");
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };

      // Execute within ALS context that has resolvedModel set
      const alsCtx = {
        tenantId: "default",
        userId: "u1",
        sessionKey: "t1:c1:u1",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        trustLevel: "admin" as const,
        resolvedModel: "anthropic:claude-opus-4-20250514",
      };
      await runWithContext(alsCtx as any, async () => {
        await executeAgent("agent-2", sessionKey, "task");
      });

      // resolveOperationModel should receive the parent's resolved model
      expect(mockResolveOperationModel).toHaveBeenCalledWith(
        expect.objectContaining({
          parentModel: "anthropic:claude-opus-4-20250514",
        }),
      );
    });

    it("falls back to modelOverride when agent config is missing", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      // Create deps where the agent does not have any config and no "default" either
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
        container: {
          config: {
            agents: {},
            security: {
              agentToAgent: {
                enabled: true,
                allowList: ["unknown-agent"],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
          },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
        sessionStore: {
          loadByFormattedKey: vi.fn(() => ({
            metadata: { modelOverride: "openai:gpt-4o-mini" },
          })),
          save: vi.fn(),
          delete: vi.fn(),
        },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("unknown-agent", sessionKey, "task");

      // With no agent config, subagentResolution is undefined, falls back to raw modelOverride
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "unknown-agent", undefined, undefined,
        expect.objectContaining({ model: "openai:gpt-4o-mini" }),
      );
    });

    it("uses cacheRetention from resolution when available", async () => {
      // First call is condensation (at setup time), second is subagent (at executeAgent time)
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        })
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "subagent" as const,
          timeoutMs: 120_000,
          cacheRetention: "none" as const,
        });

      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 2,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;
      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task");

      // Should use resolution's cacheRetention ("none") instead of default "short"
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.any(Object), sessionKey, expect.any(Array),
        undefined, "agent-2", undefined, undefined,
        expect.objectContaining({ cacheRetention: "none" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Condensation model resolution via resolveOperationModel
  // -------------------------------------------------------------------------

  describe("condensation model resolution", () => {
    // condensationModel field deleted -- no invocationOverride for condensation
    it("resolves condensation model via resolveOperationModel at setup without invocationOverride", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const deps = createMinimalDeps();
      setupCrossSession(deps);

      // Find the condensation call (operationType === "condensation") among all resolveOperationModel calls
      const condensationCall = mockResolveOperationModel.mock.calls.find(
        (args: any[]) => args[0].operationType === "condensation",
      );
      expect(condensationCall).toBeDefined();
      expect(condensationCall![0]).toEqual(
        expect.objectContaining({
          operationType: "condensation",
          agentProvider: "anthropic",
          agentModel: "claude-sonnet-4-5-20250929",
        }),
      );
      expect(condensationCall![0].invocationOverride).toBeUndefined();
    });

    it("resolves API key from resolution.provider for cross-provider condensation", async () => {
      // Configure mock to return google provider for condensation
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "google:gemini-2.5-flash",
          provider: "google",
          modelId: "gemini-2.5-flash",
          source: "explicit_config" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        });

      const mockSecretGet = vi.fn((key: string) => key === "GOOGLE_AI_KEY" ? "google-api-key" : "");
      const setupCrossSession = await getSetupCrossSession();
      const deps = createMinimalDeps({
        container: {
          config: {
            agents: {
              "default": { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-1": { name: "Agent 1", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-2": { name: "Agent 2", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: ["agent-1", "agent-2"],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
                subagentContext: {},
              },
            },
            tenantId: "test-tenant",
            providers: { entries: { google: { apiKeyName: "GOOGLE_AI_KEY" } } },
          },
          secretManager: { get: mockSecretGet, has: vi.fn() },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      // API key should be resolved from google provider (not anthropic)
      expect(mockSecretGet).toHaveBeenCalledWith("GOOGLE_AI_KEY");
    });

    it("condenserModel uses resolution.modelId and resolution.provider (not legacy variables)", async () => {
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "google:gemini-2.5-flash",
          provider: "google",
          modelId: "gemini-2.5-flash",
          source: "explicit_config" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        });

      const mockSecretGet = vi.fn(() => "some-key");
      const setupCrossSession = await getSetupCrossSession();
      const deps = createMinimalDeps({
        container: {
          config: {
            agents: {
              "default": { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-1": { name: "Agent 1", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-2": { name: "Agent 2", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
            },
            security: {
              agentToAgent: {
                enabled: true,
                allowList: ["agent-1", "agent-2"],
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            tenantId: "test-tenant",
            providers: { entries: { google: { apiKeyName: "GOOGLE_AI_KEY" } } },
          },
          secretManager: { get: mockSecretGet, has: vi.fn() },
          eventBus: { on: vi.fn(), emit: vi.fn() },
        },
      });
      setupCrossSession(deps);

      // Extract the condenserModel passed to createSubAgentRunner
      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      expect(runnerArgs.condenserModel).toEqual({ id: "gemini-2.5-flash", provider: "google" });
    });
  });

  // -------------------------------------------------------------------------
  // persistent session reuse (SpawnPacket skip + cache retention)
  // -------------------------------------------------------------------------

  describe("persistent session reuse", () => {
    it("isReuseSession guard skips SpawnPacket when reuseSessionKey provided", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 5,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      // Session metadata includes taskDescription (which would trigger SpawnPacket normally)
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: { taskDescription: "Debate round 2", graphSharedDir: "/tmp/shared" },
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      // Pass graphOverrides with reuseSessionKey
      await executeAgent("agent-2", sessionKey, "task", undefined, undefined, {
        reuseSessionKey: "default:debate-node1:debate:graph1:node1",
      });

      // SpawnPacket should be undefined (skipped) when isReuseSession is true
      expect(capturedOverrides[0].spawnPacket).toBeUndefined();
    });

    it("isReuseSession forces disk-backed session manager (not ephemeral)", async () => {
      const setupCrossSession = await getSetupCrossSession();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { total: 100 },
          cost: { total: 0.01 },
          finishReason: "stop",
          stepsExecuted: 5,
        })),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: {},
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task", undefined, undefined, {
        reuseSessionKey: "default:debate-node1:debate:graph1:node1",
      });

      // Reuse sessions use createComisSessionManager (disk-backed), not ephemeral
      expect(mockCreateComisSessionManager).toHaveBeenCalled();
    });

    it("isReuseSession forces 'long' cache retention for multi-round persistence", async () => {
      // First call is condensation (at setup time), second is subagent (at executeAgent time)
      mockResolveOperationModel
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "condensation" as const,
          timeoutMs: 60_000,
          cacheRetention: "short" as const,
        })
        .mockReturnValueOnce({
          model: "anthropic:claude-sonnet-4-5-20250929",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          source: "family_default" as const,
          operationType: "subagent" as const,
          timeoutMs: 120_000,
          cacheRetention: "short" as const,
        });

      const setupCrossSession = await getSetupCrossSession();
      const capturedOverrides: any[] = [];
      const mockExecutor = {
        execute: vi.fn(async (...args: any[]) => {
          capturedOverrides.push(args[7]);
          return {
            response: "Done",
            tokensUsed: { total: 100 },
            cost: { total: 0.01 },
            finishReason: "stop",
            stepsExecuted: 5,
          };
        }),
      };
      const deps = createMinimalDeps({
        getExecutor: vi.fn(() => mockExecutor),
      });
      deps.sessionStore.loadByFormattedKey.mockReturnValue({
        messages: [],
        metadata: {},
      });
      setupCrossSession(deps);

      const runnerArgs = mockCreateSubAgentRunner.mock.calls[0][0];
      const executeAgent = runnerArgs.executeAgent;

      const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1" };
      await executeAgent("agent-2", sessionKey, "task", undefined, undefined, {
        reuseSessionKey: "default:debate-node1:debate:graph1:node1",
      });

      // Reuse sessions force "long" retention even when resolution says "short"
      expect(capturedOverrides[0].cacheRetention).toBe("long");
    });
  });
});

// ---------------------------------------------------------------------------
// Depth-aware graph cache retention (pure function)
// ---------------------------------------------------------------------------

describe("resolveGraphCacheRetention", () => {
  it("returns 'long' for all graph nodes including root (depth=0)", () => {
    // Depth-aware "short" for root nodes was reverted — caused regressions where
    // final pipeline nodes got 0 cache reads because root cache expired after 5m.
    expect(resolveGraphCacheRetention(0)).toBe("long");
  });

  it("returns 'long' for downstream graph nodes (depth=1)", () => {
    expect(resolveGraphCacheRetention(1)).toBe("long");
  });

  it("returns 'long' for deep downstream nodes (depth=2+)", () => {
    expect(resolveGraphCacheRetention(2)).toBe("long");
    expect(resolveGraphCacheRetention(5)).toBe("long");
  });

  it("returns 'long' when depth is undefined (unknown/non-graph)", () => {
    expect(resolveGraphCacheRetention(undefined)).toBe("long");
  });

  it("returns 'long' when depth is negative (defensive)", () => {
    expect(resolveGraphCacheRetention(-1)).toBe("long");
  });
});
