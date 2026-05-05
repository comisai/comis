// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DeliveryQueueConfigSchema } from "./schema-delivery.js";

describe("DeliveryQueueConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = DeliveryQueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxQueueDepth).toBe(10_000);
      expect(result.data.defaultMaxAttempts).toBe(5);
      expect(result.data.defaultExpireMs).toBe(3_600_000);
      expect(result.data.drainOnStartup).toBe(true);
      expect(result.data.drainBudgetMs).toBe(60_000);
      expect(result.data.drainIntervalMs).toBe(1_000);
      expect(result.data.pruneIntervalMs).toBe(300_000);
    }
  });

  it("accepts a custom drainIntervalMs of 250", () => {
    const result = DeliveryQueueConfigSchema.safeParse({ drainIntervalMs: 250 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.drainIntervalMs).toBe(250);
  });

  it("rejects drainIntervalMs of 0 (not positive)", () => {
    const result = DeliveryQueueConfigSchema.safeParse({ drainIntervalMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative drainIntervalMs", () => {
    const result = DeliveryQueueConfigSchema.safeParse({ drainIntervalMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects fractional drainIntervalMs", () => {
    const result = DeliveryQueueConfigSchema.safeParse({ drainIntervalMs: 3.5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric drainIntervalMs", () => {
    const result = DeliveryQueueConfigSchema.safeParse({ drainIntervalMs: "fast" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strictObject)", () => {
    const result = DeliveryQueueConfigSchema.safeParse({ unknownField: 1 });
    expect(result.success).toBe(false);
  });
});
