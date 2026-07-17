// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for execution-execute.ts (executeLlm stage).
 *
 * Verifies that executeLlm inherits the request context established and
 * enriched by the inbound entry path. The business stage never creates a
 * replacement scope when called without one.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ChannelPort, EventMap, NormalizedMessage, RequestContext, SessionKey } from "@comis/core";
import { tryGetContext, runWithContext, systemNowMs, PerChannelStreamingConfigSchema, TypedEventBus } from "@comis/core";
import { ok } from "@comis/shared";
import type { AgentExecutor } from "@comis/agent";
import type { ExecuteDeps } from "./execution-execute.js";
import { executeLlm } from "./execution-execute.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventBus() {
  const emit = vi.fn((_event: string, _payload: unknown) => true);
  return {
    emit,
    emitSafely: vi.fn((event: string, payload: unknown) => ({
      hadListeners: emit(event, payload),
      failures: [],
    })),
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

function makeResolvedContext(
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    tenantId: "default",
    userId: "user-1",
    sessionKey: "default:user-1:echo-channel-1",
    agentId: "agent-1",
    traceId: "550e8400-e29b-41d4-a716-446655440001",
    startedAt: systemNowMs(),
    trustLevel: "user",
    channelType: "echo",
    deliveryOrigin: {
      channelType: "echo",
      channelId: "echo-channel-1",
      userId: "user-1",
      tenantId: "default",
    },
    ...overrides,
  };
}

function makeBlockStreamCfg() {
  return PerChannelStreamingConfigSchema.parse({});
}

