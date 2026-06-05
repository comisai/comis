// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the C4 + R3 interlock helper (Plan 132-04, Task 3). RED-first —
 * drives the not-yet-built `runAfterTurnCompaction`.
 *
 * C4 makes the afterTurn leaf + condense passes DEFERRED by default
 * (`deferCompaction`, seeded in 132-01): they enqueue onto the per-conversation
 * serializer as a detached unit so `afterTurn` RESOLVES before the compaction's
 * store write completes (compaction never blocks the turn). R3 routes the live
 * ingest write through the SAME per-conversation serializer (`runOnConversation`)
 * so the next turn's ingest and the prior turn's deferred compaction can never
 * interleave (Pitfall 2). On a fail-closed rollover the helper emits a
 * content-free `context:dag_degraded` event.
 *
 * The helper is the testable seam the THIN `executor-post-execution.ts` call
 * site invokes (scaffolding all 30+ postExecution deps is impractical — the
 * existing "LCD afterTurn leaf-pass wiring" block uses the same seam pattern). A
 * source-grep test in executor-post-execution.test.ts locks the call into the
 * `if (deps.contextStore)` block.
 */
import { describe, it, expect, vi } from "vitest";
import { runAfterTurnCompaction } from "./lcd-deferred-compaction.js";
import type { ContextStorePort, ContextStoreScope, LcdMessage } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import type { LeafSummarizerDeps } from "../context-engine/lcd-leaf-summarizer.js";

const CONVERSATION_ID = "conv-defer";
const SCOPE: ContextStoreScope = {
  conversationId: CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: CONVERSATION_ID, // conversationId === sessionKey invariant (R3)
};

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1000 } as unknown as AgentMessage;
}

/**
 * A ContextStorePort double recording runOnConversation calls. `runOnConversation`
 * runs `fn()` synchronously (so its side effects fire) but its returned promise
 * resolves on a test-controlled latch — modelling the per-conversation queue's
 * deferred completion so the test can prove afterTurn returns BEFORE the
 * compaction write's slot completes.
 */
function makeSerializingStore(persistedCount = 0): {
  store: ContextStorePort;
  runOnConversationCalls: string[];
  releaseQueue: () => void;
} {
  const runOnConversationCalls: string[] = [];
  let resolveLatch: (() => void) | undefined;
  const latch = new Promise<void>((r) => {
    resolveLatch = r;
  });
  const store: ContextStorePort = {
    append() {
      /* records nothing — the ingest write is exercised via runOnConversation */
    },
    getMessages() {
      return new Array(persistedCount).fill(null) as unknown as LcdMessage[];
    },
    appendLeafSummary: () => "s",
    appendCondensedSummary: () => "s",
    getContextItems: () => [],
    getSummaries: () => [],
    getSummaryChildren: () => [],
    getSummaryMessages: () => [],
    searchLcd: () => [],
    async runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
      runOnConversationCalls.push(conversationId);
      const value = await fn(); // run the body (so ingest append fires) …
      await latch; // … but the queue SLOT completes only when the test releases it
      return value;
    },
  };
  return { store, runOnConversationCalls, releaseQueue: () => resolveLatch?.() };
}

/** A STUB summarizer-deps getter (no network) — present ⇒ the passes are wired. */
function stubSummarizerDeps(logger: ReturnType<typeof createMockLogger>): () => LeafSummarizerDeps {
  return () => ({
    logger: logger as unknown as LeafSummarizerDeps["logger"],
    summarize: async () => "STUB-SUMMARY",
    getModel: () => ({ provider: "anthropic", contextWindow: 1_000, reasoning: true }),
    getApiKey: async () => "test-key",
  });
}

