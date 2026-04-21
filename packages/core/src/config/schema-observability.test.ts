// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ObservabilityConfigSchema } from "./schema-observability.js";

describe("ObservabilityConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = ObservabilityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.enabled).toBe(true);
      expect(result.data.persistence.retentionDays).toBe(30);
      expect(result.data.persistence.snapshotIntervalMs).toBe(300000);
    }
  });

  it("accepts enabled: false", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.enabled).toBe(false);
    }
  });

  it("accepts custom retentionDays within range", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 90 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.retentionDays).toBe(90);
    }
  });

  it("rejects retentionDays of 0 (min is 1)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects retentionDays of 366 (max is 365)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 366 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects snapshotIntervalMs below 60000", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { snapshotIntervalMs: 30000 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts snapshotIntervalMs at minimum (60000)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { snapshotIntervalMs: 60000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.snapshotIntervalMs).toBe(60000);
    }
  });

  it("rejects extra keys via strictObject", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { enabled: true, unknownField: "fail" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys at root level via strictObject", () => {
    const result = ObservabilityConfigSchema.safeParse({
      unknownRoot: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer retentionDays", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 30.5 },
    });
    expect(result.success).toBe(false);
  });
});
