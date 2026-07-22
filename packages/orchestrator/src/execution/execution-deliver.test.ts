// SPDX-License-Identifier: Apache-2.0
/**
 * execution-deliver.test.
 *
 * Pins the `Result` return contract of `deliverExecutionResponse`:
 *  - a fully-successful multi-chunk delivery returns `ok(FinalDeliveryReceipt)`
 *    with the real last-chunk message id + a `deliveredAtMs` captured AFTER the
 *    last chunk's send-promise resolves (proven via the injected ClockPort fake),
 *  - a chunk failure returns `err(DeliveryFailureReceipt)` carrying the first
 *    failure's `errorKind` + a truncated `lastError`,
 *  - `delivery.visibleReplies` is enforced after the response filter and before
 *    assistant-text delivery: `message_tool` suppresses the final text unless the
 *    `message` tool acted; `automatic` always delivers; the suppression never
 *    touches the channel adapter.
 *
 * The receipt assertions read `result.ok` / `result.value.*`, so the stage
 * must return a Result rather than `Promise<void>`.
 */
import {
  DeliveryQueueTransitionError,
  type ChannelPort,
  type DeliveryResult,
  type NormalizedMessage,
} from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import type { BlockPacer, PacerConfig, TypingLifecycleController } from "@comis/channels";

// Drive the block pacer deterministically: deliver every coalesced group in
// order with no real timing. The pacer in @comis/channels is otherwise a
// timing state machine; the delivery-stage contract under test is the
// per-chunk send + receipt aggregation, not the human-pacing cadence.
vi.mock("@comis/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/channels")>();
  return {
    ...actual,
    createBlockPacer: vi.fn((config: PacerConfig) => ({
      deliver: vi.fn(async (blocks: string[], send: (text: string) => Promise<void>) => {
        for (const b of blocks) {
          // Faithful to the real pacer's external-abort hard stop
          // (block-pacer.ts): an aborted external signal skips the remaining
          // blocks WITHOUT sending — the seam the skip-honesty contract pins.
          if (config.externalSignal?.aborted) return;
          await send(b);
        }
      }),
      cancel: vi.fn(),
    })),
  };
});

import { deliverExecutionResponse } from "./execution-deliver.js";
import type { DeliverDeps } from "./execution-deliver.js";

// ---------------------------------------------------------------------------
// Local factories
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "in-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hi",
    timestamp: 1_000,
    chatType: "group",
    ...overrides,
  } as NormalizedMessage;
}

function makeAdapter(sendImpl?: ChannelPort["sendMessage"]): ChannelPort {
  return {
    channelId: "telegram-1",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: sendImpl ?? vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
  } as unknown as ChannelPort;
}

// A DeliveryService fake whose per-call result carries the chunk ids the
// adapter.sendMessage returned (so the receipt can surface the REAL
// lastChunkMessageId, not a synthetic constant).
function makeDeliveryService(): DeliverDeps["deliveryService"] {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
    deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string) => {
      const result = await adapter.sendMessage(channelId, text, undefined);
      const chunks = [{
        status: result.ok ? "accepted" as const : "rejected" as const,
        ...(result.ok
          ? { messageId: result.value }
          : { error: result.error, errorKind: "platform" as const }),
        charCount: text.length,
        retried: false,
      }];
      return ok({
        chunks,
        totalChars: text.length,
        platform: result.ok
          ? {
              status: "accepted" as const,
              deliveredChunks: 1,
              settledAtMs: 2_000,
              ...(result.value === undefined ? {} : { lastMessageId: result.value }),
            }
          : {
              status: "rejected" as const,
              errorKind: "platform" as const,
              deliveredChunks: 0 as const,
              failedChunks: 1,
              settledAtMs: 2_000,
            },
        queueDisposition: "settled" as const,
      });
    }),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeEventBus(): DeliverDeps["eventBus"] {
  const emit = vi.fn((_event: string, _payload: unknown) => true);
  return {
    emit,
    emitSafely: vi.fn((event: string, payload: unknown) => ({
      hadListeners: emit(event, payload),
      failures: [],
    })),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
  } as unknown as DeliverDeps["eventBus"];
}

function makeDeps(overrides?: Partial<DeliverDeps>): DeliverDeps {
  return {
    eventBus: makeEventBus(),
    logger: createMockLogger(),
    clock: createFakeClock(2_000),
    deliveryService: makeDeliveryService(),
    ...overrides,
  } as DeliverDeps;
}

