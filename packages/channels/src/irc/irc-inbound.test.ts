// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for IRC adapter runWithContext wrap.
 *
 * Asserts that the dispatchMessage function stamps msg.metadata.traceId
 * and runs handlers inside runWithContext so the traceId propagates
 * via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const eventListeners: Record<string, ((...args: any[]) => void)[]> = {};

const mockConnect = vi.fn();
const mockSay = vi.fn();
const mockJoin = vi.fn();
const mockPart = vi.fn();
const mockQuit = vi.fn();
const mockSetTopic = vi.fn();

vi.mock("irc-framework", () => {
  class MockClient {
    user = { nick: "comis" };

    connect = mockConnect;
    say = mockSay;
    join = mockJoin;
    part = mockPart;
    quit = mockQuit;
    setTopic = mockSetTopic;

    on(event: string, callback: (...args: any[]) => void): void {
      if (!eventListeners[event]) {
        eventListeners[event] = [];
      }
      eventListeners[event].push(callback);
    }
  }

  return { Client: MockClient };
});

vi.mock("./message-mapper.js", () => ({
  mapIrcToNormalized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { mapIrcToNormalized } from "./message-mapper.js";
import { createIrcAdapter, type IrcAdapterDeps } from "./irc-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<IrcAdapterDeps>): IrcAdapterDeps {
  return {
    host: "irc.libera.chat",
    nick: "comis",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "#comis",
    channelType: "irc",
    senderId: "user1",
    text: "Hello IRC",
    timestamp: Date.now(),
    attachments: [],
    metadata: { ircTarget: "#comis", ircIsDm: false },
  };
}

/** Clear all captured event listeners */
function clearEventListeners(): void {
  for (const key of Object.keys(eventListeners)) {
    delete eventListeners[key];
  }
}

/** Emit a mock event */
function emitEvent(event: string, ...args: any[]): void {
  for (const listener of eventListeners[event] ?? []) {
    listener(...args);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("irc-adapter -- dispatchMessage runWithContext wrap", () => {
  beforeEach(() => {
    clearEventListeners();
    vi.clearAllMocks();
  });

  it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

    const adapter = createIrcAdapter(makeDeps());
    adapter.onMessage(async (m) => { captured = m; });

    // start() creates the IRC client and registers event handlers;
    // we intercept via the mock. The registered listener callback is what
    // calls dispatchMessage.
    // start() will attempt to connect; we do NOT await its resolution
    // (it hangs waiting for the "registered" event). Trigger the mock
    // "registered" event to simulate a successful connect.
    void adapter.start();
    await new Promise((r) => setTimeout(r, 5));

    // simulate "registered" event to unblock the start() internal promise
    emitEvent("registered", {});
    await new Promise((r) => setTimeout(r, 5));

    // Now emit a message event
    emitEvent("privmsg", { target: "#comis", nick: "user1", message: "Hello IRC", tags: {} });

    await new Promise((r) => setTimeout(r, 20));

    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"irc\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

    const adapter = createIrcAdapter(makeDeps());
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });

    void adapter.start();
    await new Promise((r) => setTimeout(r, 5));
    emitEvent("registered", {});
    await new Promise((r) => setTimeout(r, 5));

    emitEvent("privmsg", { target: "#comis", nick: "user1", message: "Hello IRC", tags: {} });

    await new Promise((r) => setTimeout(r, 20));

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("irc");
    expect(ctxTrustLevel).toBe("user");
  });
});
