// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end trace propagation integration test (TRACE-01).
 *
 * Acceptance criterion (REQUIREMENTS.md TRACE-01):
 *   "grep messageId=<id> daemon.log returns lines all sharing one traceId"
 *
 * This test exercises the complete ALS traceId propagation chain:
 *
 *   EchoChannelAdapter.injectMessage(msg)          [Plan 01-03 wrap]
 *     → runWithContext({ traceId: ingressTraceId })  [adapter ingress]
 *       → onMessage handler (orchestrator boundary)
 *         → executeLlm (execution-execute.ts)        [Plan 01-04 fix]
 *           → runWithContext({ traceId: tryGetContext()?.traceId ?? newUUID })
 *             → executor.execute()                   [ALS scope]
 *               → tryGetContext()?.traceId === ingressTraceId ✓
 *
 * This is the literal TRACE-01 acceptance criterion: every hop from
 * channel adapter ingress through to agent execution carries the SAME
 * traceId that was minted at the adapter ingress.
 *
 * Test scope: ALS propagation boundary contract (no full daemon boot).
 * Uses EchoChannelAdapter (the canonical test adapter) and lightweight mocks.
 *
 * Requires `pnpm build` first — imports from @comis/* dist/.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { EchoChannelAdapter } from "@comis/channels";
import { tryGetContext, systemNowMs, PerChannelStreamingConfigSchema } from "@comis/core";
import { ok } from "@comis/shared";
import type { NormalizedMessage, SessionKey } from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import { executeLlm } from "@comis/orchestrator";
import type { ExecuteDeps } from "@comis/orchestrator";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "echo-test",
    channelType: "echo",
    senderId: "sender-1",
    text: "Hello agent",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "echo-test",
  };
}

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
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      level: "info",
    } as any,
    ...overrides,
  } as ExecuteDeps;
}

/**
 * Build an executor that captures the ALS traceId visible during execute().
 */
function makeCapturingExecutor(): { executor: AgentExecutor; getCapturedTraceId: () => string | undefined } {
  let captured: string | undefined;
  const executor: AgentExecutor = {
    execute: vi.fn(async () => {
      captured = tryGetContext()?.traceId;
      return {
        response: "ok",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "echo-test" },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }),
  };
  return { executor, getCapturedTraceId: () => captured };
}

const DEFAULT_CFG = PerChannelStreamingConfigSchema.parse({});

// ---------------------------------------------------------------------------
// TRACE-01: End-to-end traceId propagation
// ---------------------------------------------------------------------------