function makeBlockStreamCfg() {
  return {
    enabled: true,
    chunkMode: "paragraph" as const,
    chunkMinChars: 1,
    chunkMaxChars: 10,
    deliveryTiming: { mode: "custom" as const, minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
    coalescer: { minChars: 0, maxChars: 10, idleMs: 0, codeBlockPolicy: "standalone" as const, adaptiveIdle: false },
    typingMode: "thinking" as const,
    typingRefreshMs: 6000,
    useMarkdownIR: false,
    tableMode: "code" as const,
    replyMode: "first" as const,
  };
}

const NO_TYPING: TypingLifecycleController | undefined = undefined;

// ---------------------------------------------------------------------------
// Result receipt + deliveredAtMs ordering
// ---------------------------------------------------------------------------

describe("deliverExecutionResponse — aborted-signal skip honesty", () => {
  it("reports skipped blocks honestly when the delivery signal is already aborted (never success:true with zero sends)", async () => {
    // Observed live: a spend-aborted turn's delivery logged "Block delivery
    // complete success:true" + "Delivery complete" while the pacer had
    // hard-skipped every block — the user received nothing and the logs said
    // success. The skip must be visible: success:false + a skippedChunks count
    // on the completion line, plus an operator-actionable WARN.
    const send = vi.fn(async () => ok("msg-x"));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();
    const abortedController = new AbortController();
    abortedController.abort("user_cancel");

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage(), "hello world", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, abortedController.signal, NO_TYPING,
    );

    // Nothing was sent (the pacer's external-abort hard stop).
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: { deliveredChunks: 0, failedChunks: 0, errorKind: "precondition" },
    });

    const logger = deps.logger as unknown as { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    const completion = logger.debug.mock.calls.find((c) => c[1] === "Block delivery complete");
    expect(completion, "the completion line must still be logged").toBeDefined();
    // "hello world" chunks into 2 groups at chunkMaxChars 10 — BOTH skipped.
    expect(completion?.[0]).toMatchObject({ success: false, skippedChunks: 2 });
    const warn = logger.warn.mock.calls.find((c) => c[1] === "Block delivery skipped by aborted execution");
    expect(warn, "an operator-actionable WARN must record the skip").toBeDefined();
    expect(warn?.[0]).toMatchObject({ errorKind: "precondition" });
    expect(String(warn?.[0]?.hint ?? "")).toMatch(/not.*sent|never sent|did not receive/i);
  });

  it("emits delivery:aborted for the skip so the trajectory records what the user never received", async () => {
    // The pacer's hard stop bypasses deliverToChannel entirely, so none of the
    // delivery events fire — the trajectory showed NOTHING for a turn whose
    // blocks were all skipped (observed live: explain claimed 2 dispatched
    // deliveries while the user's chat showed a third, undelivered turn).
    const send = vi.fn(async () => ok("msg-x"));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();
    const abortedController = new AbortController();
    abortedController.abort("spend_exceeded");

    await deliverExecutionResponse(
      deps, adapter, makeMessage(), "hello world", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, abortedController.signal, NO_TYPING,
    );

    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>;
    const aborted = emit.mock.calls.filter((c) => c[0] === "delivery:aborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]![1]).toMatchObject({
      channelType: "telegram",
      reason: "spend_exceeded",
      chunksDelivered: 0,
      totalChunks: 2,
      origin: "agent",
    });
  });
});

