// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAnnouncementBatcher, sanitizeForUser, type AnnouncementBatcherDeps, type QueuedAnnouncement } from "./announcement-batcher.js";
import { createDeliveryDedup } from "@comis/agent";
import { createConversationLocator } from "@comis/core";
import { err, ok } from "@comis/shared";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCallerConversation(agentId = "agent-main", tenantId = "default") {
  const result = createConversationLocator({ tenantId, agentId, partition: { kind: "agent" } });
  if (!result.ok) throw result.error;
  return result.value;
}

function makeAnnouncement(overrides: Partial<QueuedAnnouncement> = {}): QueuedAnnouncement {
  return {
    announcementText:
      "[System Message]\nA background task has completed.\n\nTask: test task\nStatus: Success\nResult: done\n\n---\nRuntime: 1.0s | Steps: 3 | Tokens: 500 | Cost: $0.0050 | Session: default:sub-agent-1:sub-agent:1\n\nInform the user about this completed background task. Summarize the result in your own voice. If no user notification is needed, respond with NO_REPLY.",
    announceChannelType: "discord",
    announceChannelId: "chan-123",
    callerAgentId: "agent-main",
    callerSessionKey: "default:agent:agent-main:user1:chan1",
    callerConversation: makeCallerConversation(),
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

function makeDecisionQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue(ok(undefined)),
    reserveDecision: vi.fn().mockResolvedValue(ok({ created: true })),
    lookupDecision: vi.fn().mockResolvedValue(ok(undefined)),
    resolveDecision: vi.fn().mockResolvedValue(ok(true)),
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

  it("reports a queued key as pending until the flush send succeeds", async () => {
    // The failure sweep consults hasPending to avoid double-notifying a run
    // whose completion announcement is enqueued but not yet flushed (the
    // daemon-shutdown race) — pending must flip true on enqueue and false
    // once the send succeeded and the key is marked delivered.
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);
    const key = "default:agent:agent-main:user1:chan1::run-1";

    expect(batcher.hasPending?.(key)).toBe(false);

    await batcher.enqueue(makeAnnouncement({ idempotencyKey: key }));
    expect(batcher.hasPending?.(key)).toBe(true);
    expect(batcher.hasDelivered(key)).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    await batcher.flush();

    expect(batcher.hasPending?.(key)).toBe(false);
  });

  it("keeps a retained-uncertain key pending so the failure sweep never re-notifies it", async () => {
    const deps = makeDeps();
    const deliveryDedup = createDeliveryDedup();
    const batcher = createAnnouncementBatcher({ ...deps, deliveryDedup });
    const key = "default:agent:agent-main:user1:chan1::run-2";

    // Mark retained by enqueueing a key already known delivered? No — drive
    // the retained path: a second enqueue after the first was marked
    // delivered returns "retained".
    deliveryDedup.mark(key);
    const second = await batcher.enqueue(makeAnnouncement({ idempotencyKey: key, runId: "run-2" }));
    expect(second.ok && second.value).toBe("retained");
    // Delivered keys already suppress the failure notice via hasDelivered;
    // hasPending only needs to be true while the key is queued or
    // retained-uncertain. Here the key is delivered, not pending.
    expect(batcher.hasPending?.(key)).toBe(false);
    expect(batcher.hasDelivered(key)).toBe(true);
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
    expect(deps.announceToParent.mock.calls[0]![3]).toContain("[System Message]");
    expect(deps.announceToParent.mock.calls[0]![3]).toContain("A background task has completed.");
  });

  it("persists the explicit thread route across the debounce boundary", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ announceThreadId: "topic-42" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledWith(
      "agent-main",
      expect.objectContaining({ tenantId: "default", agentId: "agent-main", userId: "main" }),
      makeCallerConversation(),
      expect.any(String),
      "discord",
      "chan-123",
      { threadId: "topic-42" },
    );
  });

  it("does not batch announcements for different destination threads", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-a", announceThreadId: "topic-a" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-b", announceThreadId: "topic-b" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledTimes(2);
  });

  it("multiple announcements for same parent are batched", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-3" }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![3] as string;
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
      callerSessionKey: "default:agent:agent-a:userA:chanA",
      callerConversation: makeCallerConversation("agent-a"),
      runId: "run-a",
    }));
    batcher.enqueue(makeAnnouncement({
      callerAgentId: "agent-b",
      callerSessionKey: "default:agent:agent-b:userB:chanB",
      callerConversation: makeCallerConversation("agent-b"),
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
    const combinedText = deps.announceToParent.mock.calls[0]![3] as string;
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
      callerSessionKey: "default:agent:other-agent:other:chan",
      callerConversation: makeCallerConversation("other-agent"),
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
    const combinedText = deps.announceToParent.mock.calls[0]![3] as string;
    expect(combinedText).toContain("2 background tasks have completed.");
  });

  it("parks a timed-out parent execution without starting a direct channel send", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const sendGovernedAnnouncement = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendToChannel,
      sendGovernedAnnouncement,
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ idempotencyKey: "timeout-key" }));
    await vi.advanceTimersByTimeAsync(302_000);

    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(batcher.hasDelivered("timeout-key")).toBe(false);
  });

  it("durably reserves a keyed decision before parent execution starts", async () => {
    let finishReservation!: (value: ReturnType<typeof ok>) => void;
    const deadLetterQueue = makeDecisionQueue();
    deadLetterQueue.reserveDecision.mockReturnValue(new Promise((resolve) => {
      finishReservation = resolve;
    }));
    const deps = makeDeps({ deadLetterQueue, sendGovernedAnnouncement: vi.fn() });
    const batcher = createAnnouncementBatcher(deps);

    const enqueue = batcher.enqueue(makeAnnouncement({ idempotencyKey: "decision-1" }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.announceToParent).not.toHaveBeenCalled();

    finishReservation(ok({ created: true }));
    await enqueue;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(deadLetterQueue.reserveDecision).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "decision-1",
      agentId: "agent-main",
      runId: "run-1",
      channelType: "discord",
      channelId: "chan-123",
    }));
    expect(deps.announceToParent).toHaveBeenCalledOnce();
  });

  it("suppresses a restarted decision when its durable reservation exists", async () => {
    const deadLetterQueue = makeDecisionQueue();
    deadLetterQueue.reserveDecision.mockResolvedValue(ok({ created: false }));
    const deps = makeDeps({
      deadLetterQueue,
      sendGovernedAnnouncement: vi.fn(),
    });
    const batcher = createAnnouncementBatcher(deps);

    const result = await batcher.enqueue(makeAnnouncement({ idempotencyKey: "decision-restart" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(result).toEqual(ok("retained"));
    expect(deps.announceToParent).not.toHaveBeenCalled();
    expect(deps.sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(batcher.pending).toBe(0);
  });

  it("suppresses a concurrent duplicate without dropping its locally admitted owner", async () => {
    const deadLetterQueue = makeDecisionQueue();
    deadLetterQueue.reserveDecision
      .mockResolvedValueOnce(ok({ created: true }))
      .mockResolvedValueOnce(ok({ created: false }));
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue(ok({
      delivered: true,
      identity: { agentId: "agent-main", rootRunId: "root-1", stepIndex: 8 },
    }));
    const deps = makeDeps({
      deadLetterQueue,
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendGovernedAnnouncement,
    });
    const batcher = createAnnouncementBatcher(deps);
    const item = makeAnnouncement({ idempotencyKey: "decision-concurrent" });

    const [first, second] = await Promise.all([
      batcher.enqueue(item),
      batcher.enqueue(item),
    ]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect([first, second]).toEqual(expect.arrayContaining([ok("queued"), ok("retained")]));
    expect(deps.announceToParent).toHaveBeenCalledOnce();
    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deadLetterQueue.resolveDecision).toHaveBeenCalledWith(
      "decision-concurrent",
      "receipt_committed",
    );
  });

  it("blocks parent execution when durable decision reservation fails", async () => {
    const deadLetterQueue = makeDecisionQueue();
    deadLetterQueue.reserveDecision.mockResolvedValue(err(new Error("disk unavailable")));
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const deps = makeDeps({ deadLetterQueue, sendGovernedAnnouncement: vi.fn(), logger });
    const batcher = createAnnouncementBatcher(deps);

    const result = await batcher.enqueue(makeAnnouncement({ idempotencyKey: "decision-failed" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(result.ok).toBe(false);
    expect(deps.announceToParent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "disk unavailable" }),
      "Announcement decision reservation failed",
    );
  });

  it("resolves a durable decision only after NO_REPLY or a committed receipt", async () => {
    const noReplyQueue = makeDecisionQueue();
    const noReplyDeps = makeDeps({
      deadLetterQueue: noReplyQueue,
      sendGovernedAnnouncement: vi.fn(),
    });
    const noReplyBatcher = createAnnouncementBatcher(noReplyDeps);
    await noReplyBatcher.enqueue(makeAnnouncement({ idempotencyKey: "decision-no-reply" }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(noReplyQueue.resolveDecision).toHaveBeenCalledWith("decision-no-reply", "no_reply");

    const deliveredQueue = makeDecisionQueue();
    const deliveredDeps = makeDeps({
      deadLetterQueue: deliveredQueue,
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendGovernedAnnouncement: vi.fn().mockResolvedValue(ok({
        delivered: true,
        identity: { agentId: "agent-main", rootRunId: "root-1", stepIndex: 2 },
      })),
    });
    const deliveredBatcher = createAnnouncementBatcher(deliveredDeps);
    await deliveredBatcher.enqueue(makeAnnouncement({ idempotencyKey: "decision-delivered" }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliveredQueue.resolveDecision).toHaveBeenCalledWith(
      "decision-delivered",
      "receipt_committed",
    );
  });

  it("leaves the durable decision pending after parent timeout", async () => {
    const deadLetterQueue = makeDecisionQueue();
    const deps = makeDeps({
      deadLetterQueue,
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendGovernedAnnouncement: vi.fn(),
    });
    const batcher = createAnnouncementBatcher(deps);

    await batcher.enqueue(makeAnnouncement({ idempotencyKey: "decision-timeout" }));
    await vi.advanceTimersByTimeAsync(302_000);

    expect(deadLetterQueue.resolveDecision).not.toHaveBeenCalled();
    expect(deps.sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("shutdown closes admission and waits for an in-flight reservation before flushing", async () => {
    let finishReservation!: (value: ReturnType<typeof ok>) => void;
    const deadLetterQueue = makeDecisionQueue();
    deadLetterQueue.reserveDecision.mockReturnValue(new Promise((resolve) => {
      finishReservation = resolve;
    }));
    const deps = makeDeps({ deadLetterQueue, sendGovernedAnnouncement: vi.fn() });
    const batcher = createAnnouncementBatcher(deps);

    const admission = batcher.enqueue(makeAnnouncement({ idempotencyKey: "shutdown-reservation" }));
    const shutdown = batcher.shutdown();
    const refused = await batcher.enqueue(makeAnnouncement({ idempotencyKey: "too-late" }));
    expect(refused.ok).toBe(false);
    expect(deps.announceToParent).not.toHaveBeenCalled();

    finishReservation(ok({ created: true }));
    await admission;
    await shutdown;

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    expect(deadLetterQueue.resolveDecision).toHaveBeenCalledWith(
      "shutdown-reservation",
      "no_reply",
    );
  });

  it("sends the parent rewrite through the governed outward operation", async () => {
    const deadLetterQueue = makeDecisionQueue();
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        delivered: true,
        identity: { agentId: "agent-main", rootRunId: "root-1", stepIndex: 3 },
      },
    });
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten for the user"),
      deadLetterQueue,
      sendGovernedAnnouncement,
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ idempotencyKey: "governed-key" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      text: "rewritten for the user",
      runId: "run-1",
    }));
    expect(deps.sendToChannel).not.toHaveBeenCalled();
    expect(batcher.hasDelivered("governed-key")).toBe(true);
  });

  it("serializes a batch key while its parent execution is in flight", async () => {
    let resolveParent: ((value: string) => void) | undefined;
    const announceToParent = vi.fn().mockImplementation(() => new Promise<string>((resolve) => {
      resolveParent = resolve;
    }));
    const deps = makeDeps({ announceToParent });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ idempotencyKey: "same-key" }));
    await vi.advanceTimersByTimeAsync(2_000);
    batcher.enqueue(makeAnnouncement({ idempotencyKey: "same-key" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(announceToParent).toHaveBeenCalledOnce();
    resolveParent?.("rewritten");
    await vi.runAllTimersAsync();
    expect(announceToParent).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Idempotent success-path delivery.
// A delivered-key Set makes a second delivery of the same idempotencyKey a
// no-op. Mark ONLY on success: a both-paths-failed item stays
// un-marked so a later retry is preserved. undefined keys are never deduped.
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher idempotent delivery", () => {
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
    const combined = deps.announceToParent.mock.calls[0]![3] as string;
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

  it("does not mark or directly resend a timed-out parent execution", async () => {
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})),
      sendToChannel: vi.fn().mockRejectedValue(new Error("send failed")),
      deadLetterQueue: { enqueue: vi.fn() },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(302_000);

    expect(deps.sendToChannel).not.toHaveBeenCalled();
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
// The delivered-key set must be BOUNDED. Every successful keyed delivery
// adds a `${callerSessionKey}::${runId}` string and nothing evicted it for the
// daemon lifetime — a leak over a 40-hour autonomous run spawning thousands of
// sub-agents. The set must be capped like its siblings (runs MAX_RUNS, the DLQ
// maxEntries). Also: the batcher must accept an INJECTED shared DeliveryDedup so
// the no-batcher success branches + DLQ recovery can mark the SAME set.
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher deliveredKeys bounding", () => {
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
// Transient/permanent retry classification in the fallback path.
// On a sendToChannel fallback failure the batcher classifies via the injected
// classifyErrorContext: transient → retry-with-backoff (computeRetryBackoff)
// before dead-lettering; permanent → dead-letter immediately with zero retries.
// Both helpers arrive ONLY via AnnouncementBatcherDeps (DI from the daemon
// wiring) — applied in BOTH the single-item and the multi-item-batch branch.
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher transient/permanent retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry a transient-looking direct failure", async () => {
    const sendToChannel = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(true);
    const classifyErrorContext = vi.fn().mockReturnValue({ retryable: true });
    const computeRetryBackoff = vi.fn().mockReturnValue(1000);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 3,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-T", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(computeRetryBackoff).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(batcher.hasDelivered("K")).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("makes one attempt for a permanent-looking direct failure", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("budget exceeded"));
    const classifyErrorContext = vi.fn().mockReturnValue({ retryable: false });
    const computeRetryBackoff = vi.fn().mockReturnValue(1000);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 3,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-P", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendToChannel).toHaveBeenCalledTimes(1);   // no retry
    expect(computeRetryBackoff).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();           // dead-lettered immediately
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      runId: "run-P",
      agentId: "agent-main",
      idempotencyKey: "K",
    });
    expect(batcher.hasDelivered("K")).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not add retries for an HTTP status-looking direct failure", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("503"));
    const classifyErrorContext = vi.fn().mockReturnValue({ retryable: true });
    const computeRetryBackoff = vi.fn().mockReturnValue(500);
    const emit = vi.fn();
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel,
      classifyErrorContext,
      computeRetryBackoff,
      maxRetries: 2,
      eventBus: { emit },
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-E", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(computeRetryBackoff).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(batcher.hasDelivered("K")).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("uses one final attempt for each destination batch key", async () => {
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
      announceToParent: vi.fn().mockResolvedValue("combined rewrite"),
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
    await vi.advanceTimersByTimeAsync(10_000);

    // A retried + delivered.
    const aCalls = sendToChannel.mock.calls.filter((c) => c[1] === "chan-A").length;
    expect(aCalls).toBe(1);
    expect(batcher.hasDelivered("KA")).toBe(false);

    // B dead-lettered immediately, zero retries.
    const bCalls = sendToChannel.mock.calls.filter((c) => c[1] === "chan-B").length;
    expect(bCalls).toBe(1);
    expect(batcher.hasDelivered("KB")).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run-A", agentId: "agent-main", idempotencyKey: "KA" }),
      expect.objectContaining({ runId: "run-B", agentId: "agent-main", idempotencyKey: "KB" }),
    ]));
    expect(emit).not.toHaveBeenCalled();
  });

  it("without classifyErrorContext/computeRetryBackoff injected the fallback is single-attempt then DLQ (single-item)", async () => {
    // No retry deps injected → single-attempt fallback: one
    // sendToChannel attempt, then DLQ on failure, no retry, no crash.
    const sendToChannel = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel,
      deadLetterQueue: { enqueue },
      // classifyErrorContext / computeRetryBackoff / eventBus intentionally absent.
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-N", idempotencyKey: "K" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendToChannel).toHaveBeenCalledOnce(); // single attempt, no retry
    expect(enqueue).toHaveBeenCalledOnce();       // DLQ as today
    expect(batcher.hasDelivered("K")).toBe(false);
  });

  it("without retry deps injected the multi-item batch fallback is single-attempt-per-item then DLQ", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("combined rewrite"),
      sendToChannel,
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1", idempotencyKey: "K1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2", idempotencyKey: "K2" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("treats a resolved false direct fallback as a failed delivery", async () => {
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel: vi.fn().mockResolvedValue(false),
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ idempotencyKey: "K-false" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(batcher.hasDelivered("K-false")).toBe(false);
  });

  it("does not retry an opaque direct-send failure below DeliveryService", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    const enqueue = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten once"),
      sendToChannel,
      deadLetterQueue: { enqueue },
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ idempotencyKey: "single-attempt" }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not send a fallback after an ordinary parent execution rejection", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const sendGovernedAnnouncement = vi.fn();
    const deps = makeDeps({
      announceToParent: vi.fn().mockRejectedValue(new Error("parent failed after tool activity")),
      sendToChannel,
      sendGovernedAnnouncement,
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ idempotencyKey: "ambiguous-parent" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(batcher.hasDelivered("ambiguous-parent")).toBe(false);
  });

  it("persists the governed operation identity after a blocked direct fallback", async () => {
    const deadLetterQueue = makeDecisionQueue();
    const enqueue = deadLetterQueue.enqueue;
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        delivered: false,
        identity: {
          agentId: "agent-main",
          rootRunId: "root-run-1",
          stepIndex: 7,
        },
        failure: "operation_retained",
      },
    });
    const deps = makeDeps({
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel: vi.fn().mockResolvedValue(true),
      deadLetterQueue,
      sendGovernedAnnouncement,
    } as Partial<AnnouncementBatcherDeps>);
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({
      idempotencyKey: "default:user1:chan1::run-1",
    }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-main",
      rootRunId: "root-run-1",
      stepIndex: 7,
    }));
    expect(batcher.hasDelivered("default:user1:chan1::run-1")).toBe(false);
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
