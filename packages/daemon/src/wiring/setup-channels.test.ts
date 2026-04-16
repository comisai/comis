import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContainer, ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdaptersByType = new Map<string, ChannelPort>();
const mockAdapter = { sendMessage: vi.fn(async () => ({ ok: true })) } as unknown as ChannelPort;

vi.mock("./setup-channels-adapters.js", () => ({
  bootstrapAdapters: vi.fn(async () => ({
    adaptersByType: mockAdaptersByType,
    tgPlugin: undefined,
    linePlugin: undefined,
    channelCapabilities: new Map(),
  })),
}));

vi.mock("./setup-channels-media.js", () => ({
  buildMediaPipeline: vi.fn(async () => ({
    compositeResolver: { resolve: vi.fn(), schemes: [] },
    resolveAttachment: vi.fn(async () => null),
    preprocessMessage: vi.fn(async (msg: NormalizedMessage) => msg),
    audioPreflight: undefined,
  })),
}));

const mockChannelManager = {
  startAll: vi.fn(async () => {}),
  activeCount: 0,
};
const mockRetryEngine = { sendWithRetry: vi.fn() };
const mockApprovalNotifier = { start: vi.fn(), stop: vi.fn() };
vi.mock("@comis/channels", () => ({
  createChannelManager: vi.fn(() => mockChannelManager),
  createRetryEngine: vi.fn(() => mockRetryEngine),
  createLifecycleReactor: vi.fn(() => ({ destroy: vi.fn() })),
  createApprovalNotifier: vi.fn(() => mockApprovalNotifier),
  reactWithFallback: vi.fn(),
  initTelegramFileGuardConfig: vi.fn(),
  filterResponse: vi.fn((text: string) => {
    if (text === "NO_REPLY" || text === "HEARTBEAT_OK" || !text) {
      return { shouldDeliver: false, cleanedText: "", suppressedBy: text === "NO_REPLY" ? "no_reply" : text === "HEARTBEAT_OK" ? "heartbeat_ok" : "empty" };
    }
    return { shouldDeliver: true, cleanedText: text };
  }),
  deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string) => {
    // Delegate to adapter.sendMessage so existing assertions still work
    await adapter.sendMessage(channelId, text);
    return { ok: true, value: { ok: true, totalChunks: 1, deliveredChunks: 1, failedChunks: 0, chunks: [{ ok: true, messageId: "m1", charCount: text.length, retried: false }], totalChars: text.length } };
  }),
}));

const mockResolveOperationModel = vi.fn(() => ({
  model: "anthropic:claude-haiku-4-5-20251001",
  provider: "anthropic",
  modelId: "claude-haiku-4-5-20251001",
  source: "family_default" as const,
  operationType: "cron" as const,
  timeoutMs: 150_000,
  cacheRetention: undefined,
}));

const mockRunMemoryReview = vi.fn(async () => ({ ok: true as const, value: undefined }));

vi.mock("@comis/agent", () => ({
  createMessageRouter: vi.fn(() => ({ resolve: vi.fn() })),
  createCommandQueue: vi.fn(() => ({})),
  sanitizeAssistantResponse: vi.fn((text: string) => text),
  resolveOperationModel: (...args: unknown[]) => mockResolveOperationModel(...args),
  resolveProviderFamily: vi.fn((p: string) => p),
  runMemoryReview: (...args: unknown[]) => mockRunMemoryReview(...args),
}));

vi.mock("@comis/core", async () => {
  return {
    formatSessionKey: vi.fn((sk: SessionKey) => `${sk.tenantId}:${sk.userId}:${sk.channelId}`),
    runWithContext: vi.fn(async (_ctx: any, fn: () => any) => fn()),
    createDeliveryOrigin: vi.fn((input: any) => Object.freeze({ ...input })),
    RetryConfigSchema: { parse: vi.fn(() => ({ maxAttempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: true, respectRetryAfter: true, markdownFallback: true })) },
  };
});

vi.mock("@comis/skills", () => ({
  shouldAutoTts: vi.fn(),
  resolveOutputFormat: vi.fn(),
  parseOutboundMedia: vi.fn(),
}));

