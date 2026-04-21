// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DeliveryTimingConfigSchema } from "./schema-delivery.js";

describe("DeliveryTimingConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = DeliveryTimingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("natural");
      expect(result.data.minMs).toBe(800);
      expect(result.data.maxMs).toBe(2500);
      expect(result.data.jitterMs).toBe(200);
      expect(result.data.firstBlockDelayMs).toBe(0);
    }
  });

  it("accepts fully specified config", () => {
    const result = DeliveryTimingConfigSchema.safeParse({
      mode: "custom",
      minMs: 500,
      maxMs: 3000,
      jitterMs: 100,
      firstBlockDelayMs: 1000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("custom");
      expect(result.data.minMs).toBe(500);
      expect(result.data.maxMs).toBe(3000);
      expect(result.data.jitterMs).toBe(100);
      expect(result.data.firstBlockDelayMs).toBe(1000);
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = DeliveryTimingConfigSchema.safeParse({
      mode: "natural",
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid mode enum value", () => {
    const result = DeliveryTimingConfigSchema.safeParse({
      mode: "turbo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative timing values", () => {
    const result = DeliveryTimingConfigSchema.safeParse({
      minMs: -100,
    });
    expect(result.success).toBe(false);
  });
});
