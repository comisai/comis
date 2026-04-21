// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryReviewConfigSchema } from "./schema-memory-review.js";
import { PerAgentConfigSchema } from "./schema-agent.js";

describe("MemoryReviewConfigSchema", () => {
  it("parses empty object with correct defaults", () => {
    const result = MemoryReviewConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      schedule: "0 2 * * *",
      minMessages: 5,
      maxSessionsPerRun: 10,
      maxReviewTokens: 4096,
      dedupThreshold: 0.85,
      autoTags: [],
    });
  });

  it("overrides only specified fields", () => {
    const result = MemoryReviewConfigSchema.parse({
      enabled: true,
      schedule: "0 3 * * *",
    });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("0 3 * * *");
    expect(result.minMessages).toBe(5);
    expect(result.maxSessionsPerRun).toBe(10);
    expect(result.maxReviewTokens).toBe(4096);
    expect(result.dedupThreshold).toBe(0.85);
    expect(result.autoTags).toEqual([]);
  });

  it("rejects negative minMessages", () => {
    expect(() => MemoryReviewConfigSchema.parse({ minMessages: -1 })).toThrow();
  });

  it("rejects zero minMessages", () => {
    expect(() => MemoryReviewConfigSchema.parse({ minMessages: 0 })).toThrow();
  });

  it("rejects dedupThreshold > 1", () => {
    expect(() => MemoryReviewConfigSchema.parse({ dedupThreshold: 1.5 })).toThrow();
  });

  it("rejects dedupThreshold < 0", () => {
    expect(() => MemoryReviewConfigSchema.parse({ dedupThreshold: -0.1 })).toThrow();
  });

  it("accepts autoTags array", () => {
    const result = MemoryReviewConfigSchema.parse({ autoTags: ["user-pref", "habit"] });
    expect(result.autoTags).toEqual(["user-pref", "habit"]);
  });
});

describe("PerAgentConfigSchema memoryReview field", () => {
  it("accepts memoryReview field", () => {
    const result = PerAgentConfigSchema.parse({
      memoryReview: { enabled: true },
    });
    expect(result.memoryReview).toBeDefined();
    expect(result.memoryReview!.enabled).toBe(true);
  });

  it("accepts config without memoryReview (optional)", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryReview).toBeUndefined();
  });
});
