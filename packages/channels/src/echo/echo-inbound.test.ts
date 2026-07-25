// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Echo adapter runWithContext wrap.
 *
 * Asserts that injectMessage wraps handler dispatch in runWithContext
 * and that a pre-stamped traceId on msg.metadata.traceId is reused
 * (not overwritten) — defense-in-depth for chaos tests that inject
 * a known traceId for assertion.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { EchoChannelAdapter } from "./echo-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEchoMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "echo-test",
    channelType: "echo",
    senderId: "user-1",
    text: "Hello from echo test",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EchoChannelAdapter -- injectMessage runWithContext wrap", () => {
  it("injectMessage wraps handler dispatch in runWithContext", async () => {
    let ctxTraceId: string | undefined;
    let ctxChannelType: string | undefined;
    let ctxTrustLevel: string | undefined;
    let stampedTraceId: string | undefined;

    const adapter = new EchoChannelAdapter();
    adapter.onMessage(async (m) => {
      const ctx = tryGetContext();
      ctxTraceId = ctx?.traceId;
      ctxChannelType = ctx?.channelType;
      ctxTrustLevel = ctx?.trustLevel;
      stampedTraceId = m.metadata.traceId as string | undefined;
    });

    const msg = makeEchoMsg(); // no traceId in metadata
    await adapter.injectMessage(msg);

    expect(ctxTraceId).toBeDefined();
    expect(ctxTraceId).toBe(stampedTraceId);
    expect(ctxChannelType).toBe("echo");
    expect(ctxTrustLevel).toBe("user");
  });

  it("injectMessage reuses pre-stamped traceId from msg.metadata.traceId", async () => {
    const knownTrace = "550e8400-e29b-41d4-a716-446655440000";
    let observedTrace: string | undefined;

    const adapter = new EchoChannelAdapter();
    adapter.onMessage(async () => {
      observedTrace = tryGetContext()?.traceId;
    });

    const msg = makeEchoMsg({ metadata: { traceId: knownTrace } });
    await adapter.injectMessage(msg);

    expect(observedTrace).toBe(knownTrace);
  });

  it("injectMessage mints a fresh UUID traceId when msg.metadata.traceId is absent", async () => {
    let observedTrace: string | undefined;

    const adapter = new EchoChannelAdapter();
    adapter.onMessage(async () => {
      observedTrace = tryGetContext()?.traceId;
    });

    await adapter.injectMessage(makeEchoMsg());

    expect(observedTrace).toBeDefined();
    expect(observedTrace).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
