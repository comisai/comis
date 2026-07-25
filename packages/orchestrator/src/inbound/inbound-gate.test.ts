// SPDX-License-Identifier: Apache-2.0
/**
 * inbound-gate — button-callback intercept + shortId slash-path tests.
 *
 * Two behaviours under test:
 *
 *  (A) A platform button callback arrives as a `NormalizedMessage` carrying
 *      `metadata.isButtonCallback === true` + `metadata.callbackData`. It MUST
 *      be intercepted and routed to `InteractiveCallbackRouter.route()` BEFORE
 *      slash-command handling — a signed button payload must NOT also be parsed
 *      as a chat command, and the gate must never be called directly from the
 *      inbound button path (the router is the verifier).
 *
 *  (B) `/approve <shortId>` / `/deny <shortId>` match by exact 12-char `shortId`
 *      (NOT `requestId.startsWith`) and DISPLAY the `shortId` (NOT
 *      `requestId.slice(0,8)`). The full `requestId` / its prefix never reaches
 *      a channel. Bare `/approve` (one pending → resolve) and `/approve all`
 *      keep their existing semantics.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
  DeliveryService,
  ApprovalRequest,
  ResolvedTurnScope,
} from "@comis/core";
import { createConversationRef, formatSessionKey } from "@comis/core";
import { ok } from "@comis/shared";

import { evaluateInboundGate } from "./inbound-gate.js";
import type { GateDeps } from "./inbound-gate.js";
import { createDeterministicLocalization } from "../localization/deterministic-localization.js";
import type {
  InteractiveCallbackRouter,
  CallbackResolution,
} from "../approval/index.js";
import type { SourceTerminalScope } from "../source-message-terminal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(channelType = "telegram"): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType,
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

function makeSessionKey(overrides: Partial<SessionKey> = {}): SessionKey {
  return {
    tenantId: "default",
    agentId: "agent-1",
    userId: "user-1",
    channelId: "chat-1",
    peerId: "user-1",
    ...overrides,
  };
}

const TURN_ENDPOINT = {
  channelType: "telegram",
  channelInstanceId: "adapter-1",
  conversationId: "chat-1",
  conversationKind: "direct" as const,
};

const TURN_SCOPE: ResolvedTurnScope = {
  conversation: {
    tenantId: "default",
    agentId: "agent-1",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: TURN_ENDPOINT,
      principalId: "principal-user-1",
    },
  },
  principal: { principalId: "principal-user-1" },
  endpoint: TURN_ENDPOINT,
};

const turnConversationRef = createConversationRef(TURN_SCOPE.conversation);
if (!turnConversationRef.ok) throw turnConversationRef.error;
const TURN_CONVERSATION_REF = turnConversationRef.value;

function expectedDeliveryOptions(
  turnScope: ResolvedTurnScope,
  conversationRef: typeof TURN_CONVERSATION_REF,
  skipChunking = false,
) {
  return {
    completionMode: "deferred_retry" as const,
    authority: {
      tenantId: turnScope.conversation.tenantId,
      agentId: turnScope.conversation.agentId,
      conversationRef,
    },
    destinationEndpoint: turnScope.endpoint,
    ...(turnScope.endpoint.threadId === undefined ? {} : { threadId: turnScope.endpoint.threadId }),
    ...(skipChunking ? { skipChunking: true } : {}),
  };
}

function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () =>
      ok({
        ok: true,
        totalChunks: 1,
        deliveredChunks: 1,
        failedChunks: 0,
        chunks: [],
        totalChars: 0,
      }),
    ),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeDeps(overrides?: Partial<GateDeps>): GateDeps {
  const eventBus = {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: eventBus as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    sessionManager: {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    },
    deliveryService: makeFakeDeliveryService(),
    localization: createDeterministicLocalization(),
    ...overrides,
  } as GateDeps;
}

const SEND_OVERRIDES = { get: () => undefined, set: vi.fn(), delete: vi.fn() };

describe("evaluateInboundGate history serialization", () => {
  it("passes ingress terminal authority into queued history injection", async () => {
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeDeps({
      commandQueue: { enqueue } as never,
      autoReplyEngineConfig: {
        enabled: true,
        groupActivation: "mention-gated",
        customPatterns: [],
        historyInjection: true,
        maxHistoryInjections: 50,
        maxGroupHistoryMessages: 20,
      },
    });
    const sourceTerminalScope: SourceTerminalScope = {
      publish: vi.fn(() => 1),
      isPublished: false,
    };
    const msg = makeMsg({
      metadata: {
        telegramMessageId: "42",
        telegramChatType: "group",
        isBotMentioned: false,
        replyToBot: false,
      },
    });

    const result = await evaluateInboundGate(
      deps,
      makeAdapter(),
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      SEND_OVERRIDES as never,
      sourceTerminalScope,
    );

    expect(result).toEqual({ action: "skip" });
    expect(enqueue).toHaveBeenCalledWith(
      makeSessionKey(),
      msg,
      "telegram",
      expect.any(Function),
      sourceTerminalScope,
    );
  });
});

/** Build a full ApprovalRequest fixture (the slash path reads shortId/toolName/action/sessionKey). */
function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    requestId: "11111111-2222-4333-8444-555555555555",
    shortId: "abc123XYZ789",
    toolName: "agents.delete",
    action: "agents.delete",
    params: {},
    tenantId: "default",
    agentId: "agent-1",
    conversationRef: TURN_CONVERSATION_REF,
    resolvingPrincipalId: TURN_SCOPE.principal.principalId,
    trustLevel: "user",
    callbackOwner: {
      tenantId: "default",
      userId: "user-1",
      channelType: "telegram",
      channelKey: "chat-1",
    },
    createdAt: 1000,
    timeoutMs: 300_000,
    ...overrides,
  };
}

