// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApprovalNotifier } from "./approval-notifier.js";
import { TypedEventBus } from "@comis/core";
import type { ChannelPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { ok } from "@comis/shared";

// Mock deliverToChannel to delegate to adapter.sendMessage so existing
// assertions on adapter.sendMessage still work (avoids formatForChannel HTML conversion)
vi.mock("./deliver-to-channel.js", () => ({
  deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string) => {
    const result = await adapter.sendMessage(channelId, text);
    return ok({ ok: true, totalChunks: 1, deliveredChunks: 1, failedChunks: 0, chunks: [{ ok: result.ok, messageId: result.ok ? result.value : undefined, charCount: text.length, retried: false }], totalChars: text.length });
  }),
}));

import { createApprovalNotifier } from "./approval-notifier.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockAdapter(channelType: string): ChannelPort {
  return {
    channelType,
    channelId: `${channelType}-chan-1`,
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(ok(undefined)),
    sendMessage: vi.fn().mockResolvedValue(ok("msg-1")),
    editMessage: vi.fn().mockResolvedValue(ok(undefined)),
    onMessage: vi.fn(),
    addReaction: vi.fn().mockResolvedValue(ok(undefined)),
    removeReaction: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as ChannelPort;
}

function makeApprovalEvent(overrides: Partial<{
  requestId: string;
  toolName: string;
  action: string;
  params: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  trustLevel: string;
  createdAt: number;
  timeoutMs: number;
  channelType: string;
}> = {}) {
  return {
    requestId: overrides.requestId ?? "aaaa-bbbb-cccc-dddd",
    toolName: overrides.toolName ?? "agents.restart",
    action: overrides.action ?? "agents.restart",
    params: overrides.params ?? { agentId: "bot-1" },
    agentId: overrides.agentId ?? "agent-1",
    sessionKey: overrides.sessionKey ?? "default:user1:discord-chan-1",
    trustLevel: overrides.trustLevel ?? "user",
    createdAt: overrides.createdAt ?? Date.now(),
    timeoutMs: overrides.timeoutMs ?? 300_000,
    channelType: overrides.channelType,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let eventBus: TypedEventBus;
let telegramAdapter: ChannelPort;
let logger: ComisLogger;
let notifier: ApprovalNotifier;

beforeEach(() => {
  eventBus = new TypedEventBus();
  telegramAdapter = createMockAdapter("telegram");
  logger = createMockLogger();
});

afterEach(() => {
  notifier?.stop();
});

describe("approval notifier", () => {
  it("sends notification to correct adapter when approval:requested fires with channelType", () => {
    notifier = createApprovalNotifier({
      eventBus,
      getAdapter: (ct) => ct === "telegram" ? telegramAdapter : undefined,
      logger,
    });
    notifier.start();

    eventBus.emit("approval:requested", makeApprovalEvent({ channelType: "telegram" }));

    expect(telegramAdapter.sendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = (telegramAdapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe("discord-chan-1"); // channelId from parsed sessionKey
    expect(text).toContain("Action requires approval: agents.restart");
    expect(text).toContain("Agent: agent-1");
    expect(text).toContain("Tool: agents.restart");
    expect(text).toContain("Timeout: 300s");
    expect(text).toContain("/approve aaaa-bbb");
    expect(text).toContain("/deny aaaa-bbb");
  });

  it("skips notification when channelType is absent (debug log)", () => {
    notifier = createApprovalNotifier({
      eventBus,
      getAdapter: () => telegramAdapter,
      logger,
    });
    notifier.start();

    eventBus.emit("approval:requested", makeApprovalEvent({ channelType: undefined }));

    expect(telegramAdapter.sendMessage).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it("skips notification when no adapter found for channelType", () => {
    notifier = createApprovalNotifier({
      eventBus,
      getAdapter: () => undefined,
      logger,
    });
    notifier.start();

    eventBus.emit("approval:requested", makeApprovalEvent({ channelType: "unknown" }));

    expect(logger.debug).toHaveBeenCalled();
  });

  it("catches and logs sendMessage errors without throwing", async () => {
    const failingAdapter = createMockAdapter("telegram");
    (failingAdapter.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    notifier = createApprovalNotifier({
      eventBus,
      getAdapter: () => failingAdapter,
      logger,
    });
    notifier.start();

    eventBus.emit("approval:requested", makeApprovalEvent({ channelType: "telegram" }));

    // Wait for the promise rejection to be handled
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(warnCall[0]).toHaveProperty("err");
    expect(warnCall[1]).toContain("Failed to send approval notification");
  });

  it("stop() unsubscribes from events", () => {
    notifier = createApprovalNotifier({
      eventBus,
      getAdapter: () => telegramAdapter,
      logger,
    });
    notifier.start();
    notifier.stop();

    eventBus.emit("approval:requested", makeApprovalEvent({ channelType: "telegram" }));

    expect(telegramAdapter.sendMessage).not.toHaveBeenCalled();
  });

  it("handles malformed sessionKey gracefully", () => {
    notifier = createApprovalNotifier({
      eventBus,
      getAdapter: () => telegramAdapter,
      logger,
    });
    notifier.start();

    eventBus.emit("approval:requested", makeApprovalEvent({
      channelType: "telegram",
      sessionKey: "bad",
    }));

    expect(telegramAdapter.sendMessage).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});
