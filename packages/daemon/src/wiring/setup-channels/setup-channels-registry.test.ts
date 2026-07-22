// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithContext, type AppContainer, type ChannelPort, type NormalizedMessage, type SessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { ok } from "@comis/shared";

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
vi.mock("@comis/orchestrator", async (importOriginal) => ({
  ...await importOriginal<typeof import("@comis/orchestrator")>(),
  createChannelManager: vi.fn(() => mockChannelManager),
  processInboundMessage: vi.fn(async () => {}),
  createMessageRouter: vi.fn(() => ({ resolve: vi.fn() })),
  createCommandQueue: vi.fn(() => ({})),
  parseSlashCommand: vi.fn((text: string) => ({
    found: text.startsWith("/"),
    command: text.slice(1).split(" ")[0],
    args: [],
    cleanedText: "",
  })),
  createCommandHandler: vi.fn((deps: { destroySession: (key: SessionKey) => void }) => ({
    handle: (_parsed: unknown, key: SessionKey) => {
      deps.destroySession(key);
      return { handled: true, response: "New session created.", directives: { newSession: true } };
    },
  })),
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

vi.mock("@comis/core", async (importOriginal) => {
  // Production setupChannels imports createDeliveryService and
  // createNoOpDeliveryQueue from @comis/core; the fake mirrors the
  // previously-mocked deliverToChannel behavior (delegate to
  // adapter.sendMessage) so existing assertions keep working.
  return {
    ...await importOriginal<typeof import("@comis/core")>(),
    formatSessionKey: vi.fn((sk: SessionKey) => `${sk.tenantId}:${sk.userId}:${sk.channelId}`),
    createResolvedRequestContext: vi.fn((input: Record<string, unknown>) => ({
      ok: true as const,
      value: input,
    })),
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
    toSafeErrorLogString: vi.fn((error: Error) => error.message),
    systemNowMs: () => Date.now(),
    systemNowDate: () => new Date(),
    // isInQuietHours (via the cron quiet-hours gate) converts an epoch ms to a
    // Date through this helper; the partial mock must provide it or the gate
    // throws and fails open. Delegates to the real from-value Date construction.
    systemDateFrom: (v: number | string) => new Date(v),
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
      // The cron delivery listener reads scheduler.quietHours to gate off-hours
      // pings. Disabled here so delivery proceeds normally in these tests (the schema
      // always provides this block in production via SchedulerConfigSchema.default).
      scheduler: { quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC", criticalBypass: false } },
    },
    secretManager: { get: vi.fn(() => { throw new Error("not found"); }) },
    eventBus: {
      on: vi.fn((event: string, cb: (...args: any[]) => any) => {
        eventHandlers.push({ event, callback: cb });
      }),
      emit: vi.fn(),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
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
    dataDir: "/tmp/comis-channel-test",
    executors: new Map(),
    defaultAgentId: "agent1",
    sessionManager: {
      expire: vi.fn(() => ok(undefined)),
      loadOrCreate: vi.fn(() => ok([])),
      save: vi.fn(() => ok(undefined)),
    } as any,
    sessionStore: {} as any,
    logger: makeLogger(),
    channelsLogger: makeLogger(),
    linkRunner: { processMessage: vi.fn() } as any,
    ssrfFetcher: { fetch: vi.fn() } as any,
    maxMediaBytes: 10_000_000,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdaptersByType.clear();
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

    it("threads the configured tenant into the channel manager", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const { container } = makeContainer();
      container.config.tenantId = "tenant-production";

      await setupChannels(makeDeps({ container }));

      expect(createChannelManager).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createChannelManager).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ tenantId: "tenant-production" }),
      );
    });

    it("binds resolved inbound persistence to the matching per-agent session adapter", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const persistInboundMessage = vi.fn(async () => ({
        ok: true as const,
        value: { payloads: [], ledgerContent: "" },
      }));
      const piSessionAdapters = new Map([[
        "agent1",
        {
          getSessionStats: vi.fn(),
          destroySession: vi.fn(async () => undefined),
          persistInboundMessage,
        },
      ]]);
      const { container } = makeContainer();
      const deps = makeDeps({
        container,
        piSessionAdapters,
        clock: { now: () => 1_789_000_100_000 } as never,
      });
      await setupChannels(deps);
      const cmDeps = vi.mocked(createChannelManager).mock.calls[0]![0]!;
      const message = {
        id: "11111111-1111-4111-8111-111111111111",
        channelId: "chat-1",
        channelType: "telegram",
        senderId: "user_a",
        text: "persist me",
        timestamp: 1_789_000_000_000,
        attachments: [],
        metadata: {},
      } satisfies NormalizedMessage;
      const sessionKey: SessionKey = {
        tenantId: "default",
        userId: "user_a",
        channelId: "chat-1",
        agentId: "agent1",
      };

      const result = await cmDeps.persistInboundMessage(
        "agent1",
        message,
        sessionKey,
      );

      expect(result).toEqual({
        ok: true,
        value: { payloads: [], ledgerContent: "" },
      });
      expect(persistInboundMessage).toHaveBeenCalledWith(
        sessionKey,
        message,
        1_789_000_100_000,
      );
    });

    it("rejects a channel reset when durable conversation destruction fails", async () => {
      mockAdaptersByType.set("telegram", mockAdapter);
      const destroyError = new Error("conversation storage refused reset");
      const destroyConversation = vi.fn(async () => Promise.reject(destroyError));
      const { container } = makeContainer();
      await setupChannels(makeDeps({
        container,
        destroyConversation,
        clock: { now: () => 1_789_000_100_000 } as never,
      }));
      const cmDeps = vi.mocked(createChannelManager).mock.calls[0]![0]!;
      const sessionKey: SessionKey = {
        tenantId: "default",
        userId: "user_a",
        channelId: "chat-1",
        agentId: "agent1",
      };

      const turnScope = {
        conversation: { tenantId: "default", agentId: "agent1", partition: { kind: "agent" as const } },
        principal: { principalId: "user_a" },
        endpoint: {
          channelType: "telegram",
          channelInstanceId: "test-instance",
          conversationId: "chat-1",
          conversationKind: "direct" as const,
        },
      };
      await expect(runWithContext({
        tenantId: "default",
        userId: "user_a",
        agentId: "agent1",
        sessionKey: "default:agent:agent1:user_a:chat-1",
        turnScope,
        traceId: crypto.randomUUID(),
        startedAt: 1_789_000_100_000,
        trustLevel: "user",
      }, () => cmDeps.handleSlashCommand?.("/new", sessionKey, "agent1")))
        .rejects.toBe(destroyError);

      expect(container.eventBus.emit).not.toHaveBeenCalledWith(
        "session:expired",
        expect.objectContaining({ reason: "chat-reset" }),
      );
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
});
