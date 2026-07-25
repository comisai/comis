// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { classifyPlatformDelivery, PlatformDeliveryOutcomeSchema } from "./platform-delivery-outcome.js";

describe("platform delivery classification", () => {
  const classify = (chunks: Parameters<typeof classifyPlatformDelivery>[0], settledAtMs: number) => {
    const result = classifyPlatformDelivery(chunks, settledAtMs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value;
  };

  it("classifies all accepted chunks and keeps the last accepted id in original order", () => {
    expect(classify([
      { status: "accepted", charCount: 3, retried: false, messageId: "m-1" },
      { status: "accepted", charCount: 4, retried: true, messageId: "m-2" },
    ], 123)).toEqual({
      status: "accepted", deliveredChunks: 2, settledAtMs: 123, lastMessageId: "m-2",
    });
  });

  it("distinguishes definite partial and zero-acceptance rejection", () => {
    expect(classify([
      { status: "accepted", charCount: 3, retried: false, messageId: "m-1" },
      { status: "rejected", charCount: 4, retried: false, errorKind: "platform" },
    ], 124)).toEqual({
      status: "partial", errorKind: "platform", deliveredChunks: 1, failedChunks: 1,
      settledAtMs: 124, lastMessageId: "m-1",
    });
    expect(classify([
      { status: "rejected", charCount: 4, retried: false, errorKind: "auth" },
    ], 125)).toEqual({
      status: "rejected", errorKind: "auth", deliveredChunks: 0, failedChunks: 1, settledAtMs: 125,
    });
  });

  it("uses the first ambiguous chunk to determine unknown classification", () => {
    expect(classify([
      { status: "rejected", charCount: 1, retried: false, errorKind: "auth" },
      { status: "unknown", charCount: 2, retried: true, errorKind: "timeout" },
      { status: "accepted", charCount: 3, retried: false, messageId: "m-3" },
    ], 126)).toEqual({
      status: "unknown", errorKind: "timeout", deliveredChunks: 1, failedChunks: 2,
      ambiguousChunks: 1, settledAtMs: 126, lastMessageId: "m-3",
    });
  });

  it("rejects impossible count and timestamp combinations at schema boundaries", () => {
    expect(PlatformDeliveryOutcomeSchema.safeParse({
      status: "accepted", deliveredChunks: 0, settledAtMs: 1,
    }).success).toBe(false);
    expect(PlatformDeliveryOutcomeSchema.safeParse({
      status: "partial", errorKind: "platform", deliveredChunks: 1, failedChunks: 0, settledAtMs: 1,
    }).success).toBe(false);
    expect(PlatformDeliveryOutcomeSchema.safeParse({
      status: "unknown", errorKind: "timeout", deliveredChunks: 0, failedChunks: 1,
      ambiguousChunks: 2, settledAtMs: 1,
    }).success).toBe(false);
    expect(classifyPlatformDelivery([], 1)).toMatchObject({
      ok: false,
      error: { code: "no_attempts", errorKind: "precondition" },
    });
  });
});