describe("deliverExecutionResponse — delivery receipt", () => {
  it("returns the strict accepted aggregate with durable queue disposition", async () => {
    const result = await deliverExecutionResponse(
      makeDeps(), makeAdapter(), makeMessage(), "hello", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        deliveredChunks: 1,
        queueDisposition: "settled",
      },
    });
    if (!result.ok || result.value.status !== "accepted") return;
    expect(result.value.settledAtMs).toBeGreaterThan(0);
    expect(result.value.lastMessageId).toBe("msg-1");
  });

  it("retains partial platform truth instead of collapsing it into a boolean failure", async () => {
    let callCount = 0;
    const deliveryService: DeliverDeps["deliveryService"] = {
      deliverToChannel: vi.fn(async (_adapter, _channelId, text) => {
        callCount += 1;
        const accepted = callCount === 1;
        return ok({
          chunks: accepted
            ? [{ status: "accepted" as const, messageId: "msg-first", charCount: text.length, retried: false }]
            : [{ status: "rejected" as const, error: new Error("rejected"), errorKind: "platform" as const, charCount: text.length, retried: false }],
          totalChars: text.length,
          platform: accepted
            ? { status: "accepted" as const, deliveredChunks: 1, settledAtMs: 2_000, lastMessageId: "msg-first" }
            : { status: "rejected" as const, errorKind: "platform" as const, deliveredChunks: 0 as const, failedChunks: 1, settledAtMs: 2_001 },
          queueDisposition: "settled" as const,
        });
      }),
      drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
    };

    const result = await deliverExecutionResponse(
      makeDeps({ deliveryService }), makeAdapter(), makeMessage(),
      "abcdefghij klmnopqrst", makeBlockStreamCfg(), new Set<BlockPacer>(),
      undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "partial",
        deliveredChunks: 1,
        failedChunks: expect.any(Number),
        queueDisposition: "settled",
        lastMessageId: "msg-first",
      },
    });
    if (result.ok && result.value.status === "partial") {
      expect(result.value.failedChunks).toBeGreaterThan(0);
    }
  });

  it("propagates retry-pending queue ownership beside accepted platform truth", async () => {
    const deliveryService: DeliverDeps["deliveryService"] = {
      deliverToChannel: vi.fn(async (_adapter, _channelId, text) => ok({
        chunks: [{ status: "accepted" as const, messageId: "msg-retry", charCount: text.length, retried: false }],
        totalChars: text.length,
        platform: { status: "accepted" as const, deliveredChunks: 1, settledAtMs: 2_000, lastMessageId: "msg-retry" },
        queueDisposition: "retry_pending" as const,
      })),
      drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
    };

    const result = await deliverExecutionResponse(
      makeDeps({ deliveryService }), makeAdapter(), makeMessage(), "hello",
      makeBlockStreamCfg(), new Set<BlockPacer>(), undefined,
      new AbortController().signal, NO_TYPING,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        deliveredChunks: 1,
        queueDisposition: "retry_pending",
      },
    });
  });

  it("returns ok(receipt) with deliveredChunks and the real lastChunkMessageId on full success", async () => {
    let counter = 0;
    const send = vi.fn(async () => ok(`msg-${++counter}`));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();
    // Force multiple chunks: 30 chars at maxChars=10 => >=3 groups.
    const text = "abcdefghij klmnopqrst uvwxyz0123";

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage(), text, makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deliveredChunks).toBeGreaterThanOrEqual(2);
    // The id must be the LAST chunk's real id, not a synthetic constant.
    expect(result.value.lastMessageId).toBe(`msg-${counter}`);
    expect(result.value.lastMessageId).not.toBe("block-delivery");
  });

  it("keeps a successful platform send successful when only queue durability failed", async () => {
    const platformResult: DeliveryResult = {
      chunks: [{ status: "accepted", messageId: "platform-msg-1", charCount: 5, retried: false }],
      totalChars: 5,
      platform: {
        status: "accepted",
        deliveredChunks: 1,
        settledAtMs: 2_000,
        lastMessageId: "platform-msg-1",
      },
      queueDisposition: "transition_failed",
    };
    const queueError = new DeliveryQueueTransitionError([{
      transition: "ack",
      deliveryId: "entry-1",
      errorKind: "dependency",
      cause: new Error("ack write failed"),
    }], platformResult);
    const logger = createMockLogger();
    const deps = makeDeps({
      logger,
      deliveryService: {
        deliverToChannel: vi.fn(async () => err(queueError)),
        drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
      },
    });

    const result = await deliverExecutionResponse(
      deps, makeAdapter(), makeMessage(), "hello", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      status: "accepted",
      deliveredChunks: 1,
      lastMessageId: "platform-msg-1",
      queueDisposition: "transition_failed",
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Delivery failure",
    );
  });

  it("captures deliveredAtMs from the injected clock AFTER the last chunk's send-promise resolves", async () => {
    const clock = createFakeClock(5_000);
    // Each send advances the clock by 100ms, so the post-last-chunk read must
    // be strictly greater than the read taken before the first send.
    const send = vi.fn(async () => {
      clock.advance(100);
      return ok(`m-${clock.now()}`);
    });
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps({ clock } as Partial<DeliverDeps>);
    const before = clock.now();
    const text = "abcdefghij klmnopqrst uvwxyz0123";

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage(), text, makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // settledAtMs is captured after the last send resolved: strictly after the
    // pre-delivery clock reading and == the clock value once every send ran.
    expect(result.value.settledAtMs).toBeGreaterThan(before);
    expect(result.value.settledAtMs).toBe(clock.now());
  });

  it("returns strict rejected platform truth on a definite chunk failure", async () => {
    const longMessage = "x".repeat(500);
    const send = vi.fn(async () => err(new Error(longMessage)));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage(), "abcdefghij klmnop", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "rejected",
        deliveredChunks: 0,
        failedChunks: expect.any(Number),
        errorKind: "platform",
        queueDisposition: "settled",
      },
    });
    if (result.ok && result.value.status === "rejected") {
      expect(result.value.failedChunks).toBeGreaterThan(0);
    }
  });

  it("classifies a chunk failure surfaced via DeliveryResult.chunks[].error (deliverToChannel ok, inner chunk failed)", async () => {
    // Here deliverToChannel returns ok:true (Result) but with an inner failed
    // chunk carrying the error — exercises the failChunk.error extraction path.
    const deps = makeDeps({
      deliveryService: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        deliverToChannel: vi.fn(async (_a: any, _c: string, text: string) => ok({
          chunks: [{
            status: "rejected" as const,
            error: new Error("inner-chunk-boom"),
            errorKind: "platform" as const,
            charCount: text.length,
            retried: false,
          }],
          totalChars: text.length,
          platform: {
            status: "rejected" as const,
            errorKind: "platform" as const,
            deliveredChunks: 0 as const,
            failedChunks: 1,
            settledAtMs: 2_000,
          },
          queueDisposition: "settled" as const,
        })),
        drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
      } as DeliverDeps["deliveryService"],
    });

    const result = await deliverExecutionResponse(
      deps, makeAdapter(), makeMessage(), "abcdefghij", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "rejected",
        errorKind: "platform",
        failedChunks: 1,
      },
    });
  });

  it("uses the required injected clock for settledAtMs on success", async () => {
    const adapter = makeAdapter(vi.fn(async () => ok("msg-real")) as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps({ clock: createFakeClock(7_000) });

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage(), "abcdefghij", makeBlockStreamCfg(),
      new Set<BlockPacer>(), undefined, new AbortController().signal, NO_TYPING,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lastMessageId).toBe("msg-real");
    expect(result.value.settledAtMs).toBe(7_000);
  });
});

