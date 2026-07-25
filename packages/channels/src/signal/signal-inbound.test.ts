// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Signal adapter runWithContext wrap.
 *
 * Asserts that the SSE poll loop stamps msg.metadata.traceId and runs
 * handlers inside runWithContext so the traceId propagates via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// async generator that yields one SSE event then completes
function makeEventStream(events: { data?: string }[]) {
  return (async function* () {
    for (const ev of events) {
      yield ev;
    }
  })();
}

vi.mock("./signal-client.js", () => ({
  signalHealthCheck: vi.fn(),
  signalRpcRequest: vi.fn(),
  createSignalEventStream: vi.fn(),
}));

vi.mock("./signal-format.js", () => ({
  convertIrToSignalTextStyles: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapSignalToNormalized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok } from "@comis/shared";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { signalHealthCheck, createSignalEventStream } from "./signal-client.js";
import { mapSignalToNormalized } from "./message-mapper.js";
import { createSignalAdapter, type SignalAdapterDeps } from "./signal-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<SignalAdapterDeps>): SignalAdapterDeps {
  return {
    baseUrl: "http://127.0.0.1:8080",
    account: "+15551234567",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "+15559876543",
    channelType: "signal",
    senderId: "+15559876543",
    text: "Hello Signal",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

function makeEnvelope() {
  return JSON.stringify({
    envelope: {
      source: "+15559876543",
      sourceNumber: "+15559876543",
      sourceDevice: 1,
      timestamp: Date.now(),
      dataMessage: {
        timestamp: Date.now(),
        message: "Hello Signal",
        expiresInSeconds: 0,
      },
    },
    account: "+15551234567",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signal-adapter -- SSE poll loop runWithContext wrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signalHealthCheck).mockResolvedValue(ok({ version: "0.11.12" }));
  });

  it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
    let captured: NormalizedMessage | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapSignalToNormalized).mockReturnValue(normalized);
    vi.mocked(createSignalEventStream).mockReturnValue(
      makeEventStream([{ data: makeEnvelope() }]),
    );

    const adapter = createSignalAdapter(makeDeps());
    adapter.onMessage(async (m) => { captured = m; });
    await adapter.start();

    // Give the async SSE loop time to process
    await new Promise((r) => setTimeout(r, 30));

    expect(typeof captured?.metadata.traceId).toBe("string");
    expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("runs handlers inside runWithContext({ traceId, channelType: \"signal\" })", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;
    const normalized = makeNormalized();
    vi.mocked(mapSignalToNormalized).mockReturnValue(normalized);
    vi.mocked(createSignalEventStream).mockReturnValue(
      makeEventStream([{ data: makeEnvelope() }]),
    );

    const adapter = createSignalAdapter(makeDeps());
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });
    await adapter.start();

    await new Promise((r) => setTimeout(r, 30));

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("signal");
    expect(ctxTrustLevel).toBe("user");
  });
});
