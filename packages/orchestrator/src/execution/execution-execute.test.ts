// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for execution-execute.ts (executeLlm stage).
 *
 * Verifies that executeLlm reuses the ingress traceId from an outer
 * runWithContext scope rather than minting a fresh randomUUID() mid-pipeline.
 *
 * Tests asserting the traceId-reuse invariant:
 *   1. When called inside an outer runWithContext scope, the executor runs with
 *      the SAME traceId as the outer context (not a fresh mint).
 *   2. When called outside any runWithContext scope, the executor still gets a
 *      valid UUID via the fallback mint.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import { tryGetContext, runWithContext, systemNowMs, PerChannelStreamingConfigSchema } from "@comis/core";
import { ok } from "@comis/shared";
import type { AgentExecutor } from "@comis/agent";
import type { ExecuteDeps } from "./execution-execute.js";
import { executeLlm } from "./execution-execute.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventBus() {
  return {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  } as any;
}

function makeDeps(overrides?: Partial<ExecuteDeps>): ExecuteDeps {
  return {
    eventBus: makeEventBus(),
    logger: createMockLogger(),
    ...overrides,
  } as ExecuteDeps;
}

function makeAdapter(overrides?: Partial<ChannelPort>): ChannelPort {
  return {
    channelId: "echo-channel-1",
    channelType: "echo",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    ...overrides,
  } as any;
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "echo-channel-1",
    channelType: "echo",
    senderId: "sender-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeSessionKey(overrides?: Partial<SessionKey>): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "echo-channel-1",
    ...overrides,
  };
}

function makeBlockStreamCfg() {
  return PerChannelStreamingConfigSchema.parse({});
}

/**
 * Build a mock executor that captures the traceId visible inside its execute()
 * call (via tryGetContext()).
 */
function makeCapturingExecutor(): { executor: AgentExecutor; getCapturedTraceId: () => string | undefined } {
  let capturedTraceId: string | undefined;
  const executor: AgentExecutor = {
    execute: vi.fn(async () => {
      capturedTraceId = tryGetContext()?.traceId;
      return {
        response: "ok",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "echo-channel-1" },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }),
  };
  return { executor, getCapturedTraceId: () => capturedTraceId };
}

// ---------------------------------------------------------------------------
// executeLlm traceId-reuse tests
// ---------------------------------------------------------------------------

describe("executeLlm — traceId propagation", () => {
  it("reuses ingress traceId from outer runWithContext scope", async () => {
    // The ingressTraceId is what channel adapters stamp into the ALS context
    // before dispatching to the orchestrator queue.
    const ingressTraceId = "550e8400-e29b-41d4-a716-446655440001";

    const { executor, getCapturedTraceId } = makeCapturingExecutor();
    const deps = makeDeps();

    // Simulate the outer runWithContext scope that the channel adapter / channel-manager
    // establishes at ingress.
    await runWithContext(
      {
        traceId: ingressTraceId,
        startedAt: systemNowMs(),
        channelType: "echo",
      },
      () =>
        executeLlm(
          deps,
          makeAdapter(),
          makeMessage(),
          makeSessionKey(),
          "agent-1",
          executor,
          "user",
          makeBlockStreamCfg(),
          undefined,
          undefined,
          undefined,
          undefined,
        ),
    );

    // Acceptance: executor must see the ingress traceId, not a fresh mint
    expect(getCapturedTraceId(), "executor should see the ingress traceId (not a fresh mint)").toBe(ingressTraceId);
  });

  it("mints fresh traceId when called outside any runWithContext scope (fallback preserved)", async () => {
    // This tests the fallback: background tasks, scheduler heartbeats, and other
    // callers that invoke the orchestrator without a prior ingress context must
    // still get a valid UUID (the ?? randomUUID() branch).
    const { executor, getCapturedTraceId } = makeCapturingExecutor();
    const deps = makeDeps();

    // No outer runWithContext — simulates a background / scheduler entry point
    await executeLlm(
      deps,
      makeAdapter(),
      makeMessage(),
      makeSessionKey(),
      "agent-1",
      executor,
      "user",
      makeBlockStreamCfg(),
      undefined,
      undefined,
      undefined,
      undefined,
    );

    const traceId = getCapturedTraceId();
    expect(traceId, "executor must still get a valid UUID traceId when no outer context exists").toBeDefined();
    // UUID v4 pattern check
    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("different turns with no outer scope each get independent traceIds", async () => {
    // Verifies the ?? randomUUID() fallback mints a FRESH uuid each call (not reusing
    // a stale one from a prior call).
    const { executor: exec1, getCapturedTraceId: get1 } = makeCapturingExecutor();
    const { executor: exec2, getCapturedTraceId: get2 } = makeCapturingExecutor();
    const deps = makeDeps();

    await executeLlm(
      deps, makeAdapter(), makeMessage(), makeSessionKey(), "agent-1",
      exec1, "user", makeBlockStreamCfg(), undefined, undefined, undefined, undefined,
    );
    await executeLlm(
      deps, makeAdapter(), makeMessage(), makeSessionKey(), "agent-1",
      exec2, "user", makeBlockStreamCfg(), undefined, undefined, undefined, undefined,
    );

    const id1 = get1();
    const id2 = get2();
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    // Each call gets its own UUID (two independent fallback mints)
    expect(id1).not.toBe(id2);
  });
});