/**
 * Build a mock executor that captures the trace and resolved agent identity
 * visible through the inherited inbound request context.
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
      makeResolvedContext({ traceId: ingressTraceId }),
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

  it("does not manufacture a request context outside an entry scope", async () => {
    const { executor, getCapturedTraceId } = makeCapturingExecutor();
    const deps = makeDeps();

    // Entry points, including schedulers, own their request-context boundary.
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

    expect(getCapturedTraceId()).toBeUndefined();
  });

  it("keeps repeated calls outside an entry scope unscoped", async () => {
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

    expect(get1()).toBeUndefined();
    expect(get2()).toBeUndefined();
  });
});

describe("executeLlm — per-turn lifecycle event isolation", () => {
  function makePendingExecutor(): {
    executor: AgentExecutor;
    release(): void;
  } {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      executor: {
        execute: vi.fn(async () => {
          await pending;
          return {
            response: "ok",
            sessionKey: makeSessionKey(),
            tokensUsed: { input: 10, output: 5, total: 15 },
            cost: { total: 0 },
            stepsExecuted: 0,
            llmCalls: 1,
            finishReason: "stop" as const,
          };
        }),
      },
      release,
    };
  }

  function makeTypingLifecycle() {
    return {
      controller: {
        start: vi.fn(),
        stop: vi.fn(),
        refreshTtl: vi.fn(),
        isActive: true,
        startedAt: 1,
        isSealed: false,
      },
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      dispose: vi.fn(),
    };
  }

  it("refreshes tool typing only for the execution carrying the matching trace id", async () => {
    const eventBus = new TypedEventBus();
    const deps = makeDeps({ eventBus });
    const turnA = makePendingExecutor();
    const turnB = makePendingExecutor();
    const typingA = makeTypingLifecycle();
    const typingB = makeTypingLifecycle();
    const traceA = "550e8400-e29b-41d4-a716-446655440201";
    const traceB = "550e8400-e29b-41d4-a716-446655440202";

    const promiseA = runWithContext({ traceId: traceA, startedAt: systemNowMs(), channelType: "telegram" }, () =>
      executeLlm(
        deps, makeAdapter({ channelType: "telegram" }), makeMessage({ channelType: "telegram" }),
        makeSessionKey(), "agent-1", turnA.executor, "user", makeBlockStreamCfg(),
        undefined, typingA, undefined, undefined,
      ));
    const promiseB = runWithContext({ traceId: traceB, startedAt: systemNowMs(), channelType: "slack" }, () =>
      executeLlm(
        deps, makeAdapter({ channelType: "slack" }), makeMessage({ channelType: "slack" }),
        makeSessionKey(), "agent-1", turnB.executor, "user", makeBlockStreamCfg(),
        undefined, typingB, undefined, undefined,
      ));

    eventBus.emit("tool:started", {
      toolName: "bash",
      toolCallId: "tool-a",
      sessionKey: "default:user-1:echo-channel-1",
      traceId: traceA,
      timestamp: systemNowMs(),
    });
    expect(typingA.controller.refreshTtl).toHaveBeenCalledTimes(1);
    expect(typingB.controller.refreshTtl).not.toHaveBeenCalled();

    eventBus.emit("tool:executed", {
      toolName: "bash",
      toolCallId: "tool-a",
      durationMs: 1,
      success: true,
      sessionKey: "default:user-1:echo-channel-1",
      traceId: traceA,
      timestamp: systemNowMs(),
    });
    turnA.release();
    turnB.release();
    await Promise.all([promiseA, promiseB]);
  });

  it("aborts only the execution matching synchronous trace and channel context", async () => {
    const eventBus = new TypedEventBus();
    const deps = makeDeps({ eventBus });
    const turnA = makePendingExecutor();
    const turnB = makePendingExecutor();
    const traceA = "550e8400-e29b-41d4-a716-446655440211";
    const traceB = "550e8400-e29b-41d4-a716-446655440212";

    const promiseA = runWithContext({ traceId: traceA, startedAt: systemNowMs(), channelType: "telegram" }, () =>
      executeLlm(
        deps, makeAdapter({ channelType: "telegram" }), makeMessage({ channelType: "telegram" }),
        makeSessionKey(), "agent-1", turnA.executor, "user", makeBlockStreamCfg(),
        undefined, undefined, undefined, undefined,
      ));
    const promiseB = runWithContext({ traceId: traceB, startedAt: systemNowMs(), channelType: "slack" }, () =>
      executeLlm(
        deps, makeAdapter({ channelType: "slack" }), makeMessage({ channelType: "slack" }),
        makeSessionKey(), "agent-1", turnB.executor, "user", makeBlockStreamCfg(),
        undefined, undefined, undefined, undefined,
      ));

    runWithContext({ traceId: traceA, startedAt: systemNowMs(), channelType: "telegram" }, () => {
      eventBus.emit("execution:aborted", {
        sessionKey: makeSessionKey(),
        reason: "user_stop",
        agentId: "agent-1",
        timestamp: systemNowMs(),
      });
    });
    turnA.release();
    turnB.release();
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(resultA.deliverySignal.aborted).toBe(true);
    expect(resultB.deliverySignal.aborted).toBe(false);
    resultA.cleanup();
    resultB.cleanup();
  });

  it("routes a stop command abort only to the matching agent in one typed chat", async () => {
    const eventBus = new TypedEventBus();
    const deps = makeDeps({ eventBus });
    const turnA = makePendingExecutor();
    const turnB = makePendingExecutor();
    const traceA = "550e8400-e29b-41d4-a716-446655440221";
    const traceB = "550e8400-e29b-41d4-a716-446655440222";

    const promiseA = runWithContext({ traceId: traceA, startedAt: systemNowMs(), channelType: "telegram" }, () =>
      executeLlm(
        deps, makeAdapter({ channelType: "telegram" }), makeMessage({ channelType: "telegram" }),
        makeSessionKey(), "agent-1", turnA.executor, "user", makeBlockStreamCfg(),
        undefined, undefined, undefined, undefined,
      ));
    const promiseB = runWithContext({ traceId: traceB, startedAt: systemNowMs(), channelType: "telegram" }, () =>
      executeLlm(
        deps, makeAdapter({ channelType: "telegram" }), makeMessage({ channelType: "telegram" }),
        makeSessionKey(), "agent-2", turnB.executor, "user", makeBlockStreamCfg(),
        undefined, undefined, undefined, undefined,
      ));

    runWithContext({
      traceId: "550e8400-e29b-41d4-a716-446655440223",
      startedAt: systemNowMs(),
      channelType: "telegram",
    }, () => eventBus.emit("execution:aborted", {
      sessionKey: makeSessionKey(),
      reason: "user_stop",
      agentId: "agent-1",
      timestamp: systemNowMs(),
    }));
    turnA.release();
    turnB.release();
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(resultA.deliverySignal.aborted).toBe(true);
    expect(resultB.deliverySignal.aborted).toBe(false);
    resultA.cleanup();
    resultB.cleanup();
  });
});

// ---------------------------------------------------------------------------
// agentId inherited from resolved inbound context
// ---------------------------------------------------------------------------
//
describe("executeLlm — resolved agent context", () => {
  it("inherits the resolved agentId from the inbound request scope", async () => {
    const { executor, getCapturedAgentId } = makeCapturingExecutor();
    const deps = makeDeps();

    await runWithContext(
      makeResolvedContext({
        traceId: "550e8400-e29b-41d4-a716-446655440010",
        agentId: "mldag",
      }),
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

    expect(
      getCapturedAgentId(),
      "executor must inherit the resolved agentId used for reply attribution",
    ).toBe("mldag");
  });
});

// ---------------------------------------------------------------------------
// executeLlm resource-abort delivery-signal recovery
// ---------------------------------------------------------------------------

describe("executeLlm — resource-abort delivery-signal recovery", () => {
  /** Build an executor whose execute() fires the captured execution:aborted
   *  listener mid-run with the given reason, then finishes with that reason. */
  function makeAbortingHarness(reason: EventMap["execution:aborted"]["reason"]): {
    deps: ExecuteDeps;
    executor: AgentExecutor;
  } {
    let abortListener: ((event: EventMap["execution:aborted"]) => void) | undefined;
    const bus = makeEventBus();
    bus.on = vi.fn((event: string, fn: (payload: EventMap["execution:aborted"]) => void) => {
      if (event === "execution:aborted") abortListener = fn;
      return bus;
    });
    const deps = makeDeps({ eventBus: bus });
    const executor: AgentExecutor = {
      execute: vi.fn(async () => {
        // The bridge's safety gate fires execution:aborted for this session
        // mid-run — the delivery-scoped controller aborts.
        abortListener?.({
          sessionKey: makeSessionKey(),
          reason,
          agentId: "agent-1",
          timestamp: systemNowMs(),
        });
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

    const out = await runWithContext(makeResolvedContext(), () => executeLlm(
      deps, makeAdapter(), makeMessage(), makeSessionKey(), "agent-1",
      executor, "user", makeBlockStreamCfg(), undefined, undefined,
      undefined, undefined,
    ));

    expect(out.resourceAborted, "spend_exceeded is a resource abort with a recovered response").toBe(true);
    expect(out.deliverySignal.aborted, "the recovered response must ride a FRESH (non-aborted) delivery signal").toBe(false);
    expect(out.abortReason).toBe("spend_exceeded");
  });

  it("mints a fresh delivery signal for a loop-detected recovery response", async () => {
    const { deps, executor } = makeAbortingHarness("loop_detected");

    const out = await runWithContext(makeResolvedContext(), () => executeLlm(
      deps, makeAdapter(), makeMessage(), makeSessionKey(), "agent-1",
      executor, "user", makeBlockStreamCfg(), undefined, undefined,
      undefined, undefined,
    ));

    expect(out.resourceAborted).toBe(true);
    expect(out.deliverySignal.aborted).toBe(false);
    expect(out.abortReason).toBe("loop_detected");
  });

  it("keeps the aborted delivery signal for a non-resource abort (user-stop semantics unchanged)", async () => {
    const { deps, executor } = makeAbortingHarness("user_stop");

    const out = await runWithContext(makeResolvedContext(), () => executeLlm(
      deps, makeAdapter(), makeMessage(), makeSessionKey(), "agent-1",
      executor, "user", makeBlockStreamCfg(), undefined, undefined,
      undefined, undefined,
    ));

    expect(out.resourceAborted).toBe(false);
    expect(out.deliverySignal.aborted, "a user-cancel abort still suppresses delivery").toBe(true);
  });
});
