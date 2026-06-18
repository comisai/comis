// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAnnouncementBatcher, sanitizeForUser, type AnnouncementBatcherDeps, type QueuedAnnouncement } from "./announcement-batcher.js";
import { createDeliveryDedup } from "@comis/agent";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAnnouncement(overrides: Partial<QueuedAnnouncement> = {}): QueuedAnnouncement {
  return {
    announcementText:
      "[System Message]\nA background task has completed.\n\nTask: test task\nStatus: Success\nResult: done\n\n---\nRuntime: 1.0s | Steps: 3 | Tokens: 500 | Cost: $0.0050 | Session: default:sub-agent-1:sub-agent:1\n\nInform the user about this completed background task. Summarize the result in your own voice. If no user notification is needed, respond with NO_REPLY.",
    announceChannelType: "discord",
    announceChannelId: "chan-123",
    callerAgentId: "agent-main",
    callerSessionKey: "default:user1:chan1",
    runId: "run-1",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AnnouncementBatcherDeps> = {}): AnnouncementBatcherDeps & { announceToParent: ReturnType<typeof vi.fn>; sendToChannel: ReturnType<typeof vi.fn> } {
  return {
    announceToParent: vi.fn().mockResolvedValue(undefined),
    sendToChannel: vi.fn().mockResolvedValue(true),
    debounceMs: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("single announcement delivers immediately after debounce", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement());

    // Before debounce fires: not delivered
    expect(deps.announceToParent).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    // Single item delivers with original text unmodified
    expect(deps.announceToParent.mock.calls[0]![2]).toContain("[System Message]");
    expect(deps.announceToParent.mock.calls[0]![2]).toContain("A background task has completed.");
  });

  it("multiple announcements for same parent are batched", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-3" }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combinedText).toContain("3 background tasks have completed.");
    expect(combinedText).toContain("### Task 1");
    expect(combinedText).toContain("### Task 2");
    expect(combinedText).toContain("### Task 3");
    // System prefix and trailing instruction should be stripped from individual items
    expect(combinedText).not.toMatch(/### Task \d\n\[System Message\]/);
  });

  it("different parent sessions get separate batches", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({
      callerAgentId: "agent-a",
      callerSessionKey: "default:userA:chanA",
      runId: "run-a",
    }));
    batcher.enqueue(makeAnnouncement({
      callerAgentId: "agent-b",
      callerSessionKey: "default:userB:chanB",
      runId: "run-b",
    }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledTimes(2);
  });

  it("flush delivers all pending immediately", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));

    // Don't advance timers -- flush forces delivery
    expect(deps.announceToParent).not.toHaveBeenCalled();

    await batcher.flush();

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combinedText).toContain("2 background tasks have completed.");
  });

  it("pending count reflects queued items", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    expect(batcher.pending).toBe(0);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({
      callerAgentId: "other-agent",
      callerSessionKey: "default:other:chan",
      runId: "run-3",
    }));

    expect(batcher.pending).toBe(3);

    await batcher.flush();

    expect(batcher.pending).toBe(0);
  });

  it("debounce resets on each enqueue", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    // Enqueue first item
    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));

    // Advance 1500ms (less than 2000ms debounce)
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.announceToParent).not.toHaveBeenCalled();

    // Enqueue second item -- resets debounce
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));

    // Advance another 1500ms (3000ms total, but only 1500ms since reset)
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.announceToParent).not.toHaveBeenCalled();

    // Advance remaining 500ms to hit the debounce from the reset
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combinedText).toContain("2 background tasks have completed.");
  });

  // timeout fallback tests (updated for 300s timeout)
  it("single-item delivery falls back to sendToChannel when announceToParent hangs", async () => {
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement());

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    // announceToParent was called
    expect(deps.announceToParent).toHaveBeenCalledOnce();

    // Advance past the 300s timeout
    await vi.advanceTimersByTimeAsync(301_000);

    // sendToChannel should have been called as fallback with sanitized text
    expect(deps.sendToChannel).toHaveBeenCalledOnce();
    const fallbackText = deps.sendToChannel.mock.calls[0]![2] as string;
    // Stripped: no [System Message] prefix
    expect(fallbackText).not.toContain("[System Message]");
    // Stripped: no trailing instruction
    expect(fallbackText).not.toContain("Inform the user about this completed background task.");
    // Sanitized: no session keys, no runtime stats
    expect(fallbackText).not.toContain("Session:");
    expect(fallbackText).not.toMatch(/Runtime:.*Tokens:/);
    expect(fallbackText).not.toMatch(/\bdefault:\w+:\w+:\d+\b/);
    // Fallback extracts "Result:" content
    expect(fallbackText).toContain("done");
  });

  it("multi-item batched delivery falls back to individual sendToChannel calls when announceToParent hangs", async () => {
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-3" }));

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    // announceToParent was called for the batch
    expect(deps.announceToParent).toHaveBeenCalledOnce();

    // Advance past the 300s timeout
    await vi.advanceTimersByTimeAsync(301_000);

    // sendToChannel should have been called once for each item as fallback
    expect(deps.sendToChannel).toHaveBeenCalledTimes(3);
    // Each call uses sanitized text
    for (let i = 0; i < 3; i++) {
      const text = deps.sendToChannel.mock.calls[i]![2] as string;
      expect(text).not.toContain("[System Message]");
      expect(text).not.toContain("Inform the user about this completed background task.");
      expect(text).not.toMatch(/Runtime:.*Tokens:/);
      expect(text).not.toMatch(/\bdefault:\w+:\w+:\d+\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotent success-path delivery (DELIVERY-01).
// A delivered-key Set makes a second delivery of the same idempotencyKey a
// no-op. Mark ONLY on success (Pitfall 3): a both-paths-failed item stays
// un-marked so Plan 02's retry is preserved. undefined keys are never deduped.
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher idempotent delivery (DELIVERY-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pre-enqueue dedup: a SECOND enqueue of an already-delivered key is a no-op (announceToParent stays at 1)", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    // First delivery for key "K".
    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.announceToParent).toHaveBeenCalledOnce();

    // Second enqueue of the SAME key after the first delivered → no-op.
    batcher.enqueue(makeAnnouncement({ runId: "run-2", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledOnce(); // still 1 — second was suppressed
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("in-batch dedup: two items with the SAME key in one batch deliver once for that key", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    // Two same-key items + one distinct-key item land in the same batch window
    // (same caller → same batchKey). The two "K" items must collapse to one.
    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2", idempotencyKey: "K" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-3", idempotencyKey: "OTHER" }));

    await vi.advanceTimersByTimeAsync(2000);

    // One combined announceToParent for the batch; the combined text must NOT
    // contain three "### Task" sections — the duplicate "K" was dropped.
    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combined = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combined).toContain("### Task 1");
    expect(combined).toContain("### Task 2");
    expect(combined).not.toContain("### Task 3"); // only 2 unique keys survived
  });

  it("hasDelivered/markDelivered are exposed and reflect the set", () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    expect(batcher.hasDelivered("K")).toBe(false);
    batcher.markDelivered("K");
    expect(batcher.hasDelivered("K")).toBe(true);
  });

  it("marks a key delivered ONLY after a successful send (single-item success path)", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K" }));
    expect(batcher.hasDelivered("K")).toBe(false); // not yet delivered (before debounce)

    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.announceToParent).toHaveBeenCalledOnce();
    expect(batcher.hasDelivered("K")).toBe(true); // marked after success
  });

  it("does NOT mark delivered when BOTH announceToParent and the fallback sendToChannel fail (retry preserved for Plan 02)", async () => {
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // hangs → fallback
      sendToChannel: vi.fn().mockRejectedValue(new Error("send failed")),
      deadLetterQueue: { enqueue: vi.fn() },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);   // debounce → announceToParent
    await vi.advanceTimersByTimeAsync(301_000); // 300s timeout → fallback sendToChannel (rejects)

    expect(deps.sendToChannel).toHaveBeenCalledOnce();
    // Pitfall 3: a fully-failed delivery must NOT be marked — the key stays open
    // so a later retry (Plan 02) can re-attempt it.
    expect(batcher.hasDelivered("K")).toBe(false);
  });

  it("never dedups an item whose idempotencyKey is undefined (top-level spawns unaffected)", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    // Two undefined-key items for the same caller in separate batch windows —
    // each must deliver (no key to dedup on).
    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: undefined }));
    await vi.advanceTimersByTimeAsync(2000);
    batcher.enqueue(makeAnnouncement({ runId: "run-2", idempotencyKey: undefined }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// WR-03: the delivered-key set must be BOUNDED. Every successful keyed delivery
// adds a `${callerSessionKey}::${runId}` string and nothing evicted it for the
// daemon lifetime — a leak over a 40-hour autonomous run spawning thousands of
// sub-agents. The set must be capped like its siblings (runs MAX_RUNS, the DLQ
// maxEntries). Also: the batcher must accept an INJECTED shared DeliveryDedup so
// the no-batcher success branches + DLQ recovery can mark the SAME set (WR-01/02).
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher deliveredKeys bounding (WR-03)", () => {
  it("does not grow the delivered-key set without bound when an injected dedup is capped", () => {
    const cap = 16;
    const dedup = createDeliveryDedup(cap);
    const deps = makeDeps({ deliveryDedup: dedup });
    const batcher = createAnnouncementBatcher(deps);

    // Drive far more distinct keys than the cap straight through the public
    // markDelivered seam (the success paths funnel through the same sink).
    for (let i = 0; i < cap * 50; i++) batcher.markDelivered(`default:u:c::run-${i}`);

    // The shared set is bounded — it never exceeds the cap.
    expect(dedup.size).toBe(cap);
    // And the most-recent key is retained (FIFO evicts oldest, not newest).
    expect(batcher.hasDelivered(`default:u:c::run-${cap * 50 - 1}`)).toBe(true);
    expect(batcher.hasDelivered("default:u:c::run-0")).toBe(false);
  });

  it("uses an injected DeliveryDedup as the shared delivered-key store", () => {
    const dedup = createDeliveryDedup();
    const deps = makeDeps({ deliveryDedup: dedup });
    const batcher = createAnnouncementBatcher(deps);

    // A key marked directly on the shared dedup is visible to the batcher...
    dedup.mark("X");
    expect(batcher.hasDelivered("X")).toBe(true);
    // ...and a key marked via the batcher is visible on the shared dedup
    // (this is what lets the no-batcher success branches + DLQ recovery share it).
    batcher.markDelivered("Y");
    expect(dedup.has("Y")).toBe(true);
  });

  // NOTE: the default-cap (no-injection) self-bounding of createDeliveryDedup is
  // proven directly + cheaply in packages/agent/src/spawn/announce-key.test.ts
  // (the batcher uses that same primitive as its internal default), so it is not
  // re-driven here through 10k batcher.markDelivered calls.
});

