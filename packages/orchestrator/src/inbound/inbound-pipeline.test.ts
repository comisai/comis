// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import { createDeterministicLocalization } from "../localization/deterministic-localization.js";
import type { ApprovalRequest, ChannelPort, NormalizedMessage, DeliveryService, RequestContext } from "@comis/core";
import { createConversationRef, formatSessionKey, runWithContext, tryGetContext } from "@comis/core";
import { ok } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

import {
  matchesResetTrigger,
  processInboundMessage as processInboundMessageWithoutScope,
} from "./inbound-pipeline.js";

/** Unit tests enter through the same unresolved ingress boundary as adapters. */
async function processInboundMessage(
  ...args: Parameters<typeof processInboundMessageWithoutScope>
): Promise<void> {
  if (tryGetContext() !== undefined) {
    return processInboundMessageWithoutScope(...args);
  }
  const adapter = args[1];
  return runWithContext({
    traceId: randomUUID(),
    startedAt: Date.now(),
    channelType: adapter.channelType,
    tenantId: "default",
    trustLevel: "user",
  }, () => processInboundMessageWithoutScope(...args));
}

// DeliveryService is injected as a per-test fake (rather than via
// vi.mock("./deliver-to-channel.js")). The fake's deliverToChannel delegates
// to adapter.sendMessage so existing assertions on adapter.sendMessage still
// work (avoids formatForChannel HTML conversion). This matches the production
// DI shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake
function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string) => {
      await adapter.sendMessage(channelId, text);
      return ok({
        chunks: [{ status: "accepted" as const, messageId: "m1", charCount: text.length, retried: false }],
        totalChars: text.length,
        platform: { status: "accepted" as const, deliveredChunks: 1, settledAtMs: 2_000, lastMessageId: "m1" },
        queueDisposition: "settled" as const,
      });
    }),
    // DeliveryService provides drainInFlight(). Default fake returns empty
    // drain telemetry; tests that exercise drain semantics override this field.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

// ---------------------------------------------------------------------------
// matchesResetTrigger -- ReDoS guard integration
// ---------------------------------------------------------------------------