describe("runAfterTurnCompaction — C4 deferral + R3 serializer interlock (Plan 132-04)", () => {
  it("afterTurn resolves before the deferred leaf/condense compaction's store write completes when deferCompaction is true", async () => {
    const { store, releaseQueue } = makeSerializingStore();
    const logger = createMockLogger();
    let deferredCompleted = false;

    // deferCompaction TRUE → the passes enqueue as a DETACHED unit; afterTurn
    // returns immediately, BEFORE the queue slot (and thus the compaction write)
    // completes. We probe ordering by wiring a store whose runOnConversation slot
    // only completes on releaseQueue() — and tracking completion via a then().
    const result = runAfterTurnCompaction({
      store,
      scope: SCOPE,
      conversationId: CONVERSATION_ID,
      live: [userMsg("u0")],
      contextEngine: { deferCompaction: true, contextThreshold: 0.75 } as never,
      deferCompaction: true,
      getSummarizerDeps: stubSummarizerDeps(logger),
      now: 7000,
      logger,
      eventBus: undefined,
    });

    // Attach a completion observer to the helper's returned deferred handle.
    result.deferred?.then(() => {
      deferredCompleted = true;
    });

    // The helper's OWN promise resolves now (afterTurn does NOT block on the
    // deferred compaction) …
    await result.settled;
    // … and the deferred compaction has NOT completed yet (its queue slot is held).
    expect(deferredCompleted).toBe(false);

    // Releasing the queue lets the deferred unit finish — it still runs (eventually).
    releaseQueue();
    await result.deferred;
    expect(deferredCompleted).toBe(true);
  });

  it("with deferCompaction false, the leaf + condense passes complete before afterTurn resolves (inline path retained)", async () => {
    const { store } = makeSerializingStore();
    const logger = createMockLogger();

    // deferCompaction FALSE → the passes run INLINE (awaited). `settled` must not
    // resolve until both passes have run. With this store the passes route the
    // ingest through runOnConversation but the passes themselves run inline; assert
    // the inline path is taken (no `deferred` handle returned).
    const result = runAfterTurnCompaction({
      store,
      scope: SCOPE,
      conversationId: CONVERSATION_ID,
      live: [userMsg("u0")],
      contextEngine: { deferCompaction: false, contextThreshold: 0.75 } as never,
      deferCompaction: false,
      getSummarizerDeps: stubSummarizerDeps(logger),
      now: 7000,
      logger,
      eventBus: undefined,
    });

    // Inline path → no detached deferred handle (the knob is load-bearing).
    expect(result.deferred).toBeUndefined();
    await result.settled; // resolves only after the inline passes ran
  });

  it("the live ingest write and the deferred compaction write are enqueued on the SAME per-conversation serializer", async () => {
    const { store, runOnConversationCalls, releaseQueue } = makeSerializingStore();
    const logger = createMockLogger();

    const result = runAfterTurnCompaction({
      store,
      scope: SCOPE,
      conversationId: CONVERSATION_ID,
      live: [userMsg("u0")],
      contextEngine: { deferCompaction: true, contextThreshold: 0.75 } as never,
      deferCompaction: true,
      getSummarizerDeps: stubSummarizerDeps(logger),
      now: 7000,
      logger,
      eventBus: undefined,
    });
    await result.settled;
    releaseQueue();
    await result.deferred;

    // BOTH the ingest AND the deferred compaction routed through runOnConversation
    // for the SAME conversationId (Pitfall 2 interlock) — at least two calls, all
    // for this conversation.
    expect(runOnConversationCalls.length).toBeGreaterThanOrEqual(2);
    expect(runOnConversationCalls.every((c) => c === CONVERSATION_ID)).toBe(true);
  });

  it("a fail-closed rollover state emits a context:dag_degraded event with identifiers + reason and no content", async () => {
    const { store } = makeSerializingStore();
    const logger = createMockLogger();
    const bus = new TypedEventBus();
    const events: Array<Record<string, unknown>> = [];
    bus.on("context:dag_degraded", (e) => events.push(e as unknown as Record<string, unknown>));

    // A MALFORMED scope (conversationId !== sessionKey) → the ingest fails closed
    // → the helper emits context:dag_degraded (reason fail_closed_rollover).
    const malformedScope: ContextStoreScope = { ...SCOPE, sessionKey: "different-key" };
    const result = runAfterTurnCompaction({
      store,
      scope: malformedScope,
      conversationId: CONVERSATION_ID,
      live: [userMsg("u0")],
      contextEngine: { deferCompaction: false, contextThreshold: 0.75 } as never,
      deferCompaction: false,
      getSummarizerDeps: undefined, // passes gated off — isolate the fail-closed emit
      now: 7000,
      logger,
      eventBus: bus,
    });
    await result.settled;

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      conversationId: CONVERSATION_ID,
      agentId: "agent_a",
      reason: "fail_closed_rollover",
    });
    expect(typeof e.durationMs).toBe("number");
    expect(typeof e.timestamp).toBe("number");
    // Content-free: no message/summary text keys in the payload.
    const keys = Object.keys(e);
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("text");
    expect(keys).not.toContain("messages");
  });
});

void vi;