// ---------------------------------------------------------------------------
// Transient/permanent retry classification in the fallback path (DELIVERY-02).
// On a sendToChannel fallback failure the batcher classifies via the injected
// classifyErrorContext: transient → retry-with-backoff (computeRetryBackoff)
// before dead-lettering; permanent → dead-letter immediately with zero retries.
// Both helpers arrive ONLY via AnnouncementBatcherDeps (DI from the daemon
// wiring) — applied in BOTH the single-item and the multi-item-batch branch.
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher transient/permanent retry (DELIVERY-02)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("SINGLE-item transient failure retries with backoff then succeeds (not dead-lettered)", async () => {
    // announceToParent hangs → fallback; sendToChannel rejects once (ETIMEDOUT)
    // then resolves; classify says transient.
    const sendToChannel = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(true);
    const classifyErrorContext = vi.fn().mockReturnValue({ retryable: true });
    const computeRetryBackoff = vi.fn().mockReturnValue(1000);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // hangs → fallback
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 3,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-T", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);    // debounce → announceToParent (hangs)
    await vi.advanceTimersByTimeAsync(301_000); // 300s timeout → fallback sendToChannel (rejects ETIMEDOUT)
    await vi.advanceTimersByTimeAsync(1000);    // backoff sleep → retry sendToChannel (resolves)

    expect(sendToChannel).toHaveBeenCalledTimes(2);   // 1 initial + 1 retry
    expect(computeRetryBackoff).toHaveBeenCalledTimes(1);
    expect(computeRetryBackoff).toHaveBeenCalledWith(1);
    expect(enqueue).not.toHaveBeenCalled();           // NOT dead-lettered
    expect(batcher.hasDelivered("K")).toBe(true);     // marked after retry success
    // delivery_retried fired (transient:true, attempt:1) with the runId.
    const retried = emit.mock.calls.find((c) => c[0] === "subagent:delivery_retried");
    expect(retried).toBeDefined();
    expect(retried![1]).toMatchObject({ runId: "run-T", transient: true, attempt: 1, channelType: "discord" });
  });

  it("SINGLE-item permanent failure dead-letters IMMEDIATELY with zero retries", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("budget exceeded"));
    const classifyErrorContext = vi.fn().mockReturnValue({ retryable: false });
    const computeRetryBackoff = vi.fn().mockReturnValue(1000);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 3,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-P", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(301_000);

    expect(sendToChannel).toHaveBeenCalledTimes(1);   // no retry
    expect(computeRetryBackoff).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();           // dead-lettered immediately
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ runId: "run-P", idempotencyKey: "K" });
    expect(batcher.hasDelivered("K")).toBe(false);
    const dl = emit.mock.calls.find((c) => c[0] === "subagent:delivery_deadlettered");
    expect(dl).toBeDefined();
    expect(dl![1]).toMatchObject({ runId: "run-P", transient: false, attempt: 0, channelType: "discord" });
  });

  it("SINGLE-item exhausted transient dead-letters after maxRetries", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("503"));
    const classifyErrorContext = vi.fn().mockReturnValue({ retryable: true });
    const computeRetryBackoff = vi.fn().mockReturnValue(500);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 2,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-E", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(301_000); // fallback → initial send (rejects)
    await vi.advanceTimersByTimeAsync(500);     // backoff → retry attempt 1 (rejects)
    await vi.advanceTimersByTimeAsync(500);     // backoff → retry attempt 2 (rejects)

    expect(sendToChannel).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(computeRetryBackoff).toHaveBeenCalledTimes(2);
    expect(computeRetryBackoff).toHaveBeenNthCalledWith(1, 1);
    expect(computeRetryBackoff).toHaveBeenNthCalledWith(2, 2);
    expect(enqueue).toHaveBeenCalledOnce();          // finally dead-lettered
    expect(batcher.hasDelivered("K")).toBe(false);   // never marked
    const dl = emit.mock.calls.find((c) => c[0] === "subagent:delivery_deadlettered");
    expect(dl![1]).toMatchObject({ runId: "run-E", transient: true, attempt: 2 });
  });

  it("MULTI-ITEM BATCH: per-item retry/classify runs in the batch fallback branch (A retries+succeeds, B dead-letters immediately)", async () => {
    // Two items coalesce on one batchKey (same caller, distinct runIds). The
    // combined announceToParent rejects → per-item fallback. Item A: ECONNRESET
    // once then resolves (transient → retry → success). Item B: budget (permanent
    // → immediate dead-letter). Proves the multi-item branch (~:268-291) executes
    // the retry/classify logic, with distinct runIds on the two events.
    const sendToChannel = vi.fn().mockImplementation((_type: string, channelId: string) => {
      if (channelId === "chan-A") {
        // First call for A rejects, second resolves.
        const aCalls = sendToChannel.mock.calls.filter((c) => c[1] === "chan-A").length;
        return aCalls === 1 ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve(true);
      }
      // B always rejects (permanent).
      return Promise.reject(new Error("budget exceeded"));
    });
    const classifyErrorContext = vi.fn().mockImplementation((msg: string) =>
      msg.includes("budget") ? { retryable: false } : { retryable: true },
    );
    const computeRetryBackoff = vi.fn().mockReturnValue(1000);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // hangs → batch fallback
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 3,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    // Same caller → same batchKey; distinct runIds + distinct channels + distinct keys.
    batcher.enqueue(makeAnnouncement({ runId: "run-A", idempotencyKey: "KA", announceChannelId: "chan-A" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-B", idempotencyKey: "KB", announceChannelId: "chan-B" }));
    await vi.advanceTimersByTimeAsync(2000);     // debounce → combined announceToParent (hangs)
    await vi.advanceTimersByTimeAsync(301_000);  // 300s timeout → per-item fallback
    await vi.advanceTimersByTimeAsync(1000);     // A's backoff → retry → success

    // A retried + delivered.
    const aCalls = sendToChannel.mock.calls.filter((c) => c[1] === "chan-A").length;
    expect(aCalls).toBe(2); // 1 initial + 1 retry
    expect(batcher.hasDelivered("KA")).toBe(true);
    const aRetried = emit.mock.calls.find((c) => c[0] === "subagent:delivery_retried" && (c[1] as { runId: string }).runId === "run-A");
    expect(aRetried).toBeDefined();
    expect(aRetried![1]).toMatchObject({ runId: "run-A", transient: true, attempt: 1 });

    // B dead-lettered immediately, zero retries.
    const bCalls = sendToChannel.mock.calls.filter((c) => c[1] === "chan-B").length;
    expect(bCalls).toBe(1);
    expect(batcher.hasDelivered("KB")).toBe(false);
    const bDeadLettered = enqueue.mock.calls.find((c) => (c[0] as { runId: string }).runId === "run-B");
    expect(bDeadLettered).toBeDefined();
    expect(bDeadLettered![0]).toMatchObject({ runId: "run-B", idempotencyKey: "KB" });
    const bDl = emit.mock.calls.find((c) => c[0] === "subagent:delivery_deadlettered" && (c[1] as { runId: string }).runId === "run-B");
    expect(bDl![1]).toMatchObject({ runId: "run-B", transient: false, attempt: 0 });
  });

  it("NO-DEPS back-compat: without classifyErrorContext/computeRetryBackoff the fallback is single-attempt then DLQ (single-item)", async () => {
    // No retry deps injected → behaves exactly as pre-DELIVERY-02: one
    // sendToChannel attempt, then DLQ on failure, no retry, no crash.
    const sendToChannel = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendToChannel,
      deadLetterQueue: { enqueue },
      // classifyErrorContext / computeRetryBackoff / eventBus intentionally absent.
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-N", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(301_000);

    expect(sendToChannel).toHaveBeenCalledOnce(); // single attempt, no retry
    expect(enqueue).toHaveBeenCalledOnce();       // DLQ as today
    expect(batcher.hasDelivered("K")).toBe(false);
  });

  it("NO-DEPS back-compat: multi-item batch fallback is single-attempt-per-item then DLQ", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendToChannel,
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2", idempotencyKey: "K2" }));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(301_000);

    expect(sendToChannel).toHaveBeenCalledTimes(2); // one per item, no retries
    expect(enqueue).toHaveBeenCalledTimes(2);       // both dead-lettered
  });
});

