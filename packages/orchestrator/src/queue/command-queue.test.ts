// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the command queue: session serialization, queue modes,
 * overflow integration, lifecycle methods, and lane cleanup.
 *
 * Uses real timers for concurrency tests (fake timers conflict with
 * PQueue's async scheduling). Uses vi.useFakeTimers() only for
 * cleanup/idle tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  NormalizedMessage,
  RequestContext,
  SessionKey,
  QueueConfig,
} from "@comis/core";
import {
  QueueConfigSchema,
  TypedEventBus,
  formatSessionKey,
  runWithContext,
  tryGetContext,
} from "@comis/core";
import { createCommandQueue } from "./command-queue.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
function createDefaultConfig(
  overrides?: Partial<QueueConfig>,
): QueueConfig {
  return QueueConfigSchema.parse({
    cleanupIdleMs: 600_000, // 10 minutes default
    ...overrides,
  });
}

function createMockMessage(
  text: string,
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "test-channel",
    channelType: "telegram",
    senderId: "user1",
    text,
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createRequestContext(
  traceId: string,
  startedAt: number,
): RequestContext {
  return {
    traceId,
    startedAt,
    channelType: "telegram",
    tenantId: "default",
    trustLevel: "admin",
  };
}

function readContextIdentity(): {
  traceId: string | undefined;
  startedAt: number | undefined;
} {
  const context = tryGetContext();
  return {
    traceId: context?.traceId,
    startedAt: context?.startedAt,
  };
}

function createQueuePrincipalContext(
  traceId: string,
  startedAt: number,
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    traceId,
    startedAt,
    channelType: "telegram",
    tenantId: "default",
    userId: "user-a",
    sessionKey: "default:user-a:chan-1",
    agentId: "agent-a",
    clientId: "client-a",
    trustLevel: "user",
    deliveryOrigin: {
      channelType: "telegram",
      channelId: "chan-1",
      userId: "user-a",
      tenantId: "default",
    },
    ...overrides,
  };
}

function readQueuePrincipalIdentity(): {
  traceId: string | undefined;
  channelType: string | undefined;
  agentId: string | undefined;
  clientId: string | undefined;
  trustLevel: RequestContext["trustLevel"] | undefined;
  deliveryOrigin: RequestContext["deliveryOrigin"] | undefined;
} {
  const context = tryGetContext();
  return {
    traceId: context?.traceId,
    channelType: context?.channelType,
    agentId: context?.agentId,
    clientId: context?.clientId,
    trustLevel: context?.trustLevel,
    deliveryOrigin: context?.deliveryOrigin,
  };
}

function createThrowingQueueEventBus(
  eventToThrow: "queue:enqueued" | "queue:dequeued" | "queue:coalesced" | "queue:overflow",
  laterObserver?: () => void,
): TypedEventBus {
  const eventBus = new TypedEventBus();
  eventBus.on(eventToThrow, () => {
    throw new Error(`${eventToThrow} listener failed`);
  });
  eventBus.on(eventToThrow, () => laterObserver?.());
  return eventBus;
}

const SESSION_A: SessionKey = {
  tenantId: "default",
  userId: "user-a",
  channelId: "chan-1",
};

const SESSION_B: SessionKey = {
  tenantId: "default",
  userId: "user-b",
  channelId: "chan-2",
};

const SESSION_C: SessionKey = {
  tenantId: "default",
  userId: "user-c",
  channelId: "chan-3",
};

// ---------------------------------------------------------------------------
// Session serialization
// ---------------------------------------------------------------------------

describe("Session serialization", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("executes handlers sequentially within the same session", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const executionOrder: number[] = [];
    let activeCount = 0;
    let peakConcurrency = 0;

    const handler = (idx: number) => async () => {
      activeCount++;
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      executionOrder.push(idx);
      await delay(30);
      activeCount--;
    };

    // Enqueue 3 messages to the same session concurrently
    const promises = [
      queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", handler(1)),
      queue.enqueue(SESSION_A, createMockMessage("msg-2"), "telegram", handler(2)),
      queue.enqueue(SESSION_A, createMockMessage("msg-3"), "telegram", handler(3)),
    ];

    await Promise.all(promises);
    await queue.shutdown();

    // Verify sequential execution (peak concurrency = 1)
    expect(peakConcurrency).toBe(1);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("executes handlers in parallel across different sessions", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let activeCount = 0;
    let peakConcurrency = 0;
    const started: string[] = [];

    const handler = (label: string) => async () => {
      activeCount++;
      started.push(label);
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      await delay(50);
      activeCount--;
    };

    // Enqueue to two different sessions simultaneously
    const promises = [
      queue.enqueue(SESSION_A, createMockMessage("a"), "telegram", handler("A")),
      queue.enqueue(SESSION_B, createMockMessage("b"), "telegram", handler("B")),
    ];

    await Promise.all(promises);
    await queue.shutdown();

    // Both should have started (parallel)
    expect(peakConcurrency).toBe(2);
  });

  it("respects global concurrency cap (maxConcurrentSessions)", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ maxConcurrentSessions: 2 });
    const queue = createCommandQueue({ eventBus, config });

    let activeCount = 0;
    let peakConcurrency = 0;

    const handler = async () => {
      activeCount++;
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      await delay(80);
      activeCount--;
    };

    // Enqueue to 3 sessions -- only 2 should run concurrently
    const promises = [
      queue.enqueue(SESSION_A, createMockMessage("a"), "telegram", handler),
      queue.enqueue(SESSION_B, createMockMessage("b"), "telegram", handler),
      queue.enqueue(SESSION_C, createMockMessage("c"), "telegram", handler),
    ];

    await Promise.all(promises);
    await queue.shutdown();

    expect(peakConcurrency).toBe(2);
  });

  it("maintains FIFO order within a session", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const executionOrder: string[] = [];

    const handler = (msgs: NormalizedMessage[]) => async () => {
      executionOrder.push(msgs[0]!.text);
      await delay(10);
    };

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const msg = createMockMessage(`msg-${i}`);
      promises.push(
        queue.enqueue(SESSION_A, msg, "telegram", handler([msg])),
      );
    }

    await Promise.all(promises);
    await queue.shutdown();

    expect(executionOrder).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Async request-context ownership
// ---------------------------------------------------------------------------

