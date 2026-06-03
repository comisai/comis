// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SocialModelingConfigSchema } from "./schema-social-modeling.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("SocialModelingConfigSchema", () => {
  it("parses an empty object to the off-by-default bounded configuration (no sign-off recorded)", () => {
    const result = SocialModelingConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      // A slot AFTER the "0 5 * * *" consolidation so relationships build over freshly-reasoned memories.
      schedule: "0 6 * * *",
      maxEntriesPerRun: 50,
      maxSourceMemories: 200,
      maxSourceChars: 24_000,
      // privacyReviewSignedOffBy is OPTIONAL and absent by default (the operator gate).
    });
    expect(result.privacyReviewSignedOffBy).toBeUndefined();
  });

  it("defaults enabled to false (relationship modeling is opt-in, gated on a privacy review)", () => {
    expect(SocialModelingConfigSchema.parse({}).enabled).toBe(false);
  });

  it("accepts a recorded privacyReviewSignedOffBy sign-off", () => {
    const result = SocialModelingConfigSchema.parse({
      enabled: true,
      privacyReviewSignedOffBy: "alice@example.com",
    });
    expect(result.privacyReviewSignedOffBy).toBe("alice@example.com");
    expect(result.enabled).toBe(true);
  });

  it("rejects an empty privacyReviewSignedOffBy (.min(1) — a recorded sign-off must be a non-empty string)", () => {
    expect(() => SocialModelingConfigSchema.parse({ privacyReviewSignedOffBy: "" })).toThrow();
  });

  it("defaults the per-build input bounds (maxSourceMemories / maxSourceChars)", () => {
    const result = SocialModelingConfigSchema.parse({});
    expect(result.maxSourceMemories).toBe(200);
    expect(result.maxSourceChars).toBe(24_000);
  });

  it("rejects a non-positive / fractional input bound (the DoS bound is a positive int)", () => {
    expect(() => SocialModelingConfigSchema.parse({ maxSourceMemories: 0 })).toThrow();
    expect(() => SocialModelingConfigSchema.parse({ maxSourceChars: -1 })).toThrow();
    expect(() => SocialModelingConfigSchema.parse({ maxSourceMemories: 1.5 })).toThrow();
  });

  it("rejects a non-positive maxEntriesPerRun (the DoS cost bound must be a positive int)", () => {
    expect(() => SocialModelingConfigSchema.parse({ maxEntriesPerRun: 0 })).toThrow();
  });

  it("rejects a fractional maxEntriesPerRun (the per-run write cap is an integer)", () => {
    expect(() => SocialModelingConfigSchema.parse({ maxEntriesPerRun: 2.5 })).toThrow();
  });

  it("defaults the schedule to a cron slot after the reasoning slot", () => {
    expect(SocialModelingConfigSchema.parse({}).schedule).toBe("0 6 * * *");
  });

  it("overrides only the specified fields and keeps the rest at the bounded defaults", () => {
    const result = SocialModelingConfigSchema.parse({
      enabled: true,
      maxEntriesPerRun: 10,
    });
    expect(result.enabled).toBe(true);
    expect(result.maxEntriesPerRun).toBe(10);
    expect(result.schedule).toBe("0 6 * * *");
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() => SocialModelingConfigSchema.parse({ allowExternal: true })).toThrow();
  });
});

describe("PerAgentConfigSchema socialModeling field", () => {
  it("accepts a socialModeling subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({
      socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" },
    });
    expect(result.socialModeling).toBeDefined();
    expect(result.socialModeling!.enabled).toBe(true);
    expect(result.socialModeling!.privacyReviewSignedOffBy).toBe("ops@example.com");
  });

  it("treats socialModeling as optional (absent on a bare config)", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.socialModeling).toBeUndefined();
  });
});
