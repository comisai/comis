import { describe, it, expect } from "vitest";
import { LifecycleReactionsConfigSchema } from "./schema-lifecycle-reactions.js";

describe("LifecycleReactionsConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = LifecycleReactionsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.emojiTier).toBe("unicode");
      expect(result.data.timing.debounceMs).toBe(700);
      expect(result.data.timing.holdDoneMs).toBe(3000);
      expect(result.data.timing.holdErrorMs).toBe(5000);
      expect(result.data.timing.stallSoftMs).toBe(15000);
      expect(result.data.timing.stallHardMs).toBe(30000);
      expect(result.data.perChannel).toEqual({});
    }
  });

  it("accepts fully specified config", () => {
    const result = LifecycleReactionsConfigSchema.safeParse({
      enabled: true,
      emojiTier: "platform",
      timing: {
        debounceMs: 500,
        holdDoneMs: 5000,
        stallSoftMs: 20000,
        stallHardMs: 60000,
      },
      perChannel: {
        telegram: { enabled: true, emojiTier: "custom" },
        discord: { enabled: false },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.emojiTier).toBe("platform");
      expect(result.data.timing.debounceMs).toBe(500);
      expect(result.data.perChannel.telegram?.emojiTier).toBe("custom");
      expect(result.data.perChannel.discord?.enabled).toBe(false);
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = LifecycleReactionsConfigSchema.safeParse({
      enabled: true,
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid emojiTier enum value", () => {
    const result = LifecycleReactionsConfigSchema.safeParse({
      emojiTier: "animated",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative timing values", () => {
    const result = LifecycleReactionsConfigSchema.safeParse({
      timing: { debounceMs: -1 },
    });
    expect(result.success).toBe(false);
  });
});