describe("Async request-context ownership", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("restores each followup message context after waiting in the same lane", async () => {
    const dequeuedTraceIds: Array<string | undefined> = [];
    const eventBus = new TypedEventBus();
    eventBus.on("queue:dequeued", () => {
      dequeuedTraceIds.push(tryGetContext()?.traceId);
    });
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig({ defaultMode: "followup" }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const contextA = createRequestContext(randomUUID(), 1_000);
    const contextB = createRequestContext(randomUUID(), 2_000);
    const observed: Array<ReturnType<typeof readContextIdentity>> = [];
    const receivedAts: number[] = [];

    const first = runWithContext(contextA, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("first"),
        "telegram",
        async (_messages, execution) => {
          observed.push(readContextIdentity());
          receivedAts.push(execution.receivedAt);
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      ),
    );
    await firstStarted.promise;

    const second = runWithContext(contextB, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("second"),
        "telegram",
        async (_messages, execution) => {
          observed.push(readContextIdentity());
          receivedAts.push(execution.receivedAt);
        },
      ),
    );

    releaseFirst.resolve();
    await Promise.all([first, second]);
    await queue.shutdown();

    expect(observed).toEqual([
      { traceId: contextA.traceId, startedAt: contextA.startedAt },
      { traceId: contextB.traceId, startedAt: contextB.startedAt },
    ]);
    expect(receivedAts).toEqual([contextA.startedAt, contextB.startedAt]);
    expect(dequeuedTraceIds).toEqual([contextA.traceId, contextB.traceId]);
  });

  it("serializes different principals that share one persisted session", async () => {
    const queue = createCommandQueue({
      eventBus: createMockEventBus(),
      config: createDefaultConfig({
        defaultMode: "followup",
        maxConcurrentSessions: 3,
      }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const firstContext = createQueuePrincipalContext(randomUUID(), 1_000);
    const secondContext = createQueuePrincipalContext(randomUUID(), 2_000, {
      agentId: "agent-b",
      trustLevel: "admin",
    });
    const executionOrder: string[] = [];

    const first = runWithContext(firstContext, () => queue.enqueue(
      SESSION_A,
      createMockMessage("first"),
      "telegram",
      async () => {
        executionOrder.push("first-started");
        firstStarted.resolve();
        await releaseFirst.promise;
        executionOrder.push("first-finished");
      },
    ));
    await firstStarted.promise;

    const second = runWithContext(secondContext, () => queue.enqueue(
      SESSION_A,
      createMockMessage("second"),
      "telegram",
      async () => {
        executionOrder.push("second-started");
      },
    ));
    await delay(10);

    expect(executionOrder).toEqual(["first-started"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    await queue.shutdown();

    expect(executionOrder).toEqual([
      "first-started",
      "first-finished",
      "second-started",
    ]);
  });

  it("preserves an empty enqueue context instead of borrowing the prior turn", async () => {
    const eventBus = createMockEventBus();
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig({ defaultMode: "followup" }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const contextA = createRequestContext(randomUUID(), 1_000);
    const observed: Array<ReturnType<typeof readContextIdentity>> = [];

    const first = runWithContext(contextA, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("first"),
        "telegram",
        async () => {
          observed.push(readContextIdentity());
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      ),
    );
    await firstStarted.promise;

    const second = queue.enqueue(
      SESSION_A,
      createMockMessage("outside-context"),
      "telegram",
      async () => {
        observed.push(readContextIdentity());
      },
    );

    releaseFirst.resolve();
    await Promise.all([first, second]);
    await queue.shutdown();

    expect(observed).toEqual([
      { traceId: contextA.traceId, startedAt: contextA.startedAt },
      { traceId: undefined, startedAt: undefined },
    ]);
  });

  it("restores context after a message waits at the global session gate", async () => {
    const eventBus = createMockEventBus();
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig({
        defaultMode: "followup",
        maxConcurrentSessions: 1,
      }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const contextA = createRequestContext(randomUUID(), 1_000);
    const contextB = createRequestContext(randomUUID(), 2_000);
    const observed: Array<ReturnType<typeof readContextIdentity>> = [];

    const first = runWithContext(contextA, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("first"),
        "telegram",
        async () => {
          observed.push(readContextIdentity());
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      ),
    );
    await firstStarted.promise;

    const second = runWithContext(contextB, () =>
      queue.enqueue(
        SESSION_B,
        createMockMessage("second"),
        "telegram",
        async () => {
          observed.push(readContextIdentity());
        },
      ),
    );

    releaseFirst.resolve();
    await Promise.all([first, second]);
    await queue.shutdown();

    expect(observed).toEqual([
      { traceId: contextA.traceId, startedAt: contextA.startedAt },
      { traceId: contextB.traceId, startedAt: contextB.startedAt },
    ]);
  });

  it("does not coalesce collect entries across channel principals", async () => {
    const queue = createCommandQueue({
      eventBus: createMockEventBus(),
      config: createDefaultConfig({
        defaultMode: "collect",
        maxConcurrentSessions: 3,
      }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const contexts = {
      first: createQueuePrincipalContext(randomUUID(), 1_000),
      otherChannel: createQueuePrincipalContext(randomUUID(), 2_000, {
        channelType: "discord",
        deliveryOrigin: {
          channelType: "discord",
          channelId: "chan-1",
          userId: "user-a",
          tenantId: "default",
        },
      }),
      samePrincipal: createQueuePrincipalContext(randomUUID(), 3_000),
    };
    const handled: Array<{
      owner: string;
      texts: string[];
      principal: ReturnType<typeof readQueuePrincipalIdentity>;
    }> = [];
    const makeHandler = (owner: string, block = false) =>
      async (messages: NormalizedMessage[]) => {
        handled.push({
          owner,
          texts: messages.map((message) => message.text),
          principal: readQueuePrincipalIdentity(),
        });
        if (block) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      };

    const first = runWithContext(contexts.first, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("first"),
        "telegram",
        makeHandler("first", true),
      ),
    );
    await firstStarted.promise;
    const otherChannel = runWithContext(contexts.otherChannel, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("discord", { channelType: "discord" }),
        "discord",
        makeHandler("discord"),
      ),
    );
    const samePrincipal = runWithContext(contexts.samePrincipal, () =>
      queue.enqueue(
        SESSION_A,
        createMockMessage("same-principal"),
        "telegram",
        makeHandler("same-principal"),
      ),
    );

    const depthBeforeRelease = queue.getQueueDepth(SESSION_A);
    const processingBeforeRelease = queue.isProcessing(SESSION_A);
    let sessionDrainResolved = false;
    const sessionDrain = queue.drain(SESSION_A).then(() => {
      sessionDrainResolved = true;
    });
    await Promise.resolve();
    const drainResolvedBeforeRelease = sessionDrainResolved;

    releaseFirst.resolve();
    await Promise.all([first, otherChannel, samePrincipal, sessionDrain]);
    await queue.drainAll();
    await queue.shutdown();

    expect(depthBeforeRelease).toBe(3);
    expect(processingBeforeRelease).toBe(true);
    expect(drainResolvedBeforeRelease).toBe(false);
    expect(handled).toEqual([
      {
        owner: "first",
        texts: ["first"],
        principal: expect.objectContaining({
          traceId: contexts.first.traceId,
          channelType: "telegram",
          agentId: "agent-a",
          trustLevel: "user",
        }),
      },
      {
        owner: "discord",
        texts: ["discord"],
        principal: expect.objectContaining({
          traceId: contexts.otherChannel.traceId,
          channelType: "discord",
          agentId: "agent-a",
          trustLevel: "user",
        }),
      },
      {
        owner: "same-principal",
        texts: ["same-principal"],
        principal: expect.objectContaining({
          traceId: contexts.samePrincipal.traceId,
          channelType: "telegram",
          agentId: "agent-a",
          trustLevel: "user",
        }),
      },
    ]);
  });

  it.each([
    {
      mismatch: "agent",
      overrides: { agentId: "agent-b" } satisfies Partial<RequestContext>,
    },
    {
      mismatch: "trust",
      overrides: { trustLevel: "admin" } satisfies Partial<RequestContext>,
    },
  ])(
    "does not coalesce collect entries across a same-channel $mismatch principal mismatch",
    async ({ overrides }) => {
      const queue = createCommandQueue({
        eventBus: createMockEventBus(),
        config: createDefaultConfig({
          defaultMode: "collect",
          maxConcurrentSessions: 3,
        }),
      });
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const contexts = {
        first: createQueuePrincipalContext(randomUUID(), 1_000),
        otherPrincipal: createQueuePrincipalContext(
          randomUUID(),
          2_000,
          overrides,
        ),
        samePrincipal: createQueuePrincipalContext(randomUUID(), 3_000),
      };
      const handled: Array<{
        owner: string;
        texts: string[];
        principal: ReturnType<typeof readQueuePrincipalIdentity>;
      }> = [];
      const makeHandler = (owner: string, block = false) =>
        async (messages: NormalizedMessage[]) => {
          handled.push({
            owner,
            texts: messages.map((message) => message.text),
            principal: readQueuePrincipalIdentity(),
          });
          if (block) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
        };

      const first = runWithContext(contexts.first, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("first"),
          "telegram",
          makeHandler("first", true),
        ),
      );
      await firstStarted.promise;
      const otherPrincipal = runWithContext(contexts.otherPrincipal, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("other-principal"),
          "telegram",
          makeHandler("other-principal"),
        ),
      );
      const samePrincipal = runWithContext(contexts.samePrincipal, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("same-principal"),
          "telegram",
          makeHandler("same-principal"),
        ),
      );

      expect(handled.map(({ owner }) => owner)).toEqual(["first"]);
      releaseFirst.resolve();
      await Promise.all([first, otherPrincipal, samePrincipal]);
      await queue.drainAll();
      await queue.shutdown();

      expect(handled.map(({ owner, texts }) => ({ owner, texts }))).toEqual([
        { owner: "first", texts: ["first"] },
        { owner: "other-principal", texts: ["other-principal"] },
        { owner: "same-principal", texts: ["same-principal"] },
      ]);
      expect(handled.map(({ principal }) => principal)).toEqual([
        expect.objectContaining({
          traceId: contexts.first.traceId,
          agentId: contexts.first.agentId,
          trustLevel: contexts.first.trustLevel,
        }),
        expect.objectContaining({
          traceId: contexts.otherPrincipal.traceId,
          agentId: contexts.otherPrincipal.agentId,
          trustLevel: contexts.otherPrincipal.trustLevel,
        }),
        expect.objectContaining({
          traceId: contexts.samePrincipal.traceId,
          agentId: contexts.samePrincipal.agentId,
          trustLevel: contexts.samePrincipal.trustLevel,
        }),
      ]);
    },
  );

  it("uses the SessionKey agent as the no-context queue principal fallback", async () => {
    const queue = createCommandQueue({
      eventBus: createMockEventBus(),
      config: createDefaultConfig({
        defaultMode: "collect",
        maxConcurrentSessions: 3,
      }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const handled: string[] = [];
    const firstSession = { ...SESSION_A, agentId: "agent-a" };
    const secondSession = { ...SESSION_A, agentId: "agent-b" };

    const first = queue.enqueue(
      firstSession,
      createMockMessage("first"),
      "telegram",
      async () => {
        handled.push("agent-a");
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    const second = queue.enqueue(
      secondSession,
      createMockMessage("second"),
      "telegram",
      async () => {
        handled.push("agent-b");
      },
    );
    const handledBeforeRelease = [...handled];

    releaseFirst.resolve();
    await Promise.all([first, second]);
    await queue.drainAll();
    await queue.shutdown();

    expect(handledBeforeRelease).toEqual(["agent-a", "agent-b"]);
    expect(handled).toEqual(["agent-a", "agent-b"]);
  });

  it("collect mode coalesces different traces for one principal and keeps the last owner", async () => {
    const coalescedTraceIds: Array<string | undefined> = [];
    const enqueuePayloads: Array<{ queueDepth: number; timestamp: number }> = [];
    const dequeuePayloads: Array<{ waitTimeMs: number; timestamp: number }> = [];
    const eventBus = new TypedEventBus();
    eventBus.on("queue:coalesced", () => {
      coalescedTraceIds.push(tryGetContext()?.traceId);
    });
    eventBus.on("queue:enqueued", (payload) => {
      enqueuePayloads.push(payload);
    });
    eventBus.on("queue:dequeued", (payload) => {
      dequeuePayloads.push(payload);
    });
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig({ defaultMode: "collect" }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const contexts = {
      A: createQueuePrincipalContext(randomUUID(), 1_000),
      B: createQueuePrincipalContext(randomUUID(), 2_000),
      C: createQueuePrincipalContext(randomUUID(), 3_000),
    };
    const messages = {
      A: createMockMessage("A", { id: "message-a" }),
      B: createMockMessage("B", { id: "message-b" }),
      C: createMockMessage("C", { id: "message-c" }),
    };
    const owners: string[] = [];
    const observed: Array<ReturnType<typeof readContextIdentity>> = [];
    const receivedAts: number[] = [];
    const makeHandler = (owner: "A" | "B" | "C") =>
      async (handledMessages: NormalizedMessage[], execution: { receivedAt: number }) => {
        owners.push(owner);
        observed.push(readContextIdentity());
        receivedAts.push(execution.receivedAt);
        if (owner === "A" && handledMessages[0]?.id === messages.A.id) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      };

    const first = runWithContext(contexts.A, () =>
      queue.enqueue(SESSION_A, messages.A, "telegram", makeHandler("A")),
    );
    await firstStarted.promise;
    const second = await runWithContext(contexts.B, () =>
      queue.enqueue(SESSION_A, messages.B, "telegram", makeHandler("B")),
    );
    const third = await runWithContext(contexts.C, () =>
      queue.enqueue(SESSION_A, messages.C, "telegram", makeHandler("C")),
    );
    await delay(25);

    expect(enqueuePayloads.map((payload) => payload.queueDepth)).toEqual([1, 2, 3]);
    expect(queue.getQueueDepth(SESSION_A)).toBe(3);
    expect(queue.getStats().totalPending).toBe(3);

    releaseFirst.resolve();
    await first;
    await queue.drainAll();
    await queue.shutdown();

    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(owners).toEqual(["A", "C"]);
    expect(observed).toEqual([
      { traceId: contexts.A.traceId, startedAt: contexts.A.startedAt },
      { traceId: contexts.C.traceId, startedAt: contexts.C.startedAt },
    ]);
    expect(receivedAts).toEqual([
      contexts.A.startedAt,
      contexts.B.startedAt,
    ]);
    expect(coalescedTraceIds).toEqual([contexts.C.traceId]);

    expect(dequeuePayloads).toHaveLength(2);
    expect(dequeuePayloads[1]!.waitTimeMs).toBe(
      dequeuePayloads[1]!.timestamp - enqueuePayloads[1]!.timestamp,
    );
  });

  it("steer mode executes a coalesced restart through the last turn owner", async () => {
    const coalescedTraceIds: Array<string | undefined> = [];
    const enqueuePayloads: Array<{ timestamp: number }> = [];
    const dequeuePayloads: Array<{ waitTimeMs: number; timestamp: number }> = [];
    const eventBus = new TypedEventBus();
    eventBus.on("queue:coalesced", () => {
      coalescedTraceIds.push(tryGetContext()?.traceId);
    });
    eventBus.on("queue:enqueued", (payload) => {
      enqueuePayloads.push(payload);
    });
    eventBus.on("queue:dequeued", (payload) => {
      dequeuePayloads.push(payload);
    });
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig({ defaultMode: "steer" }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const contexts = {
      A: createRequestContext(randomUUID(), 1_000),
      B: createRequestContext(randomUUID(), 2_000),
      C: createRequestContext(randomUUID(), 3_000),
    };
    const messages = {
      A: createMockMessage("A", { id: "message-a" }),
      B: createMockMessage("B", { id: "message-b" }),
      C: createMockMessage("C", { id: "message-c" }),
    };
    const owners: string[] = [];
    const observed: Array<ReturnType<typeof readContextIdentity>> = [];
    const receivedAts: number[] = [];
    const makeHandler = (owner: "A" | "B" | "C") =>
      async (handledMessages: NormalizedMessage[], execution: { receivedAt: number }) => {
        owners.push(owner);
        observed.push(readContextIdentity());
        receivedAts.push(execution.receivedAt);
        if (owner === "A" && handledMessages[0]?.id === messages.A.id) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      };

    const first = runWithContext(contexts.A, () =>
      queue.enqueue(SESSION_A, messages.A, "telegram", makeHandler("A")),
    );
    await firstStarted.promise;
    await runWithContext(contexts.B, () =>
      queue.enqueue(SESSION_A, messages.B, "telegram", makeHandler("B")),
    );
    await runWithContext(contexts.C, () =>
      queue.enqueue(SESSION_A, messages.C, "telegram", makeHandler("C")),
    );
    await delay(25);

    releaseFirst.resolve();
    await first;
    await queue.drainAll();
    await queue.shutdown();

    expect(owners).toEqual(["A", "C"]);
    expect(observed).toEqual([
      { traceId: contexts.A.traceId, startedAt: contexts.A.startedAt },
      { traceId: contexts.C.traceId, startedAt: contexts.C.startedAt },
    ]);
    expect(receivedAts).toEqual([
      contexts.A.startedAt,
      contexts.B.startedAt,
    ]);
    expect(coalescedTraceIds).toEqual([contexts.C.traceId]);

    expect(dequeuePayloads).toHaveLength(2);
    expect(dequeuePayloads[1]!.waitTimeMs).toBe(
      dequeuePayloads[1]!.timestamp - enqueuePayloads[1]!.timestamp,
    );
  });

  it.each(["collect", "steer"] as const)(
    "%s mode logs a rejected background execution in the retained turn context",
    async (mode) => {
      const { createMockLogger } = await import(
        "../../../../test/support/mock-logger.js"
      );
      let loggedTraceId: string | undefined;
      const logger = createMockLogger({
        error: vi.fn(() => {
          loggedTraceId = tryGetContext()?.traceId;
        }),
      });
      const eventBus = createMockEventBus();
      const queue = createCommandQueue({
        eventBus,
        logger,
        config: createDefaultConfig({ defaultMode: mode }),
      });
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const contexts = {
        A: createRequestContext(randomUUID(), 1_000),
        B: createRequestContext(randomUUID(), 2_000),
        C: createRequestContext(randomUUID(), 3_000),
      };

      const first = runWithContext(contexts.A, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("first"),
          "telegram",
          async () => {
            firstStarted.resolve();
            await releaseFirst.promise;
          },
        ),
      );
      await firstStarted.promise;
      const queuedB = await runWithContext(contexts.B, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("second"),
          "telegram",
          async () => {},
        ),
      );
      const queuedC = await runWithContext(contexts.C, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("rejected"),
          "telegram",
          async () => {
            throw new Error("background handler rejected");
          },
        ),
      );

      releaseFirst.resolve();
      await first;
      await queue.drainAll();
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            errorKind: "internal",
            hint: expect.any(String),
            err: expect.any(String),
          }),
          "Command queue background execution failed",
        );
      });

      expect(loggedTraceId).toBe(contexts.C.traceId);
      expect(queuedB.ok).toBe(true);
      expect(queuedC.ok).toBe(true);
      expect(queue.getQueueDepth(SESSION_A)).toBe(0);
      await queue.shutdown();
    },
  );

  it("bounds and sanitizes oversized background error text before logging", async () => {
    const { createMockLogger } = await import(
      "../../../../test/support/mock-logger.js"
    );
    const logger = createMockLogger();
    const queue = createCommandQueue({
      eventBus: createMockEventBus(),
      logger,
      config: createDefaultConfig({ defaultMode: "collect" }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secretMarker = `sk-${"a".repeat(40)}`;
    const oversizedError = `${secretMarker}${"x".repeat(1_100_000)}`;

    const first = queue.enqueue(
      SESSION_A,
      createMockMessage("first"),
      "telegram",
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    await queue.enqueue(
      SESSION_A,
      createMockMessage("rejected"),
      "telegram",
      async () => {
        throw new Error(oversizedError);
      },
    );

    releaseFirst.resolve();
    await first;
    await queue.drainAll();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    const logCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const fields = logCall[0] as { err?: unknown };
    const loggedError = typeof fields.err === "string"
      ? fields.err
      : String(logCall[1] ?? "");
    expect(loggedError.length).toBeLessThanOrEqual(1_500);
    expect(loggedError.includes(secretMarker)).toBe(false);
    await queue.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Observational lifecycle events
// ---------------------------------------------------------------------------

describe("Observational lifecycle events", () => {
  it("reports an async queue listener rejection after accepted execution", async () => {
    const { createMockLogger } = await import(
      "../../../../test/support/mock-logger.js"
    );
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    eventBus.on("queue:enqueued", async () => {
      await Promise.resolve();
      throw new Error("async queue observer failed");
    });
    const queue = createCommandQueue({
      eventBus,
      logger,
      config: createDefaultConfig({ defaultMode: "followup" }),
    });

    const result = await queue.enqueue(
      SESSION_A,
      createMockMessage("message"),
      "telegram",
      async () => {},
    );

    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "queue:enqueued",
          subscriberFailurePhase: "async",
          subscriberFailureCount: 1,
        }),
        "Observational event subscriber failed",
      );
    });
    await queue.shutdown();
  });

  it.each(["queue:enqueued", "queue:dequeued"] as const)(
    "%s listener failures do not change accepted message execution",
    async (eventName) => {
      const { createMockLogger } = await import(
        "../../../../test/support/mock-logger.js"
      );
      const logger = createMockLogger();
      const laterObserver = vi.fn();
      const queue = createCommandQueue({
        eventBus: createThrowingQueueEventBus(eventName, laterObserver),
        logger,
        config: createDefaultConfig({ defaultMode: "followup" }),
      });
      const handled = vi.fn(async () => {});

      const result = await queue.enqueue(
        SESSION_A,
        createMockMessage("message"),
        "telegram",
        handled,
      );

      expect(result.ok).toBe(true);
      expect(handled).toHaveBeenCalledOnce();
      expect(laterObserver).toHaveBeenCalledOnce();
      expect(queue.getQueueDepth(SESSION_A)).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorKind: "internal",
          hint: expect.any(String),
          eventName,
          subscriberFailurePhase: "sync",
          subscriberFailureCount: 1,
        }),
        "Observational event subscriber failed",
      );
      await queue.shutdown();
    },
  );

  it("queue:coalesced listener failures do not prevent the retained turn", async () => {
    const { createMockLogger } = await import(
      "../../../../test/support/mock-logger.js"
    );
    const logger = createMockLogger();
    const laterObserver = vi.fn();
    const queue = createCommandQueue({
      eventBus: createThrowingQueueEventBus(
        "queue:coalesced",
        laterObserver,
      ),
      logger,
      config: createDefaultConfig({ defaultMode: "collect" }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const handled: string[] = [];

    const first = queue.enqueue(
      SESSION_A,
      createMockMessage("first"),
      "telegram",
      async () => {
        handled.push("first");
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    const second = await queue.enqueue(
      SESSION_A,
      createMockMessage("second"),
      "telegram",
      async () => {
        handled.push("second");
      },
    );
    releaseFirst.resolve();
    const firstResult = await first;
    await queue.drainAll();

    expect(firstResult.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(handled).toEqual(["first", "second"]);
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(queue.getQueueDepth(SESSION_A)).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "queue:coalesced",
        subscriberFailurePhase: "sync",
        subscriberFailureCount: 1,
      }),
      "Observational event subscriber failed",
    );
    await queue.shutdown();
  });

  it("queue:overflow listener failures do not alter overflow mutation", async () => {
    const { createMockLogger } = await import(
      "../../../../test/support/mock-logger.js"
    );
    const logger = createMockLogger();
    const laterObserver = vi.fn();
    const queue = createCommandQueue({
      eventBus: createThrowingQueueEventBus("queue:overflow", laterObserver),
      logger,
      config: createDefaultConfig({
        defaultMode: "collect",
        defaultOverflow: { maxDepth: 1, policy: "drop-old" },
      }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const handled: string[] = [];

    const first = queue.enqueue(
      SESSION_A,
      createMockMessage("first"),
      "telegram",
      async () => {
        handled.push("first");
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    const second = await queue.enqueue(
      SESSION_A,
      createMockMessage("second"),
      "telegram",
      async () => {
        handled.push("second");
      },
    );
    const third = await queue.enqueue(
      SESSION_A,
      createMockMessage("third"),
      "telegram",
      async () => {
        handled.push("third");
      },
    );

    releaseFirst.resolve();
    await first;
    await queue.drainAll();

    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(handled).toEqual(["first", "third"]);
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(queue.getQueueDepth(SESSION_A)).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueEvent: "queue:overflow" }),
      "Queue lifecycle event listener failed",
    );
    await queue.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Queue modes
// ---------------------------------------------------------------------------

describe("Queue modes", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("followup mode: each message gets its own handler call", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "followup" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];

    const handler = async (msgs: NormalizedMessage[]) => {
      calls.push(msgs);
      await delay(10);
    };

    await Promise.all([
      queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", handler),
      queue.enqueue(SESSION_A, createMockMessage("msg-2"), "telegram", handler),
      queue.enqueue(SESSION_A, createMockMessage("msg-3"), "telegram", handler),
    ]);

    await queue.shutdown();

    // Each message gets its own handler invocation
    expect(calls).toHaveLength(3);
    expect(calls[0]!).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("msg-1");
    expect(calls[1]![0]!.text).toBe("msg-2");
    expect(calls[2]![0]!.text).toBe("msg-3");
  });

  it("collect mode: accumulates messages during execution and coalesces", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "collect" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];
    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let callCount = 0;
    const handler = async (msgs: NormalizedMessage[]) => {
      callCount++;
      calls.push(msgs);
      if (callCount === 1) {
        firstCallResolve!();
        // Simulate long execution so messages accumulate
        await delay(150);
      } else {
        await delay(10);
      }
    };

    // Enqueue msg-1 (idle lane -> executes immediately)
    const p1 = queue.enqueue(
      SESSION_A,
      createMockMessage("msg-1"),
      "telegram",
      handler,
    );

    // Wait for the first handler to start executing
    await firstCallStarted;

    // Enqueue msg-2 and msg-3 while handler is running
    queue.enqueue(
      SESSION_A,
      createMockMessage("msg-2"),
      "telegram",
      handler,
    );
    queue.enqueue(
      SESSION_A,
      createMockMessage("msg-3"),
      "telegram",
      handler,
    );

    await p1;
    await queue.drainAll();
    await queue.shutdown();

    // First call: msg-1 alone
    expect(calls[0]!).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("msg-1");

    // Second call: msg-2 + msg-3 coalesced into one message
    expect(calls).toHaveLength(2);
    expect(calls[1]!).toHaveLength(1);
    expect(calls[1]![0]!.text).toContain("[Message 1]:");
    expect(calls[1]![0]!.text).toContain("[Message 2]:");
  });

  it("steer mode: aborts current execution and coalesces pending messages", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "steer" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];
    let firstHandlerAborted = false;
    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let callCount = 0;
    const handler = async (
      msgs: NormalizedMessage[],
      execution: { signal: AbortSignal },
    ) => {
      callCount++;
      calls.push(msgs);
      if (callCount === 1) {
        firstCallResolve!();
        await new Promise<void>((resolve) => {
          execution.signal.addEventListener("abort", () => {
            firstHandlerAborted = execution.signal.aborted;
            resolve();
          }, { once: true });
        });
      } else {
        await delay(10);
      }
    };

    // Enqueue msg-1 (idle lane -> executes immediately)
    const p1 = queue.enqueue(
      SESSION_A,
      createMockMessage("msg-1"),
      "telegram",
      handler,
    );

    // Wait for handler to start
    await firstCallStarted;

    // Enqueue msg-2 while handler is running -- this triggers abort
    queue.enqueue(
      SESSION_A,
      createMockMessage("msg-2"),
      "telegram",
      handler,
    );

    await p1;
    await queue.drainAll();
    await queue.shutdown();

    // The steer mode should have called the handler at least twice:
    // 1. First with msg-1 (which gets aborted)
    // 2. Second with coalesced msg-2
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0]!.text).toBe("msg-1");
    expect(firstHandlerAborted).toBe(true);

    // Second call should be the coalesced message(s)
    const secondCall = calls[1]!;
    expect(secondCall).toHaveLength(1);
    expect(secondCall[0]!.text).toContain("msg-2");
  });

  it("collect mode with idle session: first message executes immediately", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "collect" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];
    const handler = async (msgs: NormalizedMessage[]) => {
      calls.push(msgs);
    };

    // Enqueue single message to idle lane
    await queue.enqueue(
      SESSION_A,
      createMockMessage("immediate"),
      "telegram",
      handler,
    );

    await queue.shutdown();

    // Should execute immediately (not wait for debounce)
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("immediate");
  });
});

// ---------------------------------------------------------------------------
// Overflow
// ---------------------------------------------------------------------------

describe("Overflow integration", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("emits overflow event when maxDepth is exceeded in collect mode", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({
      defaultMode: "collect",
      defaultOverflow: { maxDepth: 3, policy: "drop-old" },
    });
    const queue = createCommandQueue({ eventBus, config });

    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let isFirst = true;
    const handler = async () => {
      if (isFirst) {
        isFirst = false;
        firstCallResolve!();
        await delay(200);
      }
    };

    // First message starts executing
    const p1 = queue.enqueue(
      SESSION_A,
      createMockMessage("msg-1"),
      "telegram",
      handler,
    );

    await firstCallStarted;

    // Enqueue 5 more messages while first is executing
    for (let i = 2; i <= 6; i++) {
      queue.enqueue(
        SESSION_A,
        createMockMessage(`msg-${i}`),
        "telegram",
        handler,
      );
    }

    await p1;
    await queue.drainAll();
    await queue.shutdown();

    // Verify overflow event was emitted
    const overflowCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );
    expect(overflowCalls.length).toBeGreaterThan(0);

    // Verify at least one overflow has droppedCount > 0
    const hasDrops = overflowCalls.some(
      (call: unknown[]) =>
        (call[1] as { droppedCount: number }).droppedCount > 0,
    );
    expect(hasDrops).toBe(true);
  });

  it.each([
    {
      policy: "drop-old" as const,
      maxDepth: 3,
      pendingLabels: ["B", "C", "D", "E"],
      expectedOwner: "E",
      expectedDepth: 4,
      firstRetainedIndex: 1,
    },
    {
      policy: "drop-new" as const,
      maxDepth: 3,
      pendingLabels: ["B", "C", "D", "E"],
      expectedOwner: "D",
      expectedDepth: 4,
      firstRetainedIndex: 0,
    },
    {
      policy: "summarize" as const,
      maxDepth: 3,
      pendingLabels: ["B", "C", "D", "E"],
      expectedOwner: "E",
      expectedDepth: 2,
      firstRetainedIndex: 0,
    },
  ])(
    "$policy preserves the retained last turn owner and earliest retained enqueue time",
    async ({
      policy,
      maxDepth,
      pendingLabels,
      expectedOwner,
      expectedDepth,
      firstRetainedIndex,
    }) => {
      const eventBus = createMockEventBus();
      const queue = createCommandQueue({
        eventBus,
        config: createDefaultConfig({
          defaultMode: "collect",
          defaultOverflow: { maxDepth, policy },
        }),
      });
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const ownerCalls: string[] = [];
      const ownerContexts: Array<string | undefined> = [];
      const ownerReceivedAts: number[] = [];
      const firstContext = createRequestContext(randomUUID(), 1_000);

      const first = runWithContext(firstContext, () =>
        queue.enqueue(
          SESSION_A,
          createMockMessage("A", { id: "message-a" }),
          "telegram",
          async () => {
            ownerCalls.push("A");
            firstStarted.resolve();
            await releaseFirst.promise;
          },
        ),
      );
      await firstStarted.promise;

      const pendingTurns = pendingLabels.map((label, index) => ({
        label,
        context: createRequestContext(randomUUID(), 2_000 + index),
        message: createMockMessage(label, { id: `message-${label.toLowerCase()}` }),
      }));
      for (const turn of pendingTurns) {
        await runWithContext(turn.context, () =>
          queue.enqueue(
            SESSION_A,
            turn.message,
            "telegram",
            async (_messages, execution) => {
              ownerCalls.push(turn.label);
              ownerContexts.push(tryGetContext()?.traceId);
              ownerReceivedAts.push(execution.receivedAt);
            },
          ),
        );
      }
      await delay(25);

      expect(queue.getQueueDepth(SESSION_A)).toBe(expectedDepth);
      expect(queue.getStats().totalPending).toBe(expectedDepth);

      releaseFirst.resolve();
      await first;
      await queue.drainAll();

      const expectedTurn = pendingTurns.find(
        (turn) => turn.label === expectedOwner,
      )!;
      expect(ownerCalls).toEqual(["A", expectedOwner]);
      expect(ownerContexts).toEqual([expectedTurn.context.traceId]);
      expect(ownerReceivedAts).toEqual([
        pendingTurns[firstRetainedIndex]!.context.startedAt,
      ]);

      const terminalPayloads = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: unknown[]) => call[0] === "message:terminal")
        .map((call: unknown[]) => call[1]);
      if (policy === "drop-old") {
        expect(terminalPayloads).toEqual([
          expect.objectContaining({
            channelType: "telegram",
            channelId: "test-channel",
            sourceMessageId: "message-b",
            outcome: "error",
            reason: "queue_dropped",
          }),
        ]);
      } else if (policy === "drop-new") {
        expect(terminalPayloads).toEqual([
          expect.objectContaining({
            channelType: "telegram",
            channelId: "test-channel",
            sourceMessageId: "message-e",
            outcome: "error",
            reason: "queue_dropped",
          }),
        ]);
      } else {
        expect(terminalPayloads).toEqual([]);
      }

      const enqueuePayloads = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: unknown[]) => call[0] === "queue:enqueued")
        .map((call: unknown[]) => call[1] as { timestamp: number });
      const dequeuePayloads = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: unknown[]) => call[0] === "queue:dequeued")
        .map((call: unknown[]) => call[1] as { waitTimeMs: number; timestamp: number });
      const firstRetainedEnqueue = enqueuePayloads[firstRetainedIndex + 1]!;
      expect(dequeuePayloads[1]!.waitTimeMs).toBe(
        dequeuePayloads[1]!.timestamp - firstRetainedEnqueue.timestamp,
      );
      expect(queue.getQueueDepth(SESSION_A)).toBe(0);
      await queue.shutdown();
    },
  );
});