describe("matchesResetTrigger", () => {
  it("matches literal trigger (case-insensitive)", () => {
    expect(matchesResetTrigger("reset", ["reset"])).toBe(true);
    expect(matchesResetTrigger("RESET", ["reset"])).toBe(true);
    expect(matchesResetTrigger("  Reset  ", ["reset"])).toBe(true);
  });

  it("matches normal regex trigger", () => {
    expect(matchesResetTrigger("reset session", ["/reset/"])).toBe(true);
    expect(matchesResetTrigger("please reset now", ["/reset/"])).toBe(true);
  });

  it("does not match when no triggers match", () => {
    expect(matchesResetTrigger("hello", ["reset", "/goodbye/"])).toBe(false);
  });

  it("skips ReDoS-prone regex trigger /(a+)+$/", () => {
    // This pattern would cause catastrophic backtracking on a long 'a' string
    // but the guard should skip it entirely
    expect(matchesResetTrigger("aaaaaaaaaaaaaaaa", ["/(a+)+$/"])).toBe(false);
  });

  it("skips regex trigger exceeding 200 characters", () => {
    const longPattern = "/" + "a".repeat(201) + "/";
    expect(matchesResetTrigger("a", [longPattern])).toBe(false);
  });

  it("handles empty trigger list", () => {
    expect(matchesResetTrigger("anything", [])).toBe(false);
  });

  it("skips invalid regex patterns silently", () => {
    expect(matchesResetTrigger("hello", ["/[invalid(/"])).toBe(false);
  });

  it("processes mix of safe and unsafe triggers", () => {
    // First trigger is ReDoS-prone (skipped), second is valid literal
    expect(matchesResetTrigger("reset", ["/(a+)+$/", "reset"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allowFrom sender filtering
// ---------------------------------------------------------------------------

describe("allowFrom sender filtering", () => {
  it("allows message when allowFrom is empty (default behavior)", async () => {
    const deps = makeMinimalDeps({ getAllowFrom: () => [] });
    const adapter = makeAdapterForTest();
    const msg = makeMsg();

    await processInboundMessage(deps, adapter, msg, new Set(), { get: () => undefined, set: () => {}, delete: () => {} } as any);

    expect(deps.createExecutor).toHaveBeenCalled();
  });

  it("allows message from sender in allowFrom list", async () => {
    const deps = makeMinimalDeps({ getAllowFrom: () => ["user-1"] });
    const adapter = makeAdapterForTest();
    const msg = makeMsg();

    await processInboundMessage(deps, adapter, msg, new Set(), { get: () => undefined, set: () => {}, delete: () => {} } as any);

    expect(deps.createExecutor).toHaveBeenCalled();
  });

  it("blocks message from sender NOT in allowFrom list and emits event", async () => {
    const deps = makeMinimalDeps({ getAllowFrom: () => ["admin-1", "admin-2"] });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ senderId: "user-1" });

    await processInboundMessage(deps, adapter, msg, new Set(), { get: () => undefined, set: () => {}, delete: () => {} } as any);

    // Executor should NOT have been called (message dropped before agent resolution)
    expect(deps.createExecutor).not.toHaveBeenCalled();
    // sender:blocked event should be emitted
    expect(deps.eventBus.emit).toHaveBeenCalledWith("sender:blocked", {
      channelType: "telegram",
      senderId: "user-1",
      channelId: "chat-1",
      timestamp: expect.any(Number),
    });
    // Logger should record the block
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "telegram", senderId: "user-1", hint: "Sender not in allowFrom list" }),
      "Sender blocked by allowFrom filter",
    );
  });

  it("allows all when getAllowFrom is not provided (undefined)", async () => {
    const deps = makeMinimalDeps(); // no getAllowFrom
    const adapter = makeAdapterForTest();
    const msg = makeMsg();

    await processInboundMessage(deps, adapter, msg, new Set(), { get: () => undefined, set: () => {}, delete: () => {} } as any);

    expect(deps.createExecutor).toHaveBeenCalled();
  });

  it("terminalizes the source when inbound preparation rejects after reception", async () => {
    const deps = makeMinimalDeps();
    vi.mocked(deps.sessionManager.loadOrCreate).mockImplementation(() => {
      throw new Error("session store unavailable");
    });
    const msg = makeMsg({ id: "00000000-0000-0000-0000-000000000202" });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toThrow("session store unavailable");

    expect(deps.eventBus.emit).toHaveBeenCalledWith("message:terminal", {
      channelType: "telegram",
      channelId: "chat-1",
      sourceMessageId: msg.id,
      outcome: "error",
      reason: "inbound_rejected",
      timestamp: expect.any(Number),
    });
  });

  it("terminalizes the source when the sender filter dependency throws", async () => {
    const primary = new Error("allowFrom lookup failed");
    const deps = makeMinimalDeps({
      getAllowFrom: vi.fn(() => {
        throw primary;
      }),
    });
    const msg = makeMsg({ id: "00000000-0000-0000-0000-000000000204" });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toBe(primary);

    const terminals = vi.mocked(deps.eventBus.emit).mock.calls
      .filter(([event]) => event === "message:terminal")
      .map(([, payload]) => payload);
    expect(terminals).toEqual([
      expect.objectContaining({
        sourceMessageId: msg.id,
        outcome: "error",
        reason: "inbound_rejected",
      }),
    ]);
  });

  it("terminalizes a blocked sender when the observational emitter throws", async () => {
    const deps = makeMinimalDeps({ getAllowFrom: () => ["admin-1"] });
    const primary = new Error("sender observer fan-out failed");
    vi.mocked(deps.eventBus.emitSafely).mockImplementation((event, payload) => {
      if (event === "sender:blocked") throw primary;
      deps.eventBus.emit(event, payload);
      return {
        hadListeners: false,
        failures: [],
        pendingFailures: Promise.resolve([]),
      };
    });
    const msg = makeMsg({ id: "00000000-0000-0000-0000-000000000207" });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      msg,
      new Set(),
      new Map() as any,
    )).resolves.toBeUndefined();

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "message:terminal",
      expect.objectContaining({
        sourceMessageId: msg.id,
        outcome: "filtered",
        reason: "gate_skipped",
      }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "sender:blocked", firstListenerIndex: -1 }),
      "Observational event subscriber failed",
    );
  });

  it("does not duplicate a terminal published before executor rejection rethrows", async () => {
    const primary = new Error("executor rejected");
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({
        execute: vi.fn(async () => Promise.reject(primary)),
      })),
    });
    const msg = makeMsg({ id: "00000000-0000-0000-0000-000000000203" });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toBe(primary);

    const terminals = vi.mocked(deps.eventBus.emit).mock.calls
      .filter(([event]) => event === "message:terminal")
      .map(([, payload]) => payload);
    expect(terminals).toEqual([
      expect.objectContaining({
        sourceMessageId: msg.id,
        outcome: "error",
        reason: "execution_completed",
      }),
    ]);
  });

  it("terminalizes distinct ingresses that reject with the same Error object", async () => {
    const primary = new Error("shared executor failure");
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({
        execute: vi.fn(async () => Promise.reject(primary)),
      })),
    });
    const first = makeMsg({ id: "00000000-0000-0000-0000-000000000205" });
    const second = makeMsg({ id: "00000000-0000-0000-0000-000000000206" });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      first,
      new Set(),
      new Map() as any,
    )).rejects.toBe(primary);
    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      second,
      new Set(),
      new Map() as any,
    )).rejects.toBe(primary);

    const terminals = vi.mocked(deps.eventBus.emit).mock.calls
      .filter(([event]) => event === "message:terminal")
      .map(([, payload]) => payload as { sourceMessageId: string });
    expect(terminals.map((event) => event.sourceMessageId)).toEqual([
      first.id,
      second.id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ack reaction bypass when lifecycle reactions enabled
// ---------------------------------------------------------------------------

function makeMinimalDeps(overrides?: Partial<InboundPipelineDeps>): InboundPipelineDeps {
  const emit = vi.fn(() => true);
  return {
    tenantId: "default",
    clock: createFakeClock(2_000),
    eventBus: {
      emit,
      emitSafely: vi.fn((event, payload) => {
        emit(event, payload);
        return { hadListeners: false, failures: [] };
      }),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    } as any,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
    messageRouter: {
      resolve: vi.fn(() => "agent-default"),
      updateConfig: vi.fn(),
    },
    sessionManager: {
      loadOrCreate: vi.fn(() => ok([])),
      save: vi.fn(() => ok(undefined)),
      isExpired: vi.fn(() => ok(false)),
      expire: vi.fn(() => ok(true)),
      cleanStale: vi.fn(() => ok(0)),
    },
    principalResolver: {
      resolve: vi.fn((_tenantId, _agentId, assertion) => ok({ principalId: assertion.platformSubjectId })),
    },
    getDmScope: vi.fn(() => ({ mode: "per-account-channel-peer", threadIsolation: true })),
    createExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({
        response: "ok",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop" as const,
      })),
    })),
    persistInboundMessage: vi.fn(async () => ({
      ok: true as const,
      value: { payloads: [], ledgerContent: "" },
    })),
    // Per-test injected DeliveryService fake (see the helper at file top).
    deliveryService: makeFakeDeliveryService(),
    localization: createDeterministicLocalization(),
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: "42", telegramChatType: "private" },
    ...overrides,
  };
}