/** Minimal fake ApprovalGate honouring pending() + getRequestByShortId + resolveApproval. */
function makeFakeGate(pending: ApprovalRequest[]) {
  const resolveApproval = vi.fn();
  return {
    gate: {
      resolveApproval,
      pending: () => pending,
      getRequest: (id: string) => pending.find((r) => r.requestId === id),
      getRequestByShortId: (sid: string) => pending.find((r) => r.shortId === sid),
      pendingForAuthority: (authority: {
        tenantId: string;
        agentId: string;
        conversationRef: string;
        resolvingPrincipalId: string;
      }) => pending.filter((request) =>
        request.tenantId === authority.tenantId
        && request.agentId === authority.agentId
        && request.conversationRef === authority.conversationRef
        && request.resolvingPrincipalId === authority.resolvingPrincipalId),
    },
    resolveApproval,
  };
}

/** Fake InteractiveCallbackRouter whose route() returns a scripted resolution and records its input. */
function makeFakeRouter(resolution: CallbackResolution) {
  const route = vi.fn(async () => ok(resolution));
  const router: InteractiveCallbackRouter = {
    route,
    render: vi.fn(() => ok("v1.approve.abc123XYZ789.deadbeefdeadbeef")),
    registerGraphReport: vi.fn(() => ok("v1.details.abc123XYZ789.deadbeefdeadbeef")),
  };
  return { router, route };
}

// ---------------------------------------------------------------------------
// (A) Button-callback intercept → router BEFORE slash handling
// ---------------------------------------------------------------------------

