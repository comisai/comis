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
 * Build a mock executor that captures the traceId AND the agentId visible inside
 * its execute() call (via tryGetContext()). The agentId capture is the
 * regression hook: the delivery stage (deliverToChannel) reads
 * ctx.agentId off the SAME request ALS the executor runs under to bind the
 * outbound reply → trajectory (the reaction-attribution keystone). If the
 * executor's runWithContext does not thread agentId, ctx.agentId is undefined at
 * delivery → both the direct-ack and the drain bindings fail-closed → a reaction
 * on the reply map-misses (root-caused to the missing agentId on the ALS).
 */
function makeCapturingExecutor(): {
  executor: AgentExecutor;
  getCapturedTraceId: () => string | undefined;
  getCapturedAgentId: () => string | undefined;
} {
  let capturedTraceId: string | undefined;
  let capturedAgentId: string | undefined;
  const executor: AgentExecutor = {
    execute: vi.fn(async () => {
      capturedTraceId = tryGetContext()?.traceId;
      capturedAgentId = tryGetContext()?.agentId;
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
  return {
    executor,
    getCapturedTraceId: () => capturedTraceId,
    getCapturedAgentId: () => capturedAgentId,
  };
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

// ---------------------------------------------------------------------------
// agentId on the request ALS (the reaction-attribution keystone)
// ---------------------------------------------------------------------------
//
// If the executor's runWithContext (execution-execute.ts) threads traceId/
// tenantId/userId/sessionKey/trustLevel/channelType but NOT agentId (even
// though agentId is a parameter), deliverToChannel reads ctx.agentId ===
// undefined → the reply's agentId is never persisted into the queue optionsJson
// AND the direct-ack bind fail-closes (agentId !== null is false) → a reaction
// map-misses. Threading agentId onto the executor's request context puts it on
// the SAME ALS the delivery stage reads. This test fails when ctx.agentId is undefined.

describe("executeLlm — agentId propagation (reaction-attribution keystone)", () => {
  it("threads the resolved agentId onto the request ALS so the delivery stage can bind the reply → trajectory", async () => {
    const { executor, getCapturedAgentId } = makeCapturingExecutor();
    const deps = makeDeps();

    // The ingress scope established by the channel adapter does NOT carry agentId
    // (it is not known at channel ingress — context.ts:38). The EXECUTOR is the
    // component that resolves the agent and must stamp it onto the ALS so the
    // delivery stage (which runs inside this same context) reads the REAL agent.
    await runWithContext(
      {
        traceId: "550e8400-e29b-41d4-a716-446655440010",
        startedAt: systemNowMs(),
        channelType: "echo",
      },
      () =>
        executeLlm(
          deps,
          makeAdapter(),
          makeMessage(),
          makeSessionKey(),
          "mldag", // the resolved agentId for this turn (a NON-default agent)
          executor,
          "user",
          makeBlockStreamCfg(),
          undefined,
          undefined,
          undefined,
          undefined,
        ),
    );

    // The executor (and every component nested in its context, incl. the delivery
    // stage) must see the resolved agentId on the ALS — NOT undefined. This is the
    // load-bearing precondition for the outbound → trajectory binding.
    expect(
      getCapturedAgentId(),
      "executor's request context must carry the resolved agentId (else the reply→trajectory binding fail-closes and reactions never attribute)",
    ).toBe("mldag");
  });
});

// ---------------------------------------------------------------------------
// executeLlm resource-abort delivery-signal recovery
// ---------------------------------------------------------------------------

describe("executeLlm — resource-abort delivery-signal recovery", () => {
  /** Build an executor whose execute() fires the captured execution:aborted
   *  listener mid-run with the given reason, then finishes with that reason. */
  function makeAbortingHarness(reason: string): {
    deps: ExecuteDeps;
    executor: AgentExecutor;
  } {
    let abortListener: ((e: { sessionKey: SessionKey; reason: string }) => void) | undefined;
    const bus = makeEventBus();
    bus.on = vi.fn((event: string, fn: (e: { sessionKey: SessionKey; reason: string }) => void) => {
      if (event === "execution:aborted") abortListener = fn;
      return bus;
    });
    const deps = makeDeps({ eventBus: bus });
    const executor: AgentExecutor = {
      execute: vi.fn(async () => {
        // The bridge's safety gate fires execution:aborted for this session
        // mid-run — the delivery-scoped controller aborts.
        abortListener?.({ sessionKey: makeSessionKey(), reason });
        return {
          response: `[Stopped: ${reason}] Your request was: 'Hello'. Please try again.`,
          sessionKey: makeSessionKey(),
          tokensUsed: { input: 10, output: 5, total: 15 },
          cost: { total: 0.01 },
          stepsExecuted: 1,
          llmCalls: 1,
          finishReason: reason,
        };
      }),
    } as unknown as AgentExecutor;
    return { deps, executor };
  }

  it("mints a FRESH delivery signal for a spend_exceeded abort so the stop notice can reach the user", async () => {
    // Observed live: the spend abort left the delivery signal aborted, the
    // block pacer hard-skipped every block (logging success), and the user got
    // permanent silence — the designed "[Stopped: …]" notice never delivered.
    const { deps, executor } = makeAbortingHarness("spend_exceeded");

    const out = await executeLlm(
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

    expect(out.resourceAborted, "spend_exceeded is a resource abort with a recovered response").toBe(true);
    expect(out.deliverySignal.aborted, "the recovered response must ride a FRESH (non-aborted) delivery signal").toBe(false);
    expect(out.abortReason).toBe("spend_exceeded");
  });

  it("keeps the aborted delivery signal for a non-resource abort (user-cancel semantics unchanged)", async () => {
    const { deps, executor } = makeAbortingHarness("user_cancel");

    const out = await executeLlm(
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

    expect(out.resourceAborted).toBe(false);
    expect(out.deliverySignal.aborted, "a user-cancel abort still suppresses delivery").toBe(true);
  });
});