// ---------------------------------------------------------------------------
// Queue lifecycle
// ---------------------------------------------------------------------------

describe("Queue lifecycle", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("getQueueDepth returns correct count", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let isFirst = true;
    const handler = async () => {
      if (isFirst) {
        isFirst = false;
        firstCallResolve!();
        await delay(100);
      }
    };

    // Enqueue first (starts executing)
    queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", handler);

    await firstCallStarted;

    // Enqueue a second while first is running
    queue.enqueue(SESSION_A, createMockMessage("msg-2"), "telegram", handler);

    // At least one should be queued/executing
    const depth = queue.getQueueDepth(SESSION_A);
    expect(depth).toBeGreaterThanOrEqual(1);

    await queue.drainAll();
    await queue.shutdown();
  });

  it("isProcessing returns true during execution and false after", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let processingDuringExec = false;
    let handlerResolve: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerResolve = resolve;
    });

    const handler = async () => {
      handlerResolve!();
      processingDuringExec = queue.isProcessing(SESSION_A);
      await delay(30);
    };

    const p = queue.enqueue(
      SESSION_A,
      createMockMessage("msg"),
      "telegram",
      handler,
    );

    await handlerStarted;
    await p;

    expect(processingDuringExec).toBe(true);
    expect(queue.isProcessing(SESSION_A)).toBe(false);

    await queue.shutdown();
  });

  it("drain resolves only after all session tasks complete", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const completed: string[] = [];

    const handler = (label: string) => async () => {
      await delay(30);
      completed.push(label);
    };

    // Enqueue 3 messages (don't await the enqueue result)
    queue.enqueue(SESSION_A, createMockMessage("1"), "telegram", handler("1"));
    queue.enqueue(SESSION_A, createMockMessage("2"), "telegram", handler("2"));
    queue.enqueue(SESSION_A, createMockMessage("3"), "telegram", handler("3"));

    // drain should wait until all are done
    await queue.drain(SESSION_A);

    expect(completed).toEqual(["1", "2", "3"]);

    await queue.shutdown();
  });

  it("drainAll resolves after all sessions complete", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const completed: string[] = [];

    const handler = (label: string) => async () => {
      await delay(30);
      completed.push(label);
    };

    queue.enqueue(SESSION_A, createMockMessage("a1"), "telegram", handler("a1"));
    queue.enqueue(SESSION_B, createMockMessage("b1"), "telegram", handler("b1"));

    await queue.drainAll();

    expect(completed).toContain("a1");
    expect(completed).toContain("b1");

    await queue.shutdown();
  });

  it("shutdown rejects new enqueue calls with err()", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    await queue.shutdown();

    const result = await queue.enqueue(
      SESSION_A,
      createMockMessage("after-shutdown"),
      "telegram",
      async () => {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("shut down");
    }
  });

  it("shutdown aborts the signal observed by an active handler", async () => {
    const queue = createCommandQueue({
      eventBus: createMockEventBus(),
      config: createDefaultConfig(),
    });
    const handlerStarted = createDeferred();
    const handlerAborted = createDeferred();
    let observedAborted = false;

    const active = queue.enqueue(
      SESSION_A,
      createMockMessage("active-until-shutdown"),
      "telegram",
      async (_messages, execution) => {
        handlerStarted.resolve();
        await new Promise<void>((resolve) => {
          execution.signal.addEventListener("abort", () => {
            observedAborted = execution.signal.aborted;
            handlerAborted.resolve();
            resolve();
          }, { once: true });
        });
      },
    );

    await handlerStarted.promise;
    await queue.shutdown();
    await handlerAborted.promise;
    const outcome = await active;

    expect(observedAborted).toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it("terminalizes non-cooperative active work once before bounded shutdown returns", async () => {
    vi.useFakeTimers();
    const eventBus = createMockEventBus();
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig(),
    });
    const handlerStarted = createDeferred();
    const releaseHandler = createDeferred();
    const message = createMockMessage("non-cooperative-active", {
      id: "00000000-0000-0000-0000-000000000501",
    });

    const active = queue.enqueue(
      SESSION_A,
      message,
      "telegram",
      async (_messages, execution) => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        execution.sourceTerminalScope.publish(
          "success",
          "execution_completed",
          Date.now(),
        );
      },
    );
    await handlerStarted.promise;

    const shutdown = queue.shutdown();
    await vi.advanceTimersByTimeAsync(3_001);
    await shutdown;

    let terminalPayloads = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === "message:terminal")
      .map((call: unknown[]) => call[1]);
    expect(terminalPayloads).toEqual([
      expect.objectContaining({
        sourceMessageId: message.id,
        outcome: "aborted",
        reason: "queue_aborted",
      }),
    ]);

    releaseHandler.resolve();
    await active;
    terminalPayloads = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === "message:terminal")
      .map((call: unknown[]) => call[1]);
    expect(terminalPayloads).toHaveLength(1);
  });

  it("shares one shutdown operation so concurrent callers cannot republish waiting work", async () => {
    const eventBus = createMockEventBus();
    const queue = createCommandQueue({
      eventBus,
      config: createDefaultConfig({
        defaultMode: "followup",
        maxConcurrentSessions: 1,
      }),
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const waiting = createMockMessage("waiting", {
      id: "00000000-0000-0000-0000-000000000502",
    });
    const first = queue.enqueue(
      SESSION_A,
      createMockMessage("active"),
      "telegram",
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    const second = queue.enqueue(
      SESSION_A,
      waiting,
      "telegram",
      async () => {},
    );
    await delay(10);

    const shutdownA = queue.shutdown();
    const shutdownB = queue.shutdown();
    expect(shutdownB).toBe(shutdownA);
    releaseFirst.resolve();
    await Promise.all([shutdownA, shutdownB, first, second]);

    const waitingTerminals = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === "message:terminal")
      .map((call: unknown[]) => call[1] as { sourceMessageId: string })
      .filter((payload) => payload.sourceMessageId === waiting.id);
    expect(waitingTerminals).toHaveLength(1);
  });

  it.each([
    { boundary: "same session lane", secondSession: SESSION_A, expectedDepth: 2 },
    { boundary: "global session gate", secondSession: SESSION_B, expectedDepth: 1 },
  ])(
    "shutdown settles an accepted enqueue waiting at the $boundary as cancelled",
    async ({ secondSession, expectedDepth }) => {
      const queue = createCommandQueue({
        eventBus: createMockEventBus(),
        config: createDefaultConfig({
          defaultMode: "followup",
          maxConcurrentSessions: 1,
        }),
      });
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const secondHandler = vi.fn(async () => {});

      const first = queue.enqueue(
        SESSION_A,
        createMockMessage("active"),
        "telegram",
        async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      );
      await firstStarted.promise;
      const second = queue.enqueue(
        secondSession,
        createMockMessage("waiting-to-start"),
        "telegram",
        secondHandler,
      );
      await delay(10);
      expect(queue.getQueueDepth(secondSession)).toBe(expectedDepth);

      const shutdown = queue.shutdown();
      releaseFirst.resolve();
      await shutdown;
      await first;

      const outcome = await Promise.race([
        second.then((result) => ({ kind: "settled" as const, result })),
        delay(100).then(() => ({ kind: "timed-out" as const })),
      ]);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind === "settled") {
        expect(outcome.result.ok).toBe(false);
        if (!outcome.result.ok) {
          expect(outcome.result.error.message).toContain("shut down");
        }
      }
      expect(secondHandler).not.toHaveBeenCalled();
    },
  );

  it("lane cleanup removes idle lanes after configured timeout", async () => {
    vi.useFakeTimers();

    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ cleanupIdleMs: 100 });
    const queue = createCommandQueue({ eventBus, config });

    // Enqueue and let it complete
    const handler = async () => {};

    // Use real execution by advancing timers
    const p = queue.enqueue(
      SESSION_A,
      createMockMessage("msg"),
      "telegram",
      handler,
    );

    // Advance timers to let the handler run
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // Verify lane exists
    const statsBefore = queue.getStats();
    expect(statsBefore.activeLanes).toBe(1);

    // Advance past cleanup interval
    await vi.advanceTimersByTimeAsync(200);

    // Lane should be cleaned up
    const statsAfter = queue.getStats();
    expect(statsAfter.activeLanes).toBe(0);

    await queue.shutdown();

    vi.useRealTimers();
  });

  it("getStats returns accurate counts", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let handlerResolve: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerResolve = resolve;
    });

    const handler = async () => {
      handlerResolve!();
      await delay(100);
    };

    // Start execution on session A
    const p = queue.enqueue(
      SESSION_A,
      createMockMessage("msg"),
      "telegram",
      handler,
    );

    await handlerStarted;

    const stats = queue.getStats();
    expect(stats.activeLanes).toBe(1);
    expect(stats.totalExecuting).toBe(1);
    // totalPending includes in-flight (pending in PQueue terms)
    expect(stats.totalPending).toBeGreaterThanOrEqual(1);

    await p;
    await queue.shutdown();
  });

  it("getQueueDepth returns 0 for unknown session", () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const depth = queue.getQueueDepth({
      tenantId: "default",
      userId: "unknown",
      channelId: "unknown",
    });

    expect(depth).toBe(0);

    // Synchronous shutdown is fine since nothing was enqueued
    void queue.shutdown();
  });

  it("isProcessing returns false for unknown session", () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const processing = queue.isProcessing({
      tenantId: "default",
      userId: "unknown",
      channelId: "unknown",
    });

    expect(processing).toBe(false);

    void queue.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Logger lifecycle tracing
// ---------------------------------------------------------------------------

describe("Logger lifecycle tracing", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("emits INFO on enqueue when logger provided", async () => {
    const { createMockLogger } = await import("../../../../test/support/mock-logger.js");
    const logger = createMockLogger();
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config, logger });

    await queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", async () => {});

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "telegram" }),
      expect.any(String),
    );

    await queue.shutdown();
  });

  it("emits DEBUG on shutdown with activeLanes count", async () => {
    const { createMockLogger } = await import("../../../../test/support/mock-logger.js");
    const logger = createMockLogger();
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config, logger });

    await queue.shutdown();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ activeLanes: expect.any(Number) }),
      "Command queue shutting down",
    );
  });
});

