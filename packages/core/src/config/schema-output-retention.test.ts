// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { OutputRetentionConfigSchema } from "./schema-output-retention.js";

describe("OutputRetentionConfigSchema", () => {
  it("applies per-class defaults", () => {
    const parsed = OutputRetentionConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.intervalMs).toBe(3_600_000);
    expect(parsed.classes.attachment.retentionMs).toBe(7 * 24 * 3_600_000);
    expect(parsed.classes.chart.retentionMs).toBe(30 * 24 * 3_600_000);
    expect(parsed.classes.transcript.retentionMs).toBe(90 * 24 * 3_600_000);
    expect(parsed.classes.default.retentionMs).toBe(14 * 24 * 3_600_000);
  });

  it("accepts custom retentionMs per class", () => {
    const parsed = OutputRetentionConfigSchema.parse({
      classes: { attachment: { retentionMs: 1000 } },
    });
    expect(parsed.classes.attachment.retentionMs).toBe(1000);
  });

  it("rejects retentionMs <= 0", () => {
    expect(() =>
      OutputRetentionConfigSchema.parse({
        classes: { attachment: { retentionMs: 0 } },
      }),
    ).toThrow();
    expect(() =>
      OutputRetentionConfigSchema.parse({
        classes: { attachment: { retentionMs: -1 } },
      }),
    ).toThrow();
  });

  it("rejects intervalMs <= 0", () => {
    expect(() => OutputRetentionConfigSchema.parse({ intervalMs: 0 })).toThrow();
    expect(() => OutputRetentionConfigSchema.parse({ intervalMs: -100 })).toThrow();
  });

  it("rejects fractional retentionMs (integer required)", () => {
    expect(() =>
      OutputRetentionConfigSchema.parse({
        classes: { attachment: { retentionMs: 1.5 } },
      }),
    ).toThrow();
  });

  it("accepts custom enabled override", () => {
    const parsed = OutputRetentionConfigSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
  });
});
