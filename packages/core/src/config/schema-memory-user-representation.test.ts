// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryUserRepresentationConfigSchema } from "./schema-memory-user-representation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryUserRepresentationConfigSchema", () => {
  it("parses an empty object to the ON-by-default (v1 opt-out) bounded configuration", () => {
    // v1 OPT-OUT posture: the per-user profile build defaults ON (a COST
    // feature, still force-disabled by the master kill switch). Bounded tuning constants frozen.
    const result = MemoryUserRepresentationConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      schedule: "0 5 * * *",
      maxEntriesPerRun: 50,
      // Per-build INPUT bounds (default-bounded so the prompt is never unbounded).
      maxSourceMemories: 200,
      maxSourceChars: 24_000,
    });
  });

  it("defaults the per-build input bounds (maxSourceMemories / maxSourceChars)", () => {
    const result = MemoryUserRepresentationConfigSchema.parse({});
    expect(result.maxSourceMemories).toBe(200);
    expect(result.maxSourceChars).toBe(24_000);
  });

  it("rejects a non-positive / fractional input bound (the DoS bound is a positive int)", () => {
    expect(() => MemoryUserRepresentationConfigSchema.parse({ maxSourceMemories: 0 })).toThrow();
    expect(() => MemoryUserRepresentationConfigSchema.parse({ maxSourceChars: -1 })).toThrow();
    expect(() => MemoryUserRepresentationConfigSchema.parse({ maxSourceMemories: 1.5 })).toThrow();
  });

  it("defaults enabled to true (v1 opt-out posture; gated by the master cost-feature kill switch)", () => {
    expect(MemoryUserRepresentationConfigSchema.parse({}).enabled).toBe(true);
  });

  it("overrides only the specified fields and keeps the rest at the bounded defaults", () => {
    const result = MemoryUserRepresentationConfigSchema.parse({
      enabled: true,
      maxEntriesPerRun: 10,
    });
    expect(result.enabled).toBe(true);
    expect(result.maxEntriesPerRun).toBe(10);
    expect(result.schedule).toBe("0 5 * * *");
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() =>
      MemoryUserRepresentationConfigSchema.parse({ reasonExternal: true }),
    ).toThrow();
  });

  it("rejects a non-positive maxEntriesPerRun (the DoS cost bound must be a positive int)", () => {
    expect(() => MemoryUserRepresentationConfigSchema.parse({ maxEntriesPerRun: 0 })).toThrow();
  });

  it("rejects a fractional maxEntriesPerRun (the per-run write cap is an integer)", () => {
    expect(() => MemoryUserRepresentationConfigSchema.parse({ maxEntriesPerRun: 2.5 })).toThrow();
  });

  it("defaults historyCap to 10 (REVISE-02 bounded per-record asOf history)", () => {
    // REVISE-02 (v2.26 Phase 203): superseded rows for a (user, entryType) slot
    // beyond this cap are trimmed oldest-first by the adapter (anti-unbounded-growth).
    expect(MemoryUserRepresentationConfigSchema.parse({}).historyCap).toBe(10);
  });

  it("rejects a non-positive / fractional historyCap (the bounded-history cap is a positive int)", () => {
    expect(() => MemoryUserRepresentationConfigSchema.parse({ historyCap: 0 })).toThrow();
    expect(() => MemoryUserRepresentationConfigSchema.parse({ historyCap: 2.5 })).toThrow();
  });
});

describe("PerAgentConfigSchema memoryUserRepresentation field", () => {
  it("accepts a memoryUserRepresentation subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({
      memoryUserRepresentation: { enabled: true },
    });
    expect(result.memoryUserRepresentation).toBeDefined();
    expect(result.memoryUserRepresentation!.enabled).toBe(true);
  });

  it("defaults memoryUserRepresentation ON for a bare config (v1 opt-out posture; kill-switch-gated)", () => {
    // the subtree is no longer `.optional()`; a bare config gets it populated
    // + enabled. The master cost-feature kill switch still force-disables it at the cron site.
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryUserRepresentation).toBeDefined();
    expect(result.memoryUserRepresentation!.enabled).toBe(true);
  });
});