// ---------------------------------------------------------------------------
// touchLane (graph parent session keepalive)
// ---------------------------------------------------------------------------

describe("touchLane (graph parent session keepalive)", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("prevents idle cleanup by refreshing lane lastActivityMs", async () => {
    vi.useFakeTimers();

    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ cleanupIdleMs: 100 });
    const queue = createCommandQueue({ eventBus, config });

    // Enqueue and let it complete to create a lane
    const handler = async () => {};
    const p = queue.enqueue(SESSION_A, createMockMessage("msg"), "telegram", handler);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // Verify lane exists
    expect(queue.getStats().activeLanes).toBe(1);

    // Advance to just before cleanup threshold
    await vi.advanceTimersByTimeAsync(80);

    // Touch the lane to refresh its TTL
    queue.touchLane(formatSessionKey(SESSION_A));

    // Advance past original cleanup time (total now > cleanupIdleMs from initial creation)
    await vi.advanceTimersByTimeAsync(80);

    // Lane should still exist because touchLane refreshed lastActivityMs
    expect(queue.getStats().activeLanes).toBe(1);

    // Advance past the cleanup threshold from the touch time
    await vi.advanceTimersByTimeAsync(100);

    // Now the lane should be cleaned up
    expect(queue.getStats().activeLanes).toBe(0);

    await queue.shutdown();
    vi.useRealTimers();
  });

  it("is a no-op for unknown session keys (no crash, no new lane)", () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    // Should not throw
    queue.touchLane("nonexistent-session-key");

    // Should not create a lane
    expect(queue.getStats().activeLanes).toBe(0);

    void queue.shutdown();
  });

  it("is a no-op for a lane that was already reaped", async () => {
    vi.useFakeTimers();

    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ cleanupIdleMs: 100 });
    const queue = createCommandQueue({ eventBus, config });

    // Create and complete a lane
    const handler = async () => {};
    const p = queue.enqueue(SESSION_A, createMockMessage("msg"), "telegram", handler);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(queue.getStats().activeLanes).toBe(1);

    // Let cleanup reap the lane
    await vi.advanceTimersByTimeAsync(200);
    expect(queue.getStats().activeLanes).toBe(0);

    // Touch after reap -- should not throw or create new lane
    queue.touchLane(formatSessionKey(SESSION_A));
    expect(queue.getStats().activeLanes).toBe(0);

    await queue.shutdown();
    vi.useRealTimers();
  });
});