describe("evaluateInboundGate button-callback intercept", () => {
  it("routes an isButtonCallback message to router.route() with the derived sessionKey and rawData=callbackData, and does NOT invoke the slash gate", async () => {
    const callbackData = "v1.approve.abc123XYZ789.deadbeefdeadbeef";
    const { gate, resolveApproval } = makeFakeGate([makeRequest()]);
    const { router, route } = makeFakeRouter({
      kind: "resolved",
      requestId: "11111111-2222-4333-8444-555555555555",
      choice: "approve",
    });
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interactiveCallbackRouter: router as any,
    });
    const adapter = makeAdapter();
    const sessionKey = makeSessionKey();
    const msg = makeMsg({
      text: callbackData,
      metadata: { isButtonCallback: true, callbackData },
    });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      sessionKey,
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(route).toHaveBeenCalledTimes(1);
    const arg = route.mock.calls[0]![0]!;
    expect(arg.rawData).toBe(callbackData);
    expect(arg.sessionKey).toBe(formatSessionKey(sessionKey));
    expect(arg.channelType).toBe("telegram");
    expect(arg.channelKey).toBe("chat-1");
    expect(arg.agentId).toBe("agent-1");
    expect(arg.inboundUserId).toBe("user-1");
    // The router already resolved it — the inbound gate must NOT also call the gate.
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("surfaces a 'no longer valid' line on an unknown/expired/invalid resolution (no crash)", async () => {
    const callbackData = "v1.approve.abc123XYZ789.deadbeefdeadbeef";
    const { gate } = makeFakeGate([]);
    const { router } = makeFakeRouter({ kind: "unknown" });
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interactiveCallbackRouter: router as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({
      text: callbackData,
      metadata: { isButtonCallback: true, callbackData },
    });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      expect.stringMatching(/no longer valid/i),
      expect.any(Object),
    );
  });

  it("does NOT surface any feedback for a resolved button (the resolver already drove the UI)", async () => {
    const callbackData = "v1.approve.abc123XYZ789.deadbeefdeadbeef";
    const { gate } = makeFakeGate([makeRequest()]);
    const { router } = makeFakeRouter({
      kind: "resolved",
      requestId: "11111111-2222-4333-8444-555555555555",
      choice: "approve",
    });
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interactiveCallbackRouter: router as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({
      text: callbackData,
      metadata: { isButtonCallback: true, callbackData },
    });

    await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("delivers an owner-validated graph report only after the signed router resolves it", async () => {
    const callbackData = "v1.details.abc123XYZ789.deadbeefdeadbeef";
    const onGraphReportRequest = vi.fn(async () => undefined);
    const { router, route } = makeFakeRouter({
      kind: "graph_report_requested",
      graphId: "11111111-2222-4333-8444-555555555555",
    });
    const deps = makeDeps({
      interactiveCallbackRouter: router,
      onGraphReportRequest,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({
      text: callbackData,
      metadata: {
        isButtonCallback: true,
        callbackData,
        threadId: "untrusted-topic",
      },
    });

    const ownerThreadScope: ResolvedTurnScope = {
      ...TURN_SCOPE,
      endpoint: { ...TURN_SCOPE.endpoint, threadId: "owner-topic" },
      conversation: {
        ...TURN_SCOPE.conversation,
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint: { ...TURN_SCOPE.endpoint, threadId: "owner-topic" },
          principalId: TURN_SCOPE.principal.principalId,
        },
      },
    };
    const ownerThreadRef = createConversationRef(ownerThreadScope.conversation);
    if (!ownerThreadRef.ok) throw ownerThreadRef.error;
    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      ownerThreadScope,
      ownerThreadRef.value,
      SEND_OVERRIDES as never,
    );

    expect(result).toEqual({ action: "handled" });
    expect(onGraphReportRequest).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555555",
      "telegram",
      "chat-1",
      adapter,
      expectedDeliveryOptions(ownerThreadScope, ownerThreadRef.value, true),
    );
    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      channelType: "telegram",
      channelKey: "chat-1",
      threadId: "owner-topic",
    }));
    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("routes a signed callback in a mention-gated group without treating it as chat history", async () => {
    const callbackData = "v1.details.abc123XYZ789.deadbeefdeadbeef";
    const onGraphReportRequest = vi.fn(async () => undefined);
    const { router, route } = makeFakeRouter({
      kind: "graph_report_requested",
      graphId: "11111111-2222-4333-8444-555555555555",
    });
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeDeps({
      interactiveCallbackRouter: router,
      onGraphReportRequest,
      commandQueue: { enqueue } as never,
      autoReplyEngineConfig: {
        enabled: true,
        groupActivation: "mention-gated",
        customPatterns: [],
        historyInjection: true,
        maxHistoryInjections: 50,
        maxGroupHistoryMessages: 20,
      },
    });
    const msg = makeMsg({
      text: callbackData,
      metadata: {
        isButtonCallback: true,
        callbackData,
        telegramChatType: "supergroup",
        isBotMentioned: false,
      },
    });

    const result = await evaluateInboundGate(
      deps,
      makeAdapter(),
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      SEND_OVERRIDES as never,
    );

    expect(result).toEqual({ action: "handled" });
    expect(route).toHaveBeenCalledTimes(1);
    expect(onGraphReportRequest).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (B) shortId slash path — display + match by shortId, never requestId
// ---------------------------------------------------------------------------

describe("evaluateInboundGate /approve shortId slash path", () => {
  it("does not resolve a same-session request owned by another inbound user", async () => {
    const req = makeRequest({
      callbackOwner: {
        tenantId: "default",
        userId: "user-2",
        channelType: "telegram",
        channelKey: "chat-1",
      },
    });
    const { gate, resolveApproval } = makeFakeGate([req]);
    const deps = makeDeps({ approvalGate: gate as never });

    const result = await evaluateInboundGate(
      deps,
      makeAdapter(),
      makeMsg({ text: "/approve abc123XYZ789" }),
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      SEND_OVERRIDES as never,
    );

    expect(result.action).toBe("handled");
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("lists shortIds (not requestId prefixes) when multiple approvals are pending", async () => {
    const reqA = makeRequest({
      requestId: "aaaaaaaa-2222-4333-8444-555555555555",
      shortId: "AAAA1111aaaa",
      toolName: "agents.delete",
    });
    const reqB = makeRequest({
      requestId: "bbbbbbbb-2222-4333-8444-555555555555",
      shortId: "BBBB2222bbbb",
      toolName: "files.write",
    });
    const { gate } = makeFakeGate([reqA, reqB]);
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/approve" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    const text = vi.mocked(deps.deliveryService.deliverToChannel).mock.calls[0]![2] as string;
    // Lists the 12-char shortIds.
    expect(text).toContain("AAAA1111aaaa");
    expect(text).toContain("BBBB2222bbbb");
    // Never the full requestId nor its 8-char prefix.
    expect(text).not.toContain("aaaaaaaa-2222");
    expect(text).not.toContain("aaaaaaaa");
    expect(text).not.toContain("bbbbbbbb");
  });

  it("/approve <shortId> resolves the request whose shortId === arg and displays the shortId", async () => {
    const req = makeRequest({
      requestId: "11111111-2222-4333-8444-555555555555",
      shortId: "abc123XYZ789",
      toolName: "agents.delete",
    });
    const { gate, resolveApproval } = makeFakeGate([req]);
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/approve abc123XYZ789" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(resolveApproval).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555555",
      true,
      "chat:user-1",
    );
    const text = vi.mocked(deps.deliveryService.deliverToChannel).mock.calls[0]![2] as string;
    expect(text).toContain("abc123XYZ789");
    expect(text).not.toContain("11111111");
  });

  it("does NOT match a requestId-prefix arg (chat no longer accepts requestId prefixes)", async () => {
    const req = makeRequest({
      requestId: "11111111-2222-4333-8444-555555555555",
      shortId: "abc123XYZ789",
    });
    const { gate, resolveApproval } = makeFakeGate([req]);
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
    });
    const adapter = makeAdapter();
    // "11111111" is the requestId prefix — must NOT resolve.
    const msg = makeMsg({ text: "/approve 11111111" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(resolveApproval).not.toHaveBeenCalled();
    const text = vi.mocked(deps.deliveryService.deliverToChannel).mock.calls[0]![2] as string;
    expect(text).toMatch(/No pending approval found/i);
  });

  it("bare /approve with exactly one pending resolves it and displays the shortId", async () => {
    const req = makeRequest({
      requestId: "11111111-2222-4333-8444-555555555555",
      shortId: "abc123XYZ789",
    });
    const { gate, resolveApproval } = makeFakeGate([req]);
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/approve" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(resolveApproval).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555555",
      true,
      "chat:user-1",
    );
    const text = vi.mocked(deps.deliveryService.deliverToChannel).mock.calls[0]![2] as string;
    expect(text).toContain("abc123XYZ789");
    expect(text).not.toContain("11111111");
  });

  it("/approve all keeps batch semantics and resolves every pending request in the session", async () => {
    const reqA = makeRequest({ requestId: "aaaaaaaa-2222-4333-8444-555555555555", shortId: "AAAA1111aaaa" });
    const reqB = makeRequest({ requestId: "bbbbbbbb-2222-4333-8444-555555555555", shortId: "BBBB2222bbbb" });
    const { gate, resolveApproval } = makeFakeGate([reqA, reqB]);
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/approve all" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    const text = vi.mocked(deps.deliveryService.deliverToChannel).mock.calls[0]![2] as string;
    expect(text).toMatch(/Approved 2 pending approval/i);
  });

  it("/deny <shortId> resolves with approved=false and displays the shortId", async () => {
    const req = makeRequest({
      requestId: "11111111-2222-4333-8444-555555555555",
      shortId: "abc123XYZ789",
    });
    const { gate, resolveApproval } = makeFakeGate([req]);
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalGate: gate as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/deny abc123XYZ789" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      TURN_SCOPE,
      TURN_CONVERSATION_REF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SEND_OVERRIDES as any,
    );

    expect(result.action).toBe("handled");
    expect(resolveApproval).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555555",
      false,
      "chat:user-1",
    );
    const text = vi.mocked(deps.deliveryService.deliverToChannel).mock.calls[0]![2] as string;
    expect(text).toContain("abc123XYZ789");
    expect(text).not.toContain("11111111");
  });
});
