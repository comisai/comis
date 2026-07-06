// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContainer, ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdaptersByType = new Map<string, ChannelPort>();
const mockAdapter = { sendMessage: vi.fn(async () => ({ ok: true })) } as unknown as ChannelPort;

vi.mock("../setup-channels-adapters.js", () => ({
  bootstrapAdapters: vi.fn(async () => ({
    adaptersByType: mockAdaptersByType,
    tgPlugin: undefined,
    linePlugin: undefined,
    channelPlugins: new Map(),
  })),
}));

vi.mock("../setup-channels-media.js", () => ({
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
vi.mock("@comis/channels", () => ({
  createLifecycleReactor: vi.fn(() => ({ destroy: vi.fn() })),
  reactWithFallback: vi.fn(),
  // Activity-renderer factories consumed by buildActivityRenderers.
  // The *_RENDERER_FACTORIES consts in setup-channels-activity-renderers.ts
  // reference every per-channel factory at MODULE LOAD (EditPlace + the four
  // non-EditPlace strategy maps), so this explicit
  // (non-importOriginal) mock must expose them all or import-time collection fails.
  createTestSink: vi.fn(() => ({ strategy: "TestSink", apply: vi.fn(), finalize: vi.fn() })),
  createTelegramActivityRenderer: vi.fn(() => ({ strategy: "EditPlace", apply: vi.fn(), finalize: vi.fn() })),
  createDiscordActivityRenderer: vi.fn(() => ({ strategy: "EditPlace", apply: vi.fn(), finalize: vi.fn() })),
  createSlackActivityRenderer: vi.fn(() => ({ strategy: "EditPlace", apply: vi.fn(), finalize: vi.fn() })),
  createWhatsAppActivityRenderer: vi.fn(() => ({ strategy: "EditPlace", apply: vi.fn(), finalize: vi.fn() })),
  createMSTeamsActivityRenderer: vi.fn(() => ({ strategy: "EditPlace", apply: vi.fn(), finalize: vi.fn() })),
  createGoogleChatActivityRenderer: vi.fn(() => ({ strategy: "EditPlace", apply: vi.fn(), finalize: vi.fn() })),
  createSignalActivityRenderer: vi.fn(() => ({ strategy: "DeleteAndRepost", apply: vi.fn(), finalize: vi.fn() })),
  createIMessageActivityRenderer: vi.fn(() => ({ strategy: "AppendOnly", apply: vi.fn(), finalize: vi.fn() })),
  createLineActivityRenderer: vi.fn(() => ({ strategy: "AppendOnly", apply: vi.fn(), finalize: vi.fn() })),
  createIrcActivityRenderer: vi.fn(() => ({ strategy: "LinePerEvent", apply: vi.fn(), finalize: vi.fn() })),
  createEmailActivityRenderer: vi.fn(() => ({ strategy: "DigestOnly", apply: vi.fn(), finalize: vi.fn() })),
  filterResponse: vi.fn((text: string) => {
    if (text === "NO_REPLY" || text === "HEARTBEAT_OK" || !text) {
      return { shouldDeliver: false, cleanedText: "", suppressedBy: text === "NO_REPLY" ? "no_reply" : text === "HEARTBEAT_OK" ? "heartbeat_ok" : "empty" };
    }
    return { shouldDeliver: true, cleanedText: text };
  }),
  // deliverToChannel is no longer imported from @comis/channels by
  // setup-channels.ts production code — the cron-delivery callsites use
  // deliveryService.deliverToChannel(). The mocked DeliveryService below
  // delegates to adapter.sendMessage so the existing assertions remain valid.
  // createChannelManager lives in @comis/orchestrator (mocked below in its own
  // vi.mock block).
}));

// orchestrator owns createChannelManager + processInboundMessage,
// createMessageRouter, and createCommandQueue. The mocked createChannelManager
// preserves the call-assertion pattern; the mocked processInboundMessage is
// never invoked at call-time because createChannelManager returns the static
// mockChannelManager.
vi.mock("@comis/orchestrator", () => ({
  createChannelManager: vi.fn(() => mockChannelManager),
  processInboundMessage: vi.fn(async () => {}),
  createMessageRouter: vi.fn(() => ({ resolve: vi.fn() })),
  createCommandQueue: vi.fn(() => ({})),
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
  // createMessageRouter and createCommandQueue moved to @comis/orchestrator
  // (mocked above).
  sanitizeAssistantResponse: vi.fn((text: string) => text),
  resolveOperationModel: (...args: unknown[]) => mockResolveOperationModel(...args),
  resolveProviderFamily: vi.fn((p: string) => p),
  runMemoryReview: (...args: unknown[]) => mockRunMemoryReview(...args),
  // The __MEMORY_REVIEW__ branch derives the capabilityClass via
  // resolveModelProfile (capability axis only: provider family + override).
  resolveModelProfile: vi.fn((model: { provider: string }, override?: string) => {
    let capabilityClass = override;
    if (capabilityClass === undefined) {
      const p = model.provider;
      capabilityClass = p === "anthropic" || p === "openai" ? "frontier" : p === "google" ? "mid" : "small";
    }
    return { capabilityClass };
  }),
}));

vi.mock("@comis/core", async () => {
  // Production setupChannels imports createDeliveryService and
  // createNoOpDeliveryQueue from @comis/core; the fake mirrors the
  // previously-mocked deliverToChannel behavior (delegate to
  // adapter.sendMessage) so existing assertions keep working.
  return {
    formatSessionKey: vi.fn((sk: SessionKey) => `${sk.tenantId}:${sk.userId}:${sk.channelId}`),
    runWithContext: vi.fn(async (_ctx: any, fn: () => any) => fn()),
    // credentials.ts (memory-review gate) consults the keyless
    // allowlist + sentinel; mirror the real @comis/core values so the partial
    // mock resolves them (anthropic provider here is non-keyless → still skips).
    KEYLESS_PROVIDER_TYPES: new Set(["ollama", "lm-studio"]),
    KEYLESS_API_KEY_SENTINEL: "ollama-no-auth",
    createDeliveryOrigin: vi.fn((input: any) => Object.freeze({ ...input })),
    safePath: vi.fn((base: string, ...segs: string[]) => [base, ...segs].join("/")),
    RetryConfigSchema: { parse: vi.fn(() => ({ maxAttempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: true, respectRetryAfter: true, markdownFallback: true })) },
    // createRetryEngine + initTelegramFileGuardConfig live in @comis/core
    // (alongside the delivery helpers).
    createRetryEngine: vi.fn(() => mockRetryEngine),
    initTelegramFileGuardConfig: vi.fn(),
    // DeliveryService factory + no-op queue used by the composition root.
    createDeliveryService: vi.fn(() => ({
      deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string) => {
        await adapter.sendMessage(channelId, text);
        return { ok: true, value: { ok: true, totalChunks: 1, deliveredChunks: 1, failedChunks: 0, chunks: [{ ok: true, messageId: "m1", charCount: text.length, retried: false }], totalChars: text.length } };
      }),
      drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
    })),
    createNoOpDeliveryQueue: vi.fn(() => ({})),
    systemNowMs: () => Date.now(),
    systemNowDate: () => new Date(),
    // setupChannels resolves the default agent's activity.theme →
    // themeForName(name).markers for the activity renderers. The fake
    // returns the default-theme marker bundle so the resolved markers stay
    // default-parity in these wiring tests.
    themeForName: vi.fn(() => ({
      markers: { success: "✓", failure: "❌", subagent: "🤖", running: "🔧" },
    })),
  };
});

vi.mock("@comis/skills", () => ({
  shouldAutoTts: vi.fn(),
  resolveOutputFormat: vi.fn(),
  parseOutboundMedia: vi.fn(),
  // Passthrough: return all tools and empty filtered list (no policy applied).
  // Individual tests that want to assert policy filtering can override this.
  applyToolPolicy: vi.fn((tools: unknown[]) => ({ tools, filtered: [] })),
}));

import { setupChannels, type ChannelsDeps } from "./index.js";
import { bootstrapAdapters } from "../setup-channels-adapters.js";
// createChannelManager lives in @comis/orchestrator (alongside channel-manager.ts).
import { createChannelManager } from "@comis/orchestrator";

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
    // setup-channels constructs DeliveryService via
    // createDeliveryService({ hookRunner: container.hookRunner, ... }). Mocked
    // here so the composition-root construction step doesn't blow up.
    hookRunner: { runBeforeDelivery: vi.fn(), runAfterDelivery: vi.fn() },
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

    it("passes isCronAgentTurn metadata (not isScheduled) to executor", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
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

      const syntheticMsg = mockExecutor.execute.mock.calls[0][0];
      expect(syntheticMsg.metadata.isCronAgentTurn).toBe(true);
      expect(syntheticMsg.metadata.isScheduled).toBeUndefined();
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

    it("fresh strategy calls sessionManager.expire() and destroySession before executor.execute()", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const expireSpy = vi.fn();
      const destroySessionSpy = vi.fn(async () => {});
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
      const piSessionAdapters = new Map([["agent1", {
        getSessionStats: vi.fn(),
        destroySession: destroySessionSpy,
      }]]);

      const { container, eventHandlers } = makeContainer();
      const deps = makeDeps({ container, executors, sessionManager: sessionMgr as any, piSessionAdapters: piSessionAdapters as any });
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

      const expectedSessionKey = expect.objectContaining({ channelId: "cron:j-fresh" });

      // expire must be called before execute
      expect(expireSpy).toHaveBeenCalledWith(expectedSessionKey);
      expect(mockExecutor.execute).toHaveBeenCalled();
      expect(expireSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockExecutor.execute.mock.invocationCallOrder[0],
      );

      // destroySession must be called on piSessionAdapter
      expect(destroySessionSpy).toHaveBeenCalledWith(expectedSessionKey);
      expect(destroySessionSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockExecutor.execute.mock.invocationCallOrder[0],
      );

      // session:expired event must be emitted with reason "cron-fresh"
      expect(container.eventBus.emit).toHaveBeenCalledWith("session:expired", {
        sessionKey: expectedSessionKey,
        reason: "cron-fresh",
      });
    });

    it("fresh strategy warns when piSessionAdapter is missing", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
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
        expire: vi.fn(),
        loadOrCreate: vi.fn(() => []),
        save: vi.fn(),
      };
      // Empty piSessionAdapters -- no adapter for agent1
      const piSessionAdapters = new Map() as any;

      const { container, eventHandlers } = makeContainer();
      const logger = makeLogger();
      const deps = makeDeps({ container, executors, sessionManager: sessionMgr as any, piSessionAdapters, logger });
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

      // Execution should still proceed
      expect(mockExecutor.execute).toHaveBeenCalled();

      // session:expired should still be emitted
      expect(container.eventBus.emit).toHaveBeenCalledWith("session:expired", expect.objectContaining({
        reason: "cron-fresh",
      }));
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
    // Cadence-aware cache-waste warn
    //
    // Guard fires only for kind: "every" jobs (where cadenceMs is a literal
    // number from the schedule). cron-expression and one-shot "at" schedules
    // emit cadenceMs: undefined and are out of scope for this guard.
    // -----------------------------------------------------------------------

    describe("cadence-aware cache-waste warn", () => {
      function makeBaseAgentTurnPayload(
        overrides: Record<string, unknown> = {},
      ): Record<string, unknown> {
        return {
          deliveryTarget: { channelType: "telegram", channelId: "chat123", tenantId: "t1", userId: "u1" },
          result: "prompt",
          jobName: "cadence-test-job",
          payloadKind: "agent_turn",
          jobId: "j-cadence",
          agentId: "agent1",
          ...overrides,
        };
      }

      function makeCadenceTestDeps() {
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
        return { deps, container, eventHandlers };
      }

      function findCadenceWarn(loggerWarn: ReturnType<typeof vi.fn>) {
        return loggerWarn.mock.calls.find((args) => {
          const ctx = args[0] as { hint?: string } | undefined;
          return typeof ctx?.hint === "string" && ctx.hint.includes("Cadence exceeds cache TTL");
        });
      }

      it("warns when sessionStrategy is 'rolling' AND cadenceMs > 600_000", async () => {
        const { deps, eventHandlers } = makeCadenceTestDeps();
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!(makeBaseAgentTurnPayload({
          sessionStrategy: "rolling",
          cadenceMs: 900_000, // 15 min — well above the 10-min threshold
        }));

        const warnCall = findCadenceWarn(deps.logger.warn as ReturnType<typeof vi.fn>);
        expect(warnCall).toBeDefined();
        expect(warnCall![0]).toMatchObject({
          jobName: "cadence-test-job",
          agentId: "agent1",
          sessionStrategy: "rolling",
          cadenceMs: 900_000,
          errorKind: "config",
        });
        expect(warnCall![1]).toBe("Cron sessionStrategy may waste cache writes at this cadence");
      });

      it("warns when sessionStrategy is 'accumulate' AND cadenceMs > 600_000", async () => {
        const { deps, eventHandlers } = makeCadenceTestDeps();
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!(makeBaseAgentTurnPayload({
          sessionStrategy: "accumulate",
          cadenceMs: 1_800_000, // 30 min
        }));

        const warnCall = findCadenceWarn(deps.logger.warn as ReturnType<typeof vi.fn>);
        expect(warnCall).toBeDefined();
        expect(warnCall![0]).toMatchObject({
          sessionStrategy: "accumulate",
          cadenceMs: 1_800_000,
          errorKind: "config",
        });
        expect((warnCall![0] as { hint: string }).hint).toContain("Cadence exceeds cache TTL");
      });

      it("does NOT warn when sessionStrategy is 'fresh' regardless of cadenceMs", async () => {
        const { deps, eventHandlers } = makeCadenceTestDeps();
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!(makeBaseAgentTurnPayload({
          sessionStrategy: "fresh",
          cadenceMs: 3_600_000, // 1 hour — well above threshold but fresh is safe
        }));

        const warnCall = findCadenceWarn(deps.logger.warn as ReturnType<typeof vi.fn>);
        expect(warnCall).toBeUndefined();
      });

      it("does NOT warn when cadenceMs is undefined (cron-expression schedule)", async () => {
        const { deps, eventHandlers } = makeCadenceTestDeps();
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!(makeBaseAgentTurnPayload({
          sessionStrategy: "rolling",
          cadenceMs: undefined,
        }));

        const warnCall = findCadenceWarn(deps.logger.warn as ReturnType<typeof vi.fn>);
        expect(warnCall).toBeUndefined();
      });

      it("does NOT warn when cadenceMs is exactly at the 600_000 threshold", async () => {
        const { deps, eventHandlers } = makeCadenceTestDeps();
        await setupChannels(deps);

        const cronHandler = eventHandlers.find((h) => h.event === "scheduler:job_result")?.callback;
        await cronHandler!(makeBaseAgentTurnPayload({
          sessionStrategy: "rolling",
          cadenceMs: 600_000, // exactly 10 min — guard uses strict >, so no warn
        }));

        const warnCall = findCadenceWarn(deps.logger.warn as ReturnType<typeof vi.fn>);
        expect(warnCall).toBeUndefined();
      });
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

  // -- interactive-callback router threaded to the inbound pipeline --
  //
  // The InteractiveCallbackRouter is constructed in the daemon wiring bundle
  // (createInteractiveCallbackWiring → .router) but must reach the orchestrator's
  // inbound pipeline (inbound-gate reads `deps.interactiveCallbackRouter`). The
  // ONLY way it gets there is through the production composition path:
  //   ChannelsDeps.interactiveCallbackRouter
  //     → buildAndStartChannelManager (ChannelManagerBuildDeps.interactiveCallbackRouter)
  //       → createChannelManager({ interactiveCallbackRouter })
  //         → pipelineDeps = deps → inbound-gate.
  //
  // Because every layer types the slot OPTIONAL, a missing thread compiles and
  // silently no-ops: at runtime `deps.interactiveCallbackRouter === undefined`,
  // the button-callback intercept is dead, and a signed `v1.<choice>.<shortId>.<hmac>`
  // payload falls through to the LLM. This is the exact blind spot that let the
  // unthreaded router ship — there was no assertion that the daemon POPULATES the
  // slot. These tests pin the seam end-to-end at the real daemon composition layer.
  describe("interactive-callback router wiring", () => {
    it("threads the wiring router into createChannelManager so the inbound button-intercept is reachable", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const router = { route: vi.fn(), render: vi.fn() } as any;
      const { container } = makeContainer();
      const deps = makeDeps({ container, interactiveCallbackRouter: router });
      await setupChannels(deps);

      expect(createChannelManager).toHaveBeenCalledTimes(1);
      const cmDeps = vi.mocked(createChannelManager).mock.calls[0]![0]!;
      // The SAME router instance the daemon constructed must reach the pipeline
      // deps — not undefined (the pre-fix state that severed the chain).
      expect(cmDeps.interactiveCallbackRouter).toBe(router);
    });

    it("leaves the router slot undefined when the daemon supplies no wiring (button callbacks degrade, not crash)", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const { container } = makeContainer();
      const deps = makeDeps({ container }); // no interactiveCallbackRouter
      await setupChannels(deps);

      const cmDeps = vi.mocked(createChannelManager).mock.calls[0]![0]!;
      expect(cmDeps.interactiveCallbackRouter).toBeUndefined();
    });
  });

  // -- googlechat webhook ingress thread-out --
  //
  // The gateway phase mounts /channels/googlechat only when bootstrapAdapters
  // built a caller-backed ingress (webhook mode). setupChannels must FORWARD that
  // ingress in its result so the composition root can thread it into the gateway
  // deps — mirroring msTeamsIngress. A missing thread silently severs the mount.
  describe("googlechat webhook ingress thread-out", () => {
    it("forwards the googlechat ingress built by bootstrapAdapters into the setupChannels result", async () => {
      const googlechatIngress = { __googlechatIngress: true };
      vi.mocked(bootstrapAdapters).mockResolvedValueOnce({
        adaptersByType: mockAdaptersByType,
        tgPlugin: undefined,
        linePlugin: undefined,
        channelPlugins: new Map(),
        googlechatIngress,
      } as any);
      const { container } = makeContainer();
      const deps = makeDeps({ container });
      const result = await setupChannels(deps);

      expect(result.googlechatIngress).toBe(googlechatIngress);
    });
  });
});
