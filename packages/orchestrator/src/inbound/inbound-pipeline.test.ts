// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import type { ChannelPort, NormalizedMessage, DeliveryService } from "@comis/core";
import { ok } from "@comis/shared";

import { matchesResetTrigger, processInboundMessage } from "./inbound-pipeline.js";

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
        ok: true,
        totalChunks: 1,
        deliveredChunks: 1,
        failedChunks: 0,
        chunks: [{ ok: true, messageId: "m1", charCount: text.length, retried: false }],
        totalChars: text.length,
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
});

// ---------------------------------------------------------------------------
// Ack reaction bypass when lifecycle reactions enabled
// ---------------------------------------------------------------------------

function makeMinimalDeps(overrides?: Partial<InboundPipelineDeps>): InboundPipelineDeps {
  return {
    eventBus: {
      emit: vi.fn(() => true),
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
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    },
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
    // Per-test injected DeliveryService fake (see the helper at file top).
    deliveryService: makeFakeDeliveryService(),
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
    sendAttachment: vi.fn(async () => ok("att-1")),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

// ---------------------------------------------------------------------------
// /approve and /deny chat command interception
// ---------------------------------------------------------------------------

function makeMockApprovalGate(
  pendingRequests: Array<{ requestId: string; shortId: string; sessionKey: string; action: string; toolName: string }> = [],
) {
  return {
    resolveApproval: vi.fn(),
    pending: vi.fn(() => pendingRequests),
    getRequest: vi.fn((id: string) => pendingRequests.find((r) => r.requestId === id)),
    // Read helpers — the inbound shortId slash path + button router source.
    getRequestByShortId: vi.fn((sid: string) => pendingRequests.find((r) => r.shortId === sid)),
    pendingForSession: vi.fn((sk: string) => pendingRequests.filter((r) => r.sessionKey === sk)),
  };
}

describe("/approve and /deny command interception", () => {
  // The test msg has senderId: "user-1", channelId: "chat-1", telegramChatType: "private"
  // buildScopedSessionKey (DM, per-channel-peer) produces { tenantId: "default", userId: "user-1", channelId: "chat-1", peerId: "user-1" }
  // formatSessionKey produces "default:user-1:chat-1:peer:user-1"
  const TEST_SESSION_KEY = "default:user-1:chat-1:peer:user-1";
  const PENDING_REQUEST = {
    requestId: "aaaa1234-bbbb-cccc-dddd-eeeeeeeeeeee",
    shortId: "AAAA1234bbbb",
    sessionKey: TEST_SESSION_KEY,
    action: "agents.delete",
    toolName: "agents_manage",
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

  it("/approve all resolves all pending approvals for session", async () => {
    const req1 = { ...PENDING_REQUEST, requestId: "11111111-1111-1111-1111-111111111111" };
    const req2 = { ...PENDING_REQUEST, requestId: "22222222-2222-2222-2222-222222222222" };
    const req3 = {
      requestId: "33333333-3333-3333-3333-333333333333",
      sessionKey: "other:tenant:key",
      action: "files.write",
      toolName: "file_ops",
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

  // -----------------------------------------------------------------------
  // Ambiguous prefix -> warn, do not resolve. The gate uses a filter+length
  // check (not first-match lookup): on >1 match, deliver an "Ambiguous
  // prefix" warning and bail without resolving so the operator cannot
  // silently approve the wrong request when prefixes collide.
  // -----------------------------------------------------------------------
  it("/approve <requestId-prefix> matches NO shortId and resolves nothing (chat speaks shortId only)", async () => {
    const reqA = {
      requestId: "ambig0001-aaaa-bbbb-cccc-111111111111",
      shortId: "AMBIG001aaaa",
      sessionKey: TEST_SESSION_KEY,
      action: "agents.delete",
      toolName: "agents_manage",
    };
    const reqB = {
      requestId: "ambig0002-aaaa-bbbb-cccc-222222222222",
      shortId: "AMBIG002bbbb",
      sessionKey: TEST_SESSION_KEY,
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
      requestId: "denyamb01-aaaa-bbbb-cccc-333333333333",
      shortId: "DENYAMB1cccc",
      sessionKey: TEST_SESSION_KEY,
      action: "agents.delete",
      toolName: "agents_manage",
    };
    const reqB = {
      requestId: "denyamb02-aaaa-bbbb-cccc-444444444444",
      shortId: "DENYAMB2dddd",
      sessionKey: TEST_SESSION_KEY,
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

  it("duplicate_messageId_does_NOT_suppress_processing_Phase1_still_reached", async () => {
    const dedupDetector = createDedupDetector({ windowMs: 10_000, now: () => 1000 });
    const deps = makeMinimalDeps({ dedupDetector });
    const adapter = makeAdapterForTest();
    const msg = makeMsg({ id: "dup-msg-3" });
    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    const firstCallCount = (deps.createExecutor as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstCallCount).toBe(1);

    await processInboundMessage(deps, adapter, msg, new Set(), sendOverrides);

    // createExecutor called again — processing NOT suppressed on duplicate
    const secondCallCount = (deps.createExecutor as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondCallCount).toBe(2);
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