import { setupChannels, type ChannelsDeps } from "./setup-channels.js";
import { bootstrapAdapters } from "./setup-channels-adapters.js";
import { createChannelManager } from "@comis/channels";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

interface EventHandler {
  event: string;
  callback: (...args: any[]) => any;
}

function makeContainer(): { container: AppContainer; eventHandlers: EventHandler[] } {
  const eventHandlers: EventHandler[] = [];
  const container = {
    config: {
      agents: { agent1: { name: "Agent1", model: "claude-sonnet-4-20250514", provider: "anthropic", operationModels: {}, session: { resetPolicy: { resetTriggers: [] } }, memoryReview: undefined as any } },
      channels: {},
      routing: { defaultAgentId: "agent1", bindings: [] },
      integrations: {
        media: {
          persistence: { enabled: false },
          transcription: { autoTranscribe: false },
          tts: { provider: "openai", autoMode: "off", tagPattern: "", voice: "alloy", maxTextLength: 4096, outputFormats: {} },
          vision: { enabled: false, videoTimeoutMs: 30000, videoMaxDescriptionChars: 500 },
        },
      },
      tenantId: "default",
      providers: { entries: {} },
      streaming: {},
      autoReplyEngine: {},
      sendPolicy: {},
      lifecycleReactions: { enabled: false, emojiTier: "unicode", timing: { debounceMs: 700, holdDoneMs: 3000, holdErrorMs: 5000, stallSoftMs: 15000, stallHardMs: 30000 }, perChannel: {} },
    },
    secretManager: { get: vi.fn(() => { throw new Error("not found"); }) },
    eventBus: {
      on: vi.fn((event: string, cb: (...args: any[]) => any) => {
        eventHandlers.push({ event, callback: cb });
      }),
      emit: vi.fn(),
    },
  } as unknown as AppContainer;

  return { container, eventHandlers };
}

function makeDeps(overrides: Partial<ChannelsDeps> & { container?: AppContainer } = {}): ChannelsDeps {
  const { container: containerOverride, ...rest } = overrides;
  const { container } = containerOverride ? { container: containerOverride } : makeContainer();
  return {
    container,
    executors: new Map(),
    defaultAgentId: "agent1",
    sessionManager: { expire: vi.fn(), loadOrCreate: vi.fn(() => []), save: vi.fn() } as any,
    sessionStore: {} as any,
    logger: makeLogger(),
    channelsLogger: makeLogger(),
    linkRunner: { processMessage: vi.fn() } as any,
    ssrfFetcher: { fetch: vi.fn() } as any,
    maxMediaBytes: 10_000_000,
    ...rest,
  };
}