// ---------------------------------------------------------------------------
// sanitizeForUser unit tests
// ---------------------------------------------------------------------------

describe("sanitizeForUser", () => {
  it("extracts Summary content from announcement text", () => {
    const text =
      "[System Message]\nA background task has completed.\n\nSummary: The image was generated successfully and saved.\n\n---\nRuntime: 1.0s | Steps: 3 | Tokens: 500 | Cost: $0.0050\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).toContain("The image was generated successfully and saved.");
    expect(result).not.toContain("[System Message]");
    expect(result).not.toContain("Runtime:");
  });

  it("strips subagent markers, session keys, file paths, and stats from extracted text", () => {
    const text =
      "[System Message]\nSummary: [Subagent Result: image_gen] The task at /home/user/.comis/data/output.png completed for session default:user1:discord:123.\nRuntime: 2.5s | Steps: 5 | Tokens: 1200 | Cost: $0.0120\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).not.toContain("[Subagent Result: image_gen]");
    expect(result).not.toContain("default:user1:discord:123");
    expect(result).not.toContain("/home/user/.comis/data/output.png");
    expect(result).not.toMatch(/Runtime:.*Tokens:/);
    expect(result).toContain("The task");
    expect(result).toContain("completed for session");
  });

  it("returns generic fallback when no Summary or Result section found", () => {
    const text = "[System Message]\nSome raw internal metadata only.\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).toBe("A background task completed but the result could not be delivered properly. Please ask me to check on it.");
  });

  it("extracts Result content when no Summary is present", () => {
    const text =
      "[System Message]\nA background task has completed.\n\nTask: web search\nStatus: Success\nResult: Found 3 articles about TypeScript monorepos.\n\n---\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).toContain("Found 3 articles about TypeScript monorepos.");
  });

  it("strips condensation stats from extracted text", () => {
    const text =
      "[System Message]\nSummary: Context was condensed 150 to 50 and 200\u219250 messages were processed.\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).not.toContain("condensed 150 to 50");
    expect(result).not.toMatch(/\d+\u2192\d+\s*messages/);
  });

  it("strips token count and cost patterns", () => {
    const text =
      "[System Message]\nSummary: Task done. Tokens: 1500 in: 1000 out: 500 Cost: $0.015\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).not.toMatch(/Tokens:\s*\d+/);
    expect(result).not.toMatch(/Cost:\s*\$/);
  });
});