describe("TRACE-01 — end-to-end traceId propagation (channel → queue → executor)", () => {
  /**
   * Core acceptance criterion:
   *
   * EchoChannelAdapter.injectMessage stamps a traceId at ingress (Plan 01-03).
   * The registered handler calls executeLlm (Plan 01-04 fix).
   * The executor's execute() sees the SAME traceId via ALS — no re-mint occurs.
   */
  it("executeLlm inherits the Echo adapter ingress traceId end-to-end (TRACE-01)", async () => {
    const echo = new EchoChannelAdapter({ channelId: "echo-test", channelType: "echo" });
    const { executor, getCapturedTraceId } = makeCapturingExecutor();
    const deps = makeDeps();

    // Register an orchestrator-style handler that calls executeLlm.
    // This mirrors channel-manager.ts:269 where the orchestrator registers
    // an onMessage handler that eventually calls executeAndDeliver → executeLlm.
    echo.onMessage(async (msg) => {
      await executeLlm(
        deps,
        echo as any,
        msg,
        makeSessionKey(),
        "agent-1",
        executor,
        "user",
        DEFAULT_CFG,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    // Inject a message WITHOUT a pre-stamped traceId.
    // Echo mints a fresh traceId at ingress and wraps in runWithContext.
    const msg = makeMessage();
    await echo.injectMessage(msg);

    // The injected message's metadata.traceId is what Echo stamped.
    const ingressTraceId = msg.metadata.traceId as string;

    // TRACE-01 acceptance: executor must see the ingress traceId, not a fresh mint
    expect(ingressTraceId, "Echo should stamp metadata.traceId at ingress").toBeDefined();
    expect(ingressTraceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);

    const executorTraceId = getCapturedTraceId();
    expect(executorTraceId, "Executor must see a traceId via ALS").toBeDefined();
    expect(
      executorTraceId,
      `Executor traceId (${executorTraceId}) must equal ingress traceId (${ingressTraceId}) — channel→agent re-mint not allowed`,
    ).toBe(ingressTraceId);
  });

  /**
   * Pre-stamped traceId reuse:
   *
   * When a caller pre-stamps msg.metadata.traceId (e.g., a test harness
   * injecting a known UUID for assertion), the adapter reuses it instead of
   * minting a new one (via getMessageTraceId). The executor must also see
   * this known UUID end-to-end.
   */
  it("pre-stamped msg.metadata.traceId flows through to executor end-to-end (TRACE-01)", async () => {
    const knownTrace = "550e8400-e29b-41d4-a716-446655440099";
    const echo = new EchoChannelAdapter({ channelId: "echo-test", channelType: "echo" });
    const { executor, getCapturedTraceId } = makeCapturingExecutor();
    const deps = makeDeps();

    echo.onMessage(async (msg) => {
      await executeLlm(
        deps,
        echo as any,
        msg,
        makeSessionKey(),
        "agent-1",
        executor,
        "user",
        DEFAULT_CFG,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    // Pre-stamp the traceId — this is the "chaos test / test harness" scenario
    // documented in the Echo adapter (D1, Plan 01-03).
    const msg = makeMessage({ metadata: { traceId: knownTrace } });
    await echo.injectMessage(msg);

    // Adapter should have preserved the pre-stamped traceId
    expect(msg.metadata.traceId).toBe(knownTrace);

    // Executor must see the same known traceId end-to-end
    expect(
      getCapturedTraceId(),
      `Executor must see the known pre-stamped traceId (${knownTrace})`,
    ).toBe(knownTrace);
  });

  /**
   * Independent turns get independent traceIds:
   *
   * Two sequential turns must NOT share the same traceId. Each injectMessage
   * call mints a fresh UUID at ingress, and each executor call sees its own UUID.
   */
  it("two sequential turns each get independent traceIds (no cross-turn contamination)", async () => {
    const echo = new EchoChannelAdapter({ channelId: "echo-test", channelType: "echo" });
    const capturedTraceIds: string[] = [];
    const deps = makeDeps();

    echo.onMessage(async (msg) => {
      const { executor, getCapturedTraceId } = makeCapturingExecutor();
      await executeLlm(
        deps,
        echo as any,
        msg,
        makeSessionKey(),
        "agent-1",
        executor,
        "user",
        DEFAULT_CFG,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      const id = getCapturedTraceId();
      if (id) capturedTraceIds.push(id);
    });

    await echo.injectMessage(makeMessage());
    await echo.injectMessage(makeMessage());

    expect(capturedTraceIds).toHaveLength(2);
    expect(capturedTraceIds[0]).toMatch(/^[0-9a-f]{8}-/i);
    expect(capturedTraceIds[1]).toMatch(/^[0-9a-f]{8}-/i);
    expect(capturedTraceIds[0], "Two sequential turns must not share a traceId").not.toBe(capturedTraceIds[1]);
  });

  /**
   * Policy-deny path (execution-pipeline.ts:~294) also reuses ingress traceId.
   *
   * Exercises the second mint site from OBSERVABILITY_DESIGN.md G1:
   * executeAndDeliver → runWithContext in the policy-deny branch.
   *
   * The chain is: Echo ingress → outer ALS context (ingressTraceId)
   * → executeAndDeliver → policy denies → inner runWithContext →
   * executor.execute() → tryGetContext()?.traceId === ingressTraceId.
   */
  it("policy-deny path in executeAndDeliver also inherits the ingress traceId (TRACE-01)", async () => {
    // This test exercises the second mint site via executeAndDeliver directly.
    // We import executeAndDeliver from @comis/orchestrator and simulate the
    // full outer-scope ALS chain that the Echo adapter + channel-manager establish.
    const { runWithContext, systemNowMs: nowMs } = await import("@comis/core");
    const { executeAndDeliver } = await import("@comis/orchestrator");

    const ingressTraceId = "550e8400-e29b-41d4-a716-446655440088";
    let capturedPolicyDenyTraceId: string | undefined;

    const policyDenyExecutor: AgentExecutor = {
      execute: vi.fn(async () => {
        capturedPolicyDenyTraceId = tryGetContext()?.traceId;
        return {
          response: "policy-deny-response",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "echo-test" },
          tokensUsed: { input: 10, output: 5, total: 15 },
          cost: { total: 0 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        };
      }),
    };

    const eventBus = makeEventBus();
    const deps = {
      eventBus,
      logger: makeDeps().logger,
      deliveryService: {
        deliverToChannel: vi.fn(async () => ok({ ok: true, totalChunks: 0, deliveredChunks: 0, failedChunks: 0, chunks: [], totalChars: 0 })),
        drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
      },
      sendPolicyConfig: {
        enabled: true,
        defaultAction: "deny" as const,
        rules: [],
      },
    } as any;

    const adapter = {
      channelId: "echo-test",
      channelType: "echo",
      start: vi.fn(async () => ok(undefined)),
      stop: vi.fn(async () => ok(undefined)),
      sendMessage: vi.fn(async () => ok("msg-1")),
      editMessage: vi.fn(async () => ok(undefined)),
      onMessage: vi.fn(),
    } as any;

    const msg = makeMessage();
    const sk = makeSessionKey();
    const cfg = DEFAULT_CFG;
    const sendOverrides = {
      get: vi.fn(() => "inherit" as const),
      set: vi.fn(),
      delete: vi.fn(),
    };

    // Simulate the outer ingress context from Echo adapter + channel-manager
    await runWithContext(
      { traceId: ingressTraceId, startedAt: nowMs(), channelType: "echo" },
      () =>
        executeAndDeliver(
          deps,
          adapter,
          msg,
          msg,
          policyDenyExecutor,
          sk,
          "agent-1",
          cfg,
          new Set(),
          sendOverrides,
        ),
    );

    expect(
      capturedPolicyDenyTraceId,
      `Policy-deny executor must see the ingress traceId (${ingressTraceId}), not a fresh mint`,
    ).toBe(ingressTraceId);
  });
});
