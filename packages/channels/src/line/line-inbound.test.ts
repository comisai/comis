// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for LINE adapter runWithContext wrap.
 *
 * Asserts that the webhook event handler stamps msg.metadata.traceId
 * and runs handlers inside runWithContext so the traceId propagates
 * via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock("@line/bot-sdk", () => {
  class MockMessagingApiClient {
    pushMessage = vi.fn().mockResolvedValue({});
    replyMessage = vi.fn().mockResolvedValue({});
  }
  class MockMessagingApiBlobClient {
    getMessageContent = vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
    });
  }
  return {
    messagingApi: {
      MessagingApiClient: MockMessagingApiClient,
      MessagingApiBlobClient: MockMessagingApiBlobClient,
    },
    webhook: {},
  };
});

vi.mock("./flex-builder.js", () => ({
  buildFlexMessage: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapLineToNormalized: vi.fn(),
  isMessageEvent: vi.fn(),
}));

vi.mock("./credential-validator.js", () => ({
  validateLineCredentials: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { mapLineToNormalized, isMessageEvent } from "./message-mapper.js";
import { createLineAdapter, type LineAdapterDeps } from "./line-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<LineAdapterDeps>): LineAdapterDeps {
  return {
    channelAccessToken: "line-access-token",
    channelSecret: "line-secret",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "U1234567890abcdef",
    channelType: "line",
    senderId: "U1234567890abcdef",
    text: "Hello LINE",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

function makeWebhookEvent() {
  return {
    type: "message",
    message: {
      id: "msg-1",
      type: "text",
      text: "Hello LINE",
    },
    source: {
      type: "user",
      userId: "U1234567890abcdef",
    },
    timestamp: Date.now(),
    mode: "active",
    webhookEventId: "wh-123",
    deliveryContext: { isRedelivery: false },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("line-adapter -- webhook event runWithContext wrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isMessageEvent).mockReturnValue(true);
  });

  it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapLineToNormalized).mockReturnValue(normalized);

    const adapter = createLineAdapter(makeDeps());
    adapter.onMessage(async (m) => { captured = m; });

    // LINE uses handleWebhookEvents() — call it directly
    await adapter.handleWebhookEvents([makeWebhookEvent() as any]);

    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"line\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapLineToNormalized).mockReturnValue(normalized);

    const adapter = createLineAdapter(makeDeps());
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });

    await adapter.handleWebhookEvents([makeWebhookEvent() as any]);

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("line");
    expect(ctxTrustLevel).toBe("user");
  });
});