// ---------------------------------------------------------------------------
// visibleReplies enforcement (post-filter, pre-delivery)
// ---------------------------------------------------------------------------

describe("deliverExecutionResponse — visibleReplies enforcement", () => {
  it("suppresses final assistant text under group:message_tool when the message tool did NOT act", async () => {
    const send = vi.fn(async () => ok("msg-x"));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage({ chatType: "group" }), "final text",
      makeBlockStreamCfg(), new Set<BlockPacer>(), undefined,
      new AbortController().signal, NO_TYPING,
      { visibleReplies: { direct: "automatic", group: "message_tool" }, messageToolActed: false },
    );

    // Suppressed: nothing sent to the channel, with a closed policy reason.
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      value: { status: "suppressed", reason: "visible_replies" },
    });
  });

  it("delivers final assistant text under group:message_tool when the message tool acted (send/reply/attach)", async () => {
    const send = vi.fn(async () => ok("msg-y"));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();

    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage({ chatType: "group" }), "final text",
      makeBlockStreamCfg(), new Set<BlockPacer>(), undefined,
      new AbortController().signal, NO_TYPING,
      { visibleReplies: { direct: "automatic", group: "message_tool" }, messageToolActed: true },
    );

    expect(send).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("delivers final assistant text under automatic regardless of message-tool action", async () => {
    const send = vi.fn(async () => ok("msg-z"));
    const adapter = makeAdapter(send as unknown as ChannelPort["sendMessage"]);
    const deps = makeDeps();

    // NormalizedMessage.chatType is the 5-value enum (dm/group/thread/...); a DM
    // ("dm") resolves to the `direct` visibleReplies policy. With direct=automatic
    // the final text delivers regardless of whether the message tool acted.
    const result = await deliverExecutionResponse(
      deps, adapter, makeMessage({ chatType: "dm" }), "final text",
      makeBlockStreamCfg(), new Set<BlockPacer>(), undefined,
      new AbortController().signal, NO_TYPING,
      { visibleReplies: { direct: "automatic", group: "message_tool" }, messageToolActed: false },
    );

    expect(send).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
