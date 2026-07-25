// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Slack adapter runWithContext wrap.
 *
 * Asserts that both the message event handler and the block_actions handler
 * stamp normalized.metadata.traceId and run handlers inside runWithContext
 * so the traceId propagates via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const eventHandlers = new Map<string, (...args: any[]) => void>();
let actionHandler: ((...args: any[]) => void) | null = null;

const mockAppStart = vi.fn();
const mockAppStop = vi.fn();
const mockPostMessage = vi.fn();

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(function () {
    return {
      event(name: string, handler: (...args: unknown[]) => void) {
        eventHandlers.set(name, handler);
      },
      action(_pattern: unknown, handler: (...args: unknown[]) => void) {
        actionHandler = handler;
      },
      start: mockAppStart,
      stop: mockAppStop,
      client: {
        chat: {
          postMessage: mockPostMessage,
          update: vi.fn(),
          delete: vi.fn(),
        },
        pins: { add: vi.fn(), remove: vi.fn() },
        conversations: {
          setTopic: vi.fn(),
          setPurpose: vi.fn(),
          archive: vi.fn(),
          unarchive: vi.fn(),
          create: vi.fn(),
          invite: vi.fn(),
          kick: vi.fn(),
          info: vi.fn(),
          members: vi.fn(),
          history: vi.fn(),
        },
        bookmarks: { add: vi.fn() },
        reactions: { add: vi.fn() },
        files: { uploadV2: vi.fn() },
      },
    };
  }),
}));

vi.mock("./credential-validator.js", () => ({
  validateSlackCredentials: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapSlackToNormalized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok } from "@comis/shared";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateSlackCredentials } from "./credential-validator.js";
import { mapSlackToNormalized } from "./message-mapper.js";
import { createSlackAdapter, type SlackAdapterDeps } from "./slack-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<SlackAdapterDeps>): SlackAdapterDeps {
  return {
    botToken: "xoxb-test-token",
    mode: "socket",
    appToken: "xapp-1-test-token",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeSlackEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "C123ABC",
    user: "U456DEF",
    text: "Hello world",
    ts: "1700000000.123456",
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "C123ABC",
    channelType: "slack",
    senderId: "U456DEF",
    text: "Hello world",
    timestamp: 1700000000000,
    attachments: [],
    metadata: {},
  };
}

function makeBlockAction(overrides: Record<string, unknown> = {}) {
  return {
    action: { action_id: "btn-action", value: "value-1" },
    ack: vi.fn().mockResolvedValue(undefined),
    body: {
      channel: { id: "C123ABC" },
      user: { id: "U456DEF", name: "alice" },
      message: { ts: "1700000000.123456" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("slack-adapter -- message + block_actions runWithContext wrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    actionHandler = null;
    mockAppStart.mockResolvedValue(undefined);
    mockAppStop.mockResolvedValue(undefined);
    vi.mocked(validateSlackCredentials).mockResolvedValue(
      ok({ userId: "U_BOT", teamId: "T1", botId: "B_BOT" }),
    );
  });

  describe("message event handler", () => {
    it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
      let captured: NormalizedMessage | undefined;
      const normalized = makeNormalized();
      vi.mocked(mapSlackToNormalized).mockReturnValue(normalized);

      const adapter = createSlackAdapter(makeDeps());
      adapter.onMessage(async (m) => { captured = m; });
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      expect(messageHandler).toBeDefined();
      await messageHandler!({ event: makeSlackEvent() });

      await new Promise((r) => setTimeout(r, 10));

      expect(typeof captured?.metadata.traceId).toBe("string");
      expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
    });

    it("runs handlers inside runWithContext({ traceId, channelType: \"slack\" })", async () => {
      let ctxTraceId: string | undefined;
      let ctxChannelType: string | undefined;
      let ctxTrustLevel: string | undefined;
      let stampedTraceId: string | undefined;
      const normalized = makeNormalized();
      vi.mocked(mapSlackToNormalized).mockReturnValue(normalized);

      const adapter = createSlackAdapter(makeDeps());
      adapter.onMessage(async (m) => {
        const ctx = tryGetContext();
        ctxTraceId = ctx?.traceId;
        ctxChannelType = ctx?.channelType;
        ctxTrustLevel = ctx?.trustLevel;
        stampedTraceId = m.metadata.traceId;
      });
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      await messageHandler!({ event: makeSlackEvent() });

      await new Promise((r) => setTimeout(r, 10));

      expect(ctxTraceId).toBeDefined();
      expect(ctxTraceId).toBe(stampedTraceId);
      expect(ctxChannelType).toBe("slack");
      expect(ctxTrustLevel).toBe("user");
    });
  });

  describe("block_actions (button) handler", () => {
    it("stamps normalized.metadata.traceId for block actions", async () => {
      let captured: NormalizedMessage | undefined;

      const adapter = createSlackAdapter(makeDeps());
      adapter.onMessage(async (m) => { captured = m; });
      await adapter.start();

      expect(actionHandler).not.toBeNull();
      await actionHandler!(makeBlockAction());

      await new Promise((r) => setTimeout(r, 10));

      expect(typeof captured?.metadata.traceId).toBe("string");
      expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
    });

    it("runs handlers inside runWithContext({ traceId, channelType: \"slack\" }) for block actions", async () => {
      let ctxTraceId: string | undefined;
      let ctxChannelType: string | undefined;
      let ctxTrustLevel: string | undefined;
      let stampedTraceId: string | undefined;

      const adapter = createSlackAdapter(makeDeps());
      adapter.onMessage(async (m) => {
        const ctx = tryGetContext();
        ctxTraceId = ctx?.traceId;
        ctxChannelType = ctx?.channelType;
        ctxTrustLevel = ctx?.trustLevel;
        stampedTraceId = m.metadata.traceId;
      });
      await adapter.start();

      expect(actionHandler).not.toBeNull();
      await actionHandler!(makeBlockAction());

      await new Promise((r) => setTimeout(r, 10));

      expect(ctxTraceId).toBeDefined();
      expect(ctxTraceId).toBe(stampedTraceId);
      expect(ctxChannelType).toBe("slack");
      expect(ctxTrustLevel).toBe("user");
    });
  });
});
