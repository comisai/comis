// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for iMessage adapter runWithContext wrap.
 *
 * Asserts that the onNotification handler stamps msg.metadata.traceId
 * and runs handlers inside runWithContext so the traceId propagates
 * via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

let capturedNotificationHandler: ((notification: any) => void) | undefined;

const mockOnNotification = vi.fn((handler: (n: any) => void) => {
  capturedNotificationHandler = handler;
});
const mockRequest = vi.fn();
const mockStart = vi.fn();
const mockClose = vi.fn();

vi.mock("./imessage-client.js", () => ({
  createImsgClient: vi.fn(() => ({
    start: mockStart,
    close: mockClose,
    request: mockRequest,
    onNotification: mockOnNotification,
  })),
}));

vi.mock("./credential-validator.js", () => ({
  validateIMessageConnection: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapImsgToNormalized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok } from "@comis/shared";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateIMessageConnection } from "./credential-validator.js";
import { mapImsgToNormalized } from "./message-mapper.js";
import { createIMessageAdapter, type IMessageAdapterDeps } from "./imessage-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<IMessageAdapterDeps>): IMessageAdapterDeps {
  return {
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "user@apple.com",
    channelType: "imessage",
    senderId: "sender@apple.com",
    text: "Hello iMessage",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

function makeMessageNotification() {
  return {
    method: "message",
    params: {
      message: {
        guid: "msg-guid-001",
        chatId: "user@apple.com",
        handle: "sender@apple.com",
        text: "Hello iMessage",
        isFromMe: false,
        date: Date.now(),
        attachments: [],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("imessage-adapter -- onNotification runWithContext wrap", () => {
  beforeEach(() => {
    capturedNotificationHandler = undefined;
    vi.clearAllMocks();

    vi.mocked(validateIMessageConnection).mockResolvedValue(
      ok({ platform: "macos", available: true }),
    );
    mockStart.mockResolvedValue(ok(undefined));
    mockClose.mockResolvedValue(ok(undefined));
    mockRequest.mockResolvedValue(ok({}));
  });

  it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapImsgToNormalized).mockReturnValue(normalized);

    const adapter = createIMessageAdapter(makeDeps());
    adapter.onMessage(async (m) => { captured = m; });
    await adapter.start();

    expect(capturedNotificationHandler).toBeDefined();
    capturedNotificationHandler!(makeMessageNotification());

    await new Promise((r) => setTimeout(r, 20));

    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"imessage\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapImsgToNormalized).mockReturnValue(normalized);

    const adapter = createIMessageAdapter(makeDeps());
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });
    await adapter.start();

    capturedNotificationHandler!(makeMessageNotification());

    await new Promise((r) => setTimeout(r, 20));

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("imessage");
    expect(ctxTrustLevel).toBe("user");
  });
});