function getCronHandler(container: AppContainer): ((...args: any[]) => any) | undefined {
  const onCalls = vi.mocked(container.eventBus.on).mock.calls;
  const cronCall = onCalls.find((c) => c[0] === "scheduler:job_result");
  return cronCall?.[1] as ((...args: any[]) => any) | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdaptersByType.clear();
  });

  // -- Cron delivery tests --

  describe("cron delivery listener", () => {
    it("delivers systemEvent raw text to adapter", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      expect(cronHandler).toBeDefined();

      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "Scheduled message content",
        jobName: "daily-report",
        payloadKind: undefined,
        jobId: "j1",
        agentId: "agent1",
      });

      expect(mockAdapter.sendMessage).toHaveBeenCalledWith("chat123", "Scheduled message content");
    });

    it("warns and skips when deliveryTarget has no channelType", async () => {
      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelId: "chat123" },
        result: "text",
        jobName: "job1",
      });

      expect(mockAdapter.sendMessage).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "config" }),
        expect.stringContaining("no delivery target channel type"),
      );
    });

    it("warns when adapter not found for channelType", async () => {
      // adaptersByType is empty -- no telegram adapter
      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123" },
        result: "text",
        jobName: "job1",
      });

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "config" }),
        expect.stringContaining("No adapter found"),
      );
    });

    it("executes agentTurn and delivers response", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Agent generated reply",
          tokensUsed: { input: 50, output: 50, total: 100 },
          cost: { total: 0.001 },
          stepsExecuted: 1,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "cron prompt text",
        jobName: "hourly-check",
        payloadKind: "agent_turn",
        jobId: "j2",
        agentId: "agent1",
      });

      expect(mockExecutor.execute).toHaveBeenCalled();
      expect(mockAdapter.sendMessage).toHaveBeenCalledWith("chat123", "Agent generated reply");
    });

    it("suppresses NO_REPLY in agentTurn", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "NO_REPLY",
          tokensUsed: { input: 25, output: 25, total: 50 },
          cost: { total: 0.0005 },
          stepsExecuted: 0,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "prompt",
        jobName: "check",
        payloadKind: "agent_turn",
        jobId: "j3",
        agentId: "agent1",
      });

      expect(mockAdapter.sendMessage).not.toHaveBeenCalled();
    });

    it("suppresses error response when execResult has errorContext", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Something went wrong, try a simpler message",
          errorContext: { errorType: "timeout", originalError: "PromptTimeoutError" },
          tokensUsed: { input: 50, output: 10, total: 60 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);
      const onComplete = vi.fn();

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "cron prompt",
        jobName: "daily-report",
        payloadKind: "agent_turn",
        jobId: "j3",
        agentId: "agent1",
        onComplete,
      });

      expect(mockExecutor.execute).toHaveBeenCalled();
      expect(mockAdapter.sendMessage).not.toHaveBeenCalled();
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ jobName: "daily-report", errorType: "timeout" }),
        "Cron agentTurn error response suppressed",
      );
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    });

    it("falls back to raw text when agentTurn execution fails", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const mockExecutor = {
        execute: vi.fn(async () => { throw new Error("LLM API error"); }),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "fallback raw text",
        jobName: "check",
        payloadKind: "agent_turn",
        jobId: "j4",
        agentId: "agent1",
      });

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "internal" }),
        expect.stringContaining("agentTurn execution failed"),
      );
      expect(mockAdapter.sendMessage).toHaveBeenCalledWith("chat123", "fallback raw text");
    });

    it("fresh strategy calls sessionManager.expire() before executor.execute()", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const expireSpy = vi.fn();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Agent reply",
          tokensUsed: { input: 50, output: 50, total: 100 },
          cost: { total: 0.001 },
          stepsExecuted: 1,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);
      const sessionMgr = {
        expire: expireSpy,
        loadOrCreate: vi.fn(() => []),
        save: vi.fn(),
      };

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors, sessionManager: sessionMgr as any });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "prompt",
        jobName: "fresh-job",
        payloadKind: "agent_turn",
        jobId: "j-fresh",
        agentId: "agent1",
        sessionStrategy: "fresh",
      });

      // expire must be called before execute
      expect(expireSpy).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "cron:j-fresh",
      }));
      expect(mockExecutor.execute).toHaveBeenCalled();
      // Verify expire was called before execute
      expect(expireSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockExecutor.execute.mock.invocationCallOrder[0],
      );
    });

    it("rolling strategy prunes session to maxHistoryTurns after execution", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const saveSpy = vi.fn();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Agent reply",
          tokensUsed: { input: 50, output: 50, total: 100 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);

      // Simulate 5 turns (5 user + 5 assistant messages)
      const messages = [
        { role: "user", content: "turn1" },
        { role: "assistant", content: "reply1" },
        { role: "user", content: "turn2" },
        { role: "assistant", content: "reply2" },
        { role: "user", content: "turn3" },
        { role: "assistant", content: "reply3" },
        { role: "user", content: "turn4" },
        { role: "assistant", content: "reply4" },
        { role: "user", content: "turn5" },
        { role: "assistant", content: "reply5" },
      ];
      const sessionMgr = {
        expire: vi.fn(),
        loadOrCreate: vi.fn(() => messages),
        save: saveSpy,
      };

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors, sessionManager: sessionMgr as any });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "prompt",
        jobName: "rolling-job",
        payloadKind: "agent_turn",
        jobId: "j-rolling",
        agentId: "agent1",
        sessionStrategy: "rolling",
        maxHistoryTurns: 2,
      });

      // Should prune to last 2 turns
      expect(saveSpy).toHaveBeenCalled();
      const savedMessages = saveSpy.mock.calls[0][1] as Array<{ role: string; content: string }>;
      // Last 2 turns = turn4+reply4, turn5+reply5 = 4 messages
      expect(savedMessages.length).toBe(4);
      expect(savedMessages[0].content).toBe("turn4");
    });

    it("accumulate strategy does not manipulate session", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const expireSpy = vi.fn();
      const saveSpy = vi.fn();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Agent reply",
          tokensUsed: { input: 50, output: 50, total: 100 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);
      const sessionMgr = {
        expire: expireSpy,
        loadOrCreate: vi.fn(() => []),
        save: saveSpy,
      };

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors, sessionManager: sessionMgr as any });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "prompt",
        jobName: "accum-job",
        payloadKind: "agent_turn",
        jobId: "j-accum",
        agentId: "agent1",
        sessionStrategy: "accumulate",
      });

      expect(expireSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it("default session strategy is fresh for isolated jobs", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const expireSpy = vi.fn();
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Agent reply",
          tokensUsed: { input: 50, output: 50, total: 100 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);
      const sessionMgr = {
        expire: expireSpy,
        loadOrCreate: vi.fn(() => []),
        save: vi.fn(),
      };

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors, sessionManager: sessionMgr as any });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "prompt",
        jobName: "default-job",
        payloadKind: "agent_turn",
        jobId: "j-default",
        agentId: "agent1",
        // sessionStrategy omitted -- should default to "fresh"
      });

      expect(expireSpy).toHaveBeenCalled();
    });

    it("enriched completion log includes totalTokens, costUsd, toolCalls, llmCalls", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const mockExecutor = {
        execute: vi.fn(async () => ({
          response: "Agent reply",
          tokensUsed: { input: 200, output: 100, total: 300 },
          cost: { total: 0.0045 },
          stepsExecuted: 3,
          llmCalls: 2,
        })),
      };
      const executors = new Map([["agent1", mockExecutor as any]]);

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "prompt",
        jobName: "metrics-job",
        payloadKind: "agent_turn",
        jobId: "j-metrics",
        agentId: "agent1",
      });

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTokens: 300,
          costUsd: 0.0045,
          toolCalls: 3,
          llmCalls: 2,
        }),
        "Cron agentTurn execution complete",
      );
    });

    // -----------------------------------------------------------------------
    // Cron agentTurn model resolution
    // -----------------------------------------------------------------------

    describe("cron agentTurn model resolution", () => {
      it("passes cron overrides with operationType 'cron' to executor", async () => {
        mockAdaptersByType.set("telegram", mockAdapter);
        const mockExecutor = {
          execute: vi.fn(async () => ({
            response: "Agent reply",
            tokensUsed: { input: 50, output: 50, total: 100 },
            cost: { total: 0.001 },
            stepsExecuted: 0,
            llmCalls: 1,
          })),
        };
        const executors = new Map([["agent1", mockExecutor as any]]);

        const { container, eventHandlers } = makeContainer();
        const deps = makeDeps({ container, executors });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!({
          deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
          result: "cron prompt",
          jobName: "model-test",
          payloadKind: "agent_turn",
          jobId: "j-model",
          agentId: "agent1",
        });

        expect(mockExecutor.execute).toHaveBeenCalled();
        const overridesArg = mockExecutor.execute.mock.calls[0]![7];
        expect(overridesArg).toBeDefined();
        expect(overridesArg.operationType).toBe("cron");
        expect(overridesArg.model).toBe("anthropic:claude-haiku-4-5-20251001");
      });

      it("passes promptTimeout from resolution to executor overrides", async () => {
        mockAdaptersByType.set("telegram", mockAdapter);
        const mockExecutor = {
          execute: vi.fn(async () => ({
            response: "reply",
            tokensUsed: { input: 50, output: 50, total: 100 },
            cost: { total: 0.001 },
            stepsExecuted: 0,
            llmCalls: 1,
          })),
        };
        const executors = new Map([["agent1", mockExecutor as any]]);

        const { container, eventHandlers } = makeContainer();
        const deps = makeDeps({ container, executors });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!({
          deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
          result: "prompt",
          jobName: "timeout-test",
          payloadKind: "agent_turn",
          jobId: "j-timeout",
          agentId: "agent1",
        });

        const overridesArg = mockExecutor.execute.mock.calls[0]![7];
        expect(overridesArg.promptTimeout).toEqual({ promptTimeoutMs: 150_000 });
      });

      it("passes cronJobModel as invocationOverride to resolveOperationModel", async () => {
        mockAdaptersByType.set("telegram", mockAdapter);
        const mockExecutor = {
          execute: vi.fn(async () => ({
            response: "reply",
            tokensUsed: { input: 50, output: 50, total: 100 },
            cost: { total: 0.001 },
            stepsExecuted: 0,
            llmCalls: 1,
          })),
        };
        const executors = new Map([["agent1", mockExecutor as any]]);

        const { container, eventHandlers } = makeContainer();
        const deps = makeDeps({ container, executors });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!({
          deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
          result: "prompt",
          jobName: "override-test",
          payloadKind: "agent_turn",
          jobId: "j-override",
          agentId: "agent1",
          cronJobModel: "anthropic:claude-opus-4-20250514",
        });

        expect(mockResolveOperationModel).toHaveBeenCalledWith(
          expect.objectContaining({
            operationType: "cron",
            invocationOverride: "anthropic:claude-opus-4-20250514",
          }),
        );
      });

      it("executes without overrides when agent config is missing", async () => {
        mockAdaptersByType.set("telegram", mockAdapter);
        const mockExecutor = {
          execute: vi.fn(async () => ({
            response: "reply",
            tokensUsed: { input: 50, output: 50, total: 100 },
            cost: { total: 0.001 },
            stepsExecuted: 0,
            llmCalls: 1,
          })),
        };
        // Register executor under "agent1" (default) so it resolves for unknown-agent
        const executors = new Map([["agent1", mockExecutor as any]]);

        const { container, eventHandlers } = makeContainer();
        const deps = makeDeps({ container, executors });
        await setupChannels(deps);

        mockResolveOperationModel.mockClear();

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!({
          deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
          result: "prompt",
          jobName: "missing-agent-test",
          payloadKind: "agent_turn",
          jobId: "j-missing",
          agentId: "unknown-agent",
        });

        // resolveOperationModel should NOT be called when agent config is missing
        expect(mockResolveOperationModel).not.toHaveBeenCalled();
        // Executor still called, but 8th arg is undefined (no overrides)
        expect(mockExecutor.execute).toHaveBeenCalled();
        const overridesArg = mockExecutor.execute.mock.calls[0]![7];
        expect(overridesArg).toBeUndefined();
      });

      it("system_event payloadKind does NOT trigger resolveOperationModel", async () => {
        mockAdaptersByType.set("telegram", mockAdapter);
        const { container, eventHandlers } = makeContainer();
        const deps = makeDeps({ container });
        await setupChannels(deps);

        mockResolveOperationModel.mockClear();

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!({
          deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
          result: "system text",
          jobName: "sys-event-test",
          payloadKind: "system_event",
          jobId: "j-sys",
          agentId: "agent1",
        });

        // system_event goes through the raw text delivery path, no resolver call
        expect(mockResolveOperationModel).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Memory review sentinel interception
    // -----------------------------------------------------------------------

    describe("memory review sentinel (__MEMORY_REVIEW__)", () => {
      it("intercepts __MEMORY_REVIEW__ and calls runMemoryReview", async () => {
        mockRunMemoryReview.mockResolvedValueOnce({ ok: true as const, value: undefined });
        const { container, eventHandlers } = makeContainer();
        // Enable memoryReview for agent1
        (container.config.agents as any).agent1.memoryReview = { enabled: true, schedule: "0 2 * * *", minMessages: 5, maxSessionsPerRun: 10, maxReviewTokens: 4096, dedupThreshold: 0.85, autoTags: [] };
        (container.secretManager.get as any) = vi.fn((key: string) => key === "ANTHROPIC_API_KEY" ? "test-key" : undefined);
        const deps = makeDeps({
          container,
          memoryAdapter: { search: vi.fn(), store: vi.fn() } as any,
          sessionStore: { listDetailed: vi.fn(() => []), loadByFormattedKey: vi.fn() } as any,
          workspaceDirs: new Map([["agent1", "/tmp/test-workspace"]]),
          tenantId: "default",
        });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        const onComplete = vi.fn();
        await cronHandler!({
          result: "__MEMORY_REVIEW__",
          agentId: "agent1",
          jobId: "memory-review-agent1",
          jobName: "Memory review",
          onComplete,
        });

        expect(mockRunMemoryReview).toHaveBeenCalledWith(expect.objectContaining({
          agentId: "agent1",
          provider: "anthropic",
          apiKey: "test-key",
        }));
        expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
        // Should NOT fall through to standard delivery
        expect(mockAdapter.sendMessage).not.toHaveBeenCalled();
      });

      it("skips memory review when memoryReview.enabled is false", async () => {
        const { container, eventHandlers } = makeContainer();
        // memoryReview disabled (default undefined)
        const deps = makeDeps({ container });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        const onComplete = vi.fn();
        await cronHandler!({
          result: "__MEMORY_REVIEW__",
          agentId: "agent1",
          jobId: "memory-review-agent1",
          jobName: "Memory review",
          onComplete,
        });

        expect(mockRunMemoryReview).not.toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
      });

      it("skips memory review when no API key available", async () => {
        const { container, eventHandlers } = makeContainer();
        (container.config.agents as any).agent1.memoryReview = { enabled: true, schedule: "0 2 * * *", minMessages: 5, maxSessionsPerRun: 10, maxReviewTokens: 4096, dedupThreshold: 0.85, autoTags: [] };
        // secretManager.get returns undefined for all keys
        (container.secretManager.get as any) = vi.fn(() => undefined);
        const deps = makeDeps({ container });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        const onComplete = vi.fn();
        await cronHandler!({
          result: "__MEMORY_REVIEW__",
          agentId: "agent1",
          jobId: "memory-review-agent1",
          jobName: "Memory review",
          onComplete,
        });

        expect(mockRunMemoryReview).not.toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
      });

      it("skips memory review when no agentId", async () => {
        const { container, eventHandlers } = makeContainer();
        const deps = makeDeps({ container });
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        const onComplete = vi.fn();
        await cronHandler!({
          result: "__MEMORY_REVIEW__",
          jobId: "memory-review-unknown",
          jobName: "Memory review",
          onComplete,
        });

        expect(mockRunMemoryReview).not.toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
      });
    });

    it("sends raw text fallback when no executor found for agentTurn", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      // executors map is empty -- no executor for "unknown-agent" or default
      const executors = new Map() as Map<string, any>;

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors });
      await setupChannels(deps);

      const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
      await cronHandler!({
        deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
        result: "raw fallback",
        jobName: "check",
        payloadKind: "agent_turn",
        jobId: "j5",
        agentId: "unknown-agent",
      });

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "config" }),
        expect.stringContaining("No executor found"),
      );
      expect(mockAdapter.sendMessage).toHaveBeenCalledWith("chat123", "raw fallback");
    });
  });

  // -- ChannelManager creation tests --

  describe("ChannelManager lifecycle", () => {
    it("creates and starts ChannelManager when adapters present", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const { container } = makeContainer();
      const deps = makeDeps({ container });
      const result = await setupChannels(deps);

      expect(createChannelManager).toHaveBeenCalled();
      expect(mockChannelManager.startAll).toHaveBeenCalled();
      expect(result.channelManager).toBe(mockChannelManager);
    });

    it("does not create ChannelManager when no adapters", async () => {
      // adaptersByType is empty
      const { container } = makeContainer();
      const deps = makeDeps({ container });
      const result = await setupChannels(deps);

      expect(createChannelManager).not.toHaveBeenCalled();
      expect(result.channelManager).toBeUndefined();
    });
  });
});
