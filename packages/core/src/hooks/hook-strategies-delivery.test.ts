// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for hook-strategies.ts mergeBeforeDelivery.
 *
 * The sibling hook-strategies.test.ts covers mergeBeforeAgentStart and
 * mergeBeforeCompaction but does NOT touch mergeBeforeDelivery.
 * Exercises both `next` and `acc`
 * paths for the binary-expression branches.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  BeforeDeliveryResultSchema,
  mergeBeforeDelivery,
} from "./hook-strategies.js";

describe("BeforeDeliveryResultSchema", () => {
  it("parses a valid result with every optional field populated", () => {
    const input = {
      text: "delivered text",
      cancel: false,
      cancelReason: "n/a",
      metadata: { foo: "bar" },
    };
    const result = BeforeDeliveryResultSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("parses an empty object when every field is optional", () => {
    expect(BeforeDeliveryResultSchema.parse({})).toEqual({});
  });

  it("rejects text exceeding the 50000-character maximum", () => {
    const longText = "x".repeat(50_001);
    expect(() =>
      BeforeDeliveryResultSchema.parse({ text: longText }),
    ).toThrow();
  });

  it("rejects cancelReason exceeding the 500-character maximum", () => {
    const longReason = "r".repeat(501);
    expect(() =>
      BeforeDeliveryResultSchema.parse({ cancelReason: longReason }),
    ).toThrow();
  });

  it("rejects unexpected extra properties on the strict object", () => {
    expect(() =>
      BeforeDeliveryResultSchema.parse({ text: "t", unexpected: 1 }),
    ).toThrow();
  });
});

describe("mergeBeforeDelivery", () => {
  it("applies last-writer-wins for every conflicting field in next", () => {
    const acc = {
      text: "from-acc",
      cancel: false,
      cancelReason: "old",
      metadata: { from: "acc" },
    };
    const next = {
      text: "from-next",
      cancel: true,
      cancelReason: "new",
      metadata: { from: "next" },
    };
    const merged = mergeBeforeDelivery(acc, next);
    expect(merged.text).toBe("from-next");
    expect(merged.cancel).toBe(true);
    expect(merged.cancelReason).toBe("new");
    expect(merged.metadata).toEqual({ from: "next" });
  });

  it("falls back to acc values when next has undefined fields", () => {
    const acc = {
      text: "kept-text",
      cancel: false,
      cancelReason: "kept-reason",
      metadata: { kept: true },
    };
    const next = {}; // every field undefined
    const merged = mergeBeforeDelivery(acc, next);
    expect(merged.text).toBe("kept-text");
    expect(merged.cancel).toBe(false);
    expect(merged.cancelReason).toBe("kept-reason");
    expect(merged.metadata).toEqual({ kept: true });
  });

  it("merging with undefined accumulator preserves next values verbatim", () => {
    const next = {
      text: "first",
      cancel: true,
      cancelReason: "stop",
      metadata: { fresh: true },
    };
    const merged = mergeBeforeDelivery(undefined, next);
    expect(merged).toEqual(next);
  });

  it("preserves non-conflicting fields across sequential merge calls", () => {
    const r1 = { text: "first" };
    const r2 = { cancel: true };
    const r3 = { cancelReason: "stopped" };
    let merged = mergeBeforeDelivery(undefined, r1);
    merged = mergeBeforeDelivery(merged, r2);
    merged = mergeBeforeDelivery(merged, r3);
    expect(merged.text).toBe("first");
    expect(merged.cancel).toBe(true);
    expect(merged.cancelReason).toBe("stopped");
  });

  it("emits undefined for every field when both acc and next omit them", () => {
    const merged = mergeBeforeDelivery(undefined, {});
    expect(merged.text).toBeUndefined();
    expect(merged.cancel).toBeUndefined();
    expect(merged.cancelReason).toBeUndefined();
    expect(merged.metadata).toBeUndefined();
  });
});