function makeAdapterForTest(): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-r1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn(async () => ok(undefined)),
    removeReaction: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok({ kind: "tracked" as const, messageId: "att-1" })),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

describe("resolved inbound request context", () => {
  it("rejects and terminalizes an inbound turn that has no request scope", async () => {
    const deps = makeMinimalDeps();
    const msg = makeMsg({ id: "missing-context-source" });

    await expect(processInboundMessageWithoutScope(
      deps,
      makeAdapterForTest(),
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toThrow("request context");

    expect(deps.createExecutor).not.toHaveBeenCalled();
    const terminals = vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.[1]).toMatchObject({
      channelType: "telegram",
      channelId: "chat-1",
      sourceMessageId: msg.id,
      outcome: "error",
      reason: "inbound_rejected",
    });
  });

  it("keeps one context object from ingress through resolved execution and delivery", async () => {
    const ingressContext = {
      tenantId: "default",
      traceId: "00000000-0000-4000-8000-000000000001",
      startedAt: Date.now(),
      trustLevel: "user",
      channelType: "telegram",
    } satisfies RequestContext;
    let executorContext: RequestContext | undefined;
    let deliveryContext: RequestContext | undefined;
    const executor = vi.fn(async () => {
      executorContext = tryGetContext();
      return {
        response: "ok",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop" as const,
      };
    });
    const deliveryService = makeFakeDeliveryService();
    vi.mocked(deliveryService.deliverToChannel).mockImplementation(
      async (adapter, channelId, text) => {
        deliveryContext = tryGetContext();
        await adapter.sendMessage(channelId, text);
        return ok({
          chunks: [{
            status: "accepted" as const,
            messageId: "m1",
            charCount: text.length,
            retried: false,
          }],
          totalChars: text.length,
          platform: { status: "accepted" as const, deliveredChunks: 1, settledAtMs: 2_000, lastMessageId: "m1" },
          queueDisposition: "settled" as const,
        });
      },
    );
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({ execute: executor })),
      deliveryService,
      getElevatedReplyConfig: () => ({
        enabled: true,
        senderTrustMap: { "user-1": "admin" },
        defaultTrustLevel: "guest",
        trustModelRoutes: {},
        trustPromptOverrides: {},
      }),
    });

    await runWithContext(ingressContext, () => processInboundMessage(
      deps,
      makeAdapterForTest(),
      makeMsg(),
      new Set(),
      new Map() as any,
    ));

    expect(executorContext).toBe(ingressContext);
    expect(deliveryContext).toBe(ingressContext);
    expect(ingressContext).toMatchObject({
      tenantId: "default",
      userId: "user-1",
      sessionKey: formatSessionKey({
        tenantId: "default",
        agentId: "agent-default",
        userId: "user-1",
        channelId: "telegram:adapter-1:chat-1",
        peerId: "user-1",
      }),
      agentId: "agent-default",
      trustLevel: "admin",
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "chat-1",
        userId: "user-1",
        tenantId: "default",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// /approve and /deny chat command interception
// ---------------------------------------------------------------------------

function makeMockApprovalGate(
  pendingRequests: ApprovalRequest[] = [],
) {
  return {
    resolveApproval: vi.fn(),
    pending: vi.fn(() => pendingRequests),
    getRequest: vi.fn((id: string) => pendingRequests.find((r) => r.requestId === id)),
    // Read helpers — the inbound shortId slash path + button router source.
    getRequestByShortId: vi.fn((sid: string) => pendingRequests.find((r) => r.shortId === sid)),
    pendingForAuthority: vi.fn((authority: {
      tenantId: string;
      agentId: string;
      conversationRef: string;
      resolvingPrincipalId: string;
    }) => pendingRequests.filter((request) =>
      request.tenantId === authority.tenantId
      && request.agentId === authority.agentId
      && request.conversationRef === authority.conversationRef
      && request.resolvingPrincipalId === authority.resolvingPrincipalId
    )),
  };
}

describe("/approve and /deny command interception", () => {
  const testConversationRef = createConversationRef({
    tenantId: "default",
    agentId: "agent-default",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "adapter-1",
        conversationId: "chat-1",
        conversationKind: "direct",
      },
      principalId: "user-1",
    },
  });
  if (!testConversationRef.ok) throw testConversationRef.error;
  const PENDING_REQUEST: ApprovalRequest = {
    requestId: "aaaa1234-bbbb-cccc-dddd-eeeeeeeeeeee",
    shortId: "AAAA1234bbbb",
    action: "agents.delete",
    toolName: "agents_manage",
    params: {},
    tenantId: "default",
    agentId: "agent-default",
    conversationRef: testConversationRef.value,
    resolvingPrincipalId: "user-1",
    trustLevel: "admin",
    callbackOwner: {
      tenantId: "default",
      userId: "user-1",
      channelType: "telegram",
      channelKey: "chat-1",
    },
    createdAt: 1,
    timeoutMs: 60_000,
  };

  it("/approve <id> resolves matching pending approval as approved", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const executorFn = vi.fn();
    const deps = makeMinimalDeps({
      approvalGate: gate,
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve AAAA1234bbbb" }), new Set(), new Map() as any,
    );

    expect(gate.pendingForAuthority).toHaveBeenCalledWith({
      tenantId: "default",
      agentId: "agent-default",
      conversationRef: testConversationRef.value,
      resolvingPrincipalId: "user-1",
    });
    expect(gate.resolveApproval).toHaveBeenCalledWith(
      PENDING_REQUEST.requestId, true, "chat:user-1",
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Approved"),
    );
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("/deny <id> resolves matching pending approval as denied", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const executorFn = vi.fn();
    const deps = makeMinimalDeps({
      approvalGate: gate,
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/deny AAAA1234bbbb" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).toHaveBeenCalledWith(
      PENDING_REQUEST.requestId, false, "chat:user-1",
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Denied"),
    );
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("/help renders a deterministic localized command reply without model dispatch", async () => {
    const adapter = makeAdapterForTest();
    const executorFn = vi.fn();
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/help", metadata: { locale: "en" } }), new Set(), new Map() as any,
    );

    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("/approve"),
    );
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("/approve all resolves all pending approvals for session", async () => {
    const req1 = { ...PENDING_REQUEST, requestId: "11111111-1111-1111-1111-111111111111" };
    const req2 = { ...PENDING_REQUEST, requestId: "22222222-2222-2222-2222-222222222222" };
    const req3 = {
      ...PENDING_REQUEST,
      requestId: "33333333-3333-3333-3333-333333333333",
      tenantId: "other",
      action: "files.write",
      toolName: "file_ops",
      callbackOwner: {
        tenantId: "other",
        userId: "tenant",
        channelType: "telegram",
        channelKey: "key",
      },
    };
    const gate = makeMockApprovalGate([req1, req2, req3]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve all" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).toHaveBeenCalledTimes(2);
    expect(gate.resolveApproval).toHaveBeenCalledWith(req1.requestId, true, "chat:user-1");
    expect(gate.resolveApproval).toHaveBeenCalledWith(req2.requestId, true, "chat:user-1");
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Approved 2 pending approval(s).",
    );
  });

  it("/deny all with no pending approvals reports zero", async () => {
    const gate = makeMockApprovalGate([]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/deny all" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "No pending approvals to resolve.",
    );
  });

  it("/approve <unknown-id> reports not found", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve deadbeef" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("No pending approval found"),
    );
  });

  it("/approve rejects a same-session request owned by another channel", async () => {
    const wrongOwner = {
      ...PENDING_REQUEST,
      callbackOwner: {
        ...PENDING_REQUEST.callbackOwner,
        channelType: "discord",
      },
    };
    const gate = makeMockApprovalGate([wrongOwner]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve AAAA1234bbbb" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("No pending approval found"),
    );
  });

  // -----------------------------------------------------------------------
  // Ambiguous prefix -> warn, do not resolve. The gate uses a filter+length
  // check (not first-match lookup): on >1 match, deliver an "Ambiguous
  // prefix" warning and bail without resolving so the operator cannot
  // silently approve the wrong request when prefixes collide.
  // -----------------------------------------------------------------------
  it("/approve <requestId-prefix> matches NO shortId and resolves nothing (chat speaks shortId only)", async () => {
    const reqA = {
      ...PENDING_REQUEST,
      requestId: "ambig0001-aaaa-bbbb-cccc-111111111111",
      shortId: "AMBIG001aaaa",
      action: "agents.delete",
      toolName: "agents_manage",
    };
    const reqB = {
      ...PENDING_REQUEST,
      requestId: "ambig0002-aaaa-bbbb-cccc-222222222222",
      shortId: "AMBIG002bbbb",
      action: "files.write",
      toolName: "file_ops",
    };
    const gate = makeMockApprovalGate([reqA, reqB]);
    const adapter = makeAdapterForTest();
    const executorFn = vi.fn();
    const deps = makeMinimalDeps({
      approvalGate: gate,
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    // "ambig000" is a requestId prefix; the chat path now matches by EXACT
    // 12-char shortId only, so this matches nothing (no leak, no resolve).
    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve ambig000" }), new Set(), new Map() as any,
    );

    // No approval is resolved — a requestId prefix is no longer accepted.
    expect(gate.resolveApproval).not.toHaveBeenCalled();
    // The user is told no approval matched that ID.
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("No pending approval found"),
    );
    // No full requestId nor its 8-char prefix is ever echoed back to the channel.
    const sentText = vi.mocked(adapter.sendMessage).mock.calls
      .map((c) => String(c[1]))
      .join("\n");
    expect(sentText).not.toContain("ambig0001");
    expect(sentText).not.toContain("ambig0002");
    // The agent executor MUST NOT be invoked — the slash-command was recognized.
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("/deny <requestId-prefix> matches NO shortId and resolves nothing", async () => {
    const reqA = {
      ...PENDING_REQUEST,
      requestId: "denyamb01-aaaa-bbbb-cccc-333333333333",
      shortId: "DENYAMB1cccc",
      action: "agents.delete",
      toolName: "agents_manage",
    };
    const reqB = {
      ...PENDING_REQUEST,
      requestId: "denyamb02-aaaa-bbbb-cccc-444444444444",
      shortId: "DENYAMB2dddd",
      action: "files.write",
      toolName: "file_ops",
    };
    const gate = makeMockApprovalGate([reqA, reqB]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/deny denyamb" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("No pending approval found"),
    );
    const sentText = vi.mocked(adapter.sendMessage).mock.calls
      .map((c) => String(c[1]))
      .join("\n");
    expect(sentText).not.toContain("denyamb01");
    expect(sentText).not.toContain("denyamb02");
  });

  it("/approve without approvalGate dep passes through to agent", async () => {
    const executorFn = vi.fn(async () => ({
      response: "ok",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      tokensUsed: { input: 10, output: 5, total: 15 },
      cost: { total: 0.001 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    }));
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({
      // No approvalGate provided
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve aaaa1234" }), new Set(), new Map() as any,
    );

    // Executor SHOULD have been called (command passed through as regular text)
    expect(executorFn).toHaveBeenCalled();
  });

  it("/approve verb is case-insensitive (the shortId arg stays case-sensitive)", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    // The VERB may be any case; the 12-char base62 shortId must be matched exactly.
    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/APPROVE AAAA1234bbbb" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).toHaveBeenCalledWith(
      PENDING_REQUEST.requestId, true, "chat:user-1",
    );
  });

  it("/approve <shortId> is matched case-sensitively (a wrong-case shortId resolves nothing)", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    // shortId is base62 (case distinguishes), so a lower-cased copy must NOT match.
    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve aaaa1234bbbb" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("No pending approval found"),
    );
  });

  // -----------------------------------------------------------------------
  // Bare /approve and /deny (no arguments)
  // -----------------------------------------------------------------------

  it("bare /approve with exactly 1 pending auto-approves it", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const executorFn = vi.fn();
    const deps = makeMinimalDeps({
      approvalGate: gate,
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).toHaveBeenCalledWith(
      PENDING_REQUEST.requestId, true, "chat:user-1",
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Approved"),
    );
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("bare /deny with exactly 1 pending auto-denies it", async () => {
    const gate = makeMockApprovalGate([PENDING_REQUEST]);
    const adapter = makeAdapterForTest();
    const executorFn = vi.fn();
    const deps = makeMinimalDeps({
      approvalGate: gate,
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/deny" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).toHaveBeenCalledWith(
      PENDING_REQUEST.requestId, false, "chat:user-1",
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Denied"),
    );
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("bare /approve with 0 pending reports no approvals", async () => {
    const gate = makeMockApprovalGate([]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "No pending approvals.",
    );
  });

  it("bare /deny with 0 pending reports no approvals", async () => {
    const gate = makeMockApprovalGate([]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/deny" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "No pending approvals.",
    );
  });

  it("bare /approve with >1 pending lists shortIds (never requestId prefixes)", async () => {
    const req1 = { ...PENDING_REQUEST, requestId: "11111111-1111-1111-1111-111111111111", shortId: "SHORTone1111" };
    const req2 = { ...PENDING_REQUEST, requestId: "22222222-2222-2222-2222-222222222222", shortId: "SHORTtwo2222" };
    const gate = makeMockApprovalGate([req1, req2]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/approve" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Multiple pending approvals"),
    );
    // The listing shows the 12-char shortIds...
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("SHORTone1111"),
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("SHORTtwo2222"),
    );
    // ...and never the full requestId nor its 8-char prefix.
    const sentText = vi.mocked(adapter.sendMessage).mock.calls
      .map((c) => String(c[1]))
      .join("\n");
    expect(sentText).not.toContain("11111111");
    expect(sentText).not.toContain("22222222");
  });

  it("bare /deny with >1 pending shows help with IDs", async () => {
    const req1 = { ...PENDING_REQUEST, requestId: "11111111-1111-1111-1111-111111111111", shortId: "SHORTone1111" };
    const req2 = { ...PENDING_REQUEST, requestId: "22222222-2222-2222-2222-222222222222", shortId: "SHORTtwo2222" };
    const gate = makeMockApprovalGate([req1, req2]);
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({ approvalGate: gate });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/deny" }), new Set(), new Map() as any,
    );

    expect(gate.resolveApproval).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Multiple pending approvals"),
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("/deny all"),
    );
  });
});

// "ack reaction bypass with lifecycleReactionsEnabled" describe block deleted:
// ackReactionConfig deps slot was removed; the ack-reaction code path that
// conditionally fired based on lifecycleReactionsEnabled is gone.

// ---------------------------------------------------------------------------
// General slash command interception
// ---------------------------------------------------------------------------

describe("general slash command interception", () => {
  it("durably records the resolved physical message before a handled command and reception event", async () => {
    const callOrder: string[] = [];
    const persistInboundMessage = vi.fn(async () => {
      callOrder.push("persist");
      return {
        ok: true as const,
        value: { payloads: [], ledgerContent: "" },
      };
    });
    const handleSlashCommand = vi.fn(async () => {
      callOrder.push("gate");
      return { handled: true, response: "ready" };
    });
    const deps = makeMinimalDeps({ persistInboundMessage, handleSlashCommand });
    vi.mocked(deps.eventBus.emit).mockImplementation((event) => {
      if (event === "message:received") callOrder.push("received");
      return true;
    });
    const message = makeMsg({
      id: "00000000-0000-4000-8000-000000000301",
      text: "/status",
      originalMessages: [{
        id: "00000000-0000-4000-8000-000000000301",
        channelId: "chat-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "/status",
        timestamp: 1_789_000_000_000,
      }],
    });

    await processInboundMessage(
      deps,
      makeAdapterForTest(),
      message,
      new Set(),
      new Map() as any,
    );

    expect(persistInboundMessage).toHaveBeenCalledOnce();
    expect(persistInboundMessage).toHaveBeenCalledWith(
      "agent-default",
      message,
      expect.objectContaining({
        tenantId: "default",
        agentId: "agent-default",
        userId: "user-1",
        channelId: "telegram:adapter-1:chat-1",
      }),
    );
    expect(callOrder).toEqual(["persist", "received", "gate"]);
  });

  it("terminalizes and stops gates when durable inbound persistence fails", async () => {
    const persistenceError = new Error("ledger storage unavailable");
    const persistInboundMessage = vi.fn(async () => ({
      ok: false as const,
      error: {
        error: persistenceError,
        errorKind: "resource" as const,
      },
    }));
    const handleSlashCommand = vi.fn();
    const executor = vi.fn();
    const deps = makeMinimalDeps({
      persistInboundMessage,
      handleSlashCommand,
      createExecutor: vi.fn(() => ({ execute: executor })),
    });
    const message = makeMsg({
      id: "00000000-0000-4000-8000-000000000302",
      text: "/status",
    });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      message,
      new Set(),
      new Map() as any,
    )).rejects.toBe(persistenceError);

    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalledWith(
      "message:received",
      expect.anything(),
    );
    expect(deps.eventBus.emit).toHaveBeenCalledWith("message:terminal", {
      channelType: "telegram",
      channelId: "chat-1",
      sourceMessageId: message.id,
      outcome: "error",
      reason: "inbound_rejected",
      timestamp: expect.any(Number),
    });
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "session-provenance",
        errorKind: "resource",
        hint: expect.stringContaining("session storage"),
      }),
      "Inbound message provenance persistence failed",
    );
  });

  it("handled command returns response and skips executor", async () => {
    const executorFn = vi.fn();
    const adapter = makeAdapterForTest();
    const handleSlashCommand = vi.fn(async () => ({
      handled: true,
      response: "Session Status: 5 messages",
    }));
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({ execute: executorFn })),
      handleSlashCommand,
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/status" }), new Set(), new Map() as any,
    );

    expect(handleSlashCommand).toHaveBeenCalledWith(
      "/status",
      expect.objectContaining({ tenantId: "default", userId: "user-1" }),
      "agent-default",
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith("chat-1", "Session Status: 5 messages");
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("terminalizes the exact source after a handled gate command", async () => {
    const adapter = makeAdapterForTest();
    const msg = makeMsg({
      id: "00000000-0000-0000-0000-000000000201",
      channelId: "chat:one",
      text: "/status",
    });
    const deps = makeMinimalDeps({
      handleSlashCommand: vi.fn(async () => ({
        handled: true,
        response: "ready",
      })),
    });

    await processInboundMessage(
      deps,
      adapter,
      msg,
      new Set(),
      new Map() as any,
    );

    expect(deps.eventBus.emit).toHaveBeenCalledWith("message:terminal", {
      channelType: "telegram",
      channelId: "chat:one",
      sourceMessageId: msg.id,
      outcome: "success",
      reason: "gate_handled",
      timestamp: expect.any(Number),
    });
  });

  it("directive command passes directives through to execution", async () => {
    const executorFn = vi.fn(async () => ({
      response: "ok",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      tokensUsed: { input: 10, output: 5, total: 15 },
      cost: { total: 0.001 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    }));
    const adapter = makeAdapterForTest();
    const handleSlashCommand = vi.fn(async () => ({
      handled: false,
      directives: { thinkingLevel: "high" },
      cleanedText: "something important",
    }));
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({ execute: executorFn })),
      handleSlashCommand,
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/think high something important" }), new Set(), new Map() as any,
    );

    // Executor SHOULD have been called
    expect(executorFn).toHaveBeenCalled();
    // The message text should be replaced with cleanedText
    const calledMsg = executorFn.mock.calls[0][0];
    expect(calledMsg.text).toBe("something important");
    // Directives should be passed (6th arg to executor.execute)
    const calledDirectives = executorFn.mock.calls[0][5];
    expect(calledDirectives).toEqual({ thinkingLevel: "high" });
  });

  it("non-command messages pass through normally", async () => {
    const executorFn = vi.fn(async () => ({
      response: "ok",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      tokensUsed: { input: 10, output: 5, total: 15 },
      cost: { total: 0.001 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    }));
    const adapter = makeAdapterForTest();
    const handleSlashCommand = vi.fn(async () => undefined);
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({ execute: executorFn })),
      handleSlashCommand,
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "hello" }), new Set(), new Map() as any,
    );

    expect(handleSlashCommand).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ tenantId: "default" }),
      "agent-default",
    );
    expect(executorFn).toHaveBeenCalled();
    // Original message text preserved
    const calledMsg = executorFn.mock.calls[0][0];
    expect(calledMsg.text).toBe("hello");
  });

  it("handleSlashCommand absent gracefully degrades", async () => {
    const executorFn = vi.fn(async () => ({
      response: "ok",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      tokensUsed: { input: 10, output: 5, total: 15 },
      cost: { total: 0.001 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    }));
    const adapter = makeAdapterForTest();
    const deps = makeMinimalDeps({
      // No handleSlashCommand provided
      createExecutor: vi.fn(() => ({ execute: executorFn })),
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/status" }), new Set(), new Map() as any,
    );

    // Executor SHOULD have been called (command passes through as text)
    expect(executorFn).toHaveBeenCalled();
  });

  it("session command (/new) sends response and skips executor", async () => {
    const executorFn = vi.fn();
    const adapter = makeAdapterForTest();
    const handleSlashCommand = vi.fn(async () => ({
      handled: true,
      response: "New session created.",
    }));
    const deps = makeMinimalDeps({
      createExecutor: vi.fn(() => ({ execute: executorFn })),
      handleSlashCommand,
    });

    await processInboundMessage(
      deps, adapter, makeMsg({ text: "/new" }), new Set(), new Map() as any,
    );

    expect(adapter.sendMessage).toHaveBeenCalledWith("chat-1", "New session created.");
    expect(executorFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dedup-detector wiring in inbound pipeline
// ---------------------------------------------------------------------------

import { createDedupDetector } from "./dedup-detector.js";

describe("dedup-detector wiring in processInboundMessage", () => {
  it("admits a retry when the first attempt fails before durable provenance commits", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const persistInboundMessage = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          error: new Error("ledger unavailable"),
          errorKind: "resource" as const,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { payloads: [], ledgerContent: "" },
      });
    const deps = makeMinimalDeps({ dedupDetector, persistInboundMessage });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "retry-after-provenance-failure" });

    await expect(processInboundMessage(
      deps,
      adapter,
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toThrow("ledger unavailable");
    await processInboundMessage(deps, adapter, msg, new Set(), new Map() as any);

    expect(persistInboundMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:received",
    )).toHaveLength(1);
    expect(vi.mocked(deps.eventBus.emit).mock.calls.some(
      ([event]) => event === "dedup:duplicate_inbound",
    )).toBe(false);
  });

  it("admits a retry when execution fails after durable provenance commits", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("execution unavailable after persistence"))
      .mockResolvedValueOnce({
        response: "ok",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
        tokensUsed: { input: 1, output: 1, total: 2 },
        cost: { total: 0 },
        stepsExecuted: 0,
        finishReason: "stop" as const,
      });
    const deps = makeMinimalDeps({
      dedupDetector,
      createExecutor: vi.fn(() => ({ execute })),
    });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "retry-after-execution-failure" });

    await expect(processInboundMessage(
      deps,
      adapter,
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toThrow("execution unavailable after persistence");
    await processInboundMessage(deps, adapter, msg, new Set(), new Map() as any);

    expect(deps.persistInboundMessage).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.eventBus.emit).mock.calls.some(
      ([event]) => event === "dedup:duplicate_inbound",
    )).toBe(false);
  });

  it("terminalizes the source when duplicate detection throws", async () => {
    const primary = new Error("dedup state unavailable");
    const deps = makeMinimalDeps({
      dedupDetector: {
        reserve: vi.fn(() => {
          throw primary;
        }),
      },
    });
    const msg = makeMsg({ id: "dedup-check-error" });

    await expect(processInboundMessage(
      deps,
      makeAdapterForTest(),
      msg,
      new Set(),
      new Map() as any,
    )).rejects.toBe(primary);

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "message:terminal",
      expect.objectContaining({
        sourceMessageId: msg.id,
        outcome: "error",
        reason: "inbound_rejected",
      }),
    );
  });

  it("duplicate_messageId_emits_dedup:duplicate_inbound_with_correct_fields_and_source_pipeline", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const deps = makeMinimalDeps({ dedupDetector });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "dup-msg-1" });
    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    // First call: registers the messageId
    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    // Second call: triggers dedup detection
    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    // Assert dedup:duplicate_inbound was emitted on the second call
    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const dedupCall = emitCalls.find((c: unknown[]) => c[0] === "dedup:duplicate_inbound");
    expect(dedupCall).toBeDefined();

    const payload = dedupCall![1] as Record<string, unknown>;
    expect(payload.messageId).toBe("dup-msg-1");
    expect(payload.channelType).toBe("telegram");
    expect(payload.chatId).toBe("chat-1");
    expect(payload.source).toBe("pipeline");
    expect(typeof payload.deltaMs).toBe("number");
    expect(typeof payload.firstSeenAt).toBe("number");
    expect(typeof payload.duplicateAt).toBe("number");
  });

  it("duplicate_messageId_logs_WARN_with_errorKind_internal_and_verbatim_hint", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const deps = makeMinimalDeps({ dedupDetector });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "dup-msg-2" });
    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);
    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Same messageId processed twice; check channel adapter handler list and queue mode",
        errorKind: "internal",
        messageId: "dup-msg-2",
        channelType: "telegram",
        chatId: "chat-1",
      }),
      "Duplicate inbound message detected",
    );
  });

  it("duplicate messageId is processed and terminalized exactly once", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const deps = makeMinimalDeps({ dedupDetector });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "dup-msg-3" });
    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    const firstCallCount = (deps.createExecutor as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstCallCount).toBe(1);

    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    // The second delivery is the same physical source, so it must not start a
    // second execution or publish the same terminal tuple again.
    const secondCallCount = (deps.createExecutor as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondCallCount).toBe(1);
    const terminals = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === "message:terminal")
      .map((call: unknown[]) => call[1] as { sourceMessageId: string });
    expect(terminals.filter((event) => event.sourceMessageId === msg.id)).toHaveLength(1);
  });

  it("keeps identical local ids in different channels as distinct source tuples", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const deps = makeMinimalDeps({ dedupDetector });
    const adapter = makeAdapterForTest();
    const first = makeMsg({ id: "shared-local-id", channelId: "chat-1" });
    const second = makeMsg({ id: "shared-local-id", channelId: "chat-2" });
    const sendOverrides = new Map() as any;

    await processInboundMessage(deps, adapter, first, new Set(), sendOverrides);
    await processInboundMessage(deps, adapter, second, new Set(), sendOverrides);

    expect(deps.createExecutor).toHaveBeenCalledTimes(2);
    const terminals = vi.mocked(deps.eventBus.emit).mock.calls
      .filter(([event]) => event === "message:terminal")
      .map(([, payload]) => payload as { channelId: string; sourceMessageId: string });
    expect(terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: "chat-1", sourceMessageId: "shared-local-id" }),
      expect.objectContaining({ channelId: "chat-2", sourceMessageId: "shared-local-id" }),
    ]));
  });

  it("no_dedupDetector_in_deps_skips_dedup_check_entirely_no_emit", async () => {
    // Without dedupDetector, no dedup:duplicate_inbound should be emitted even on identical messageId
    const deps = makeMinimalDeps(); // no dedupDetector
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "dup-msg-4" });
    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);
    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const dedupCall = emitCalls.find((c: unknown[]) => c[0] === "dedup:duplicate_inbound");
    expect(dedupCall).toBeUndefined();
  });
});
