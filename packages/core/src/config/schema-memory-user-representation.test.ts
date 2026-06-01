// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryUserRepresentationConfigSchema } from "./schema-memory-user-representation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryUserRepresentationConfigSchema", () => {
  it("parses an empty object to the off-by-default bounded configuration", () => {
    const result = MemoryUserRepresentationConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      schedule: "0 5 * * *",
      maxEntriesPerRun: 50,
    });
  });

  it("defaults enabled to false (the per-user profile build is opt-in, a cost gate not back-compat)", () => {
    expect(MemoryUserRepresentationConfigSchema.parse({}).enabled).toBe(false);
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
});

describe("PerAgentConfigSchema memoryUserRepresentation field", () => {
  it("accepts a memoryUserRepresentation subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({
      memoryUserRepresentation: { enabled: true },
    });
    expect(result.memoryUserRepresentation).toBeDefined();
    expect(result.memoryUserRepresentation!.enabled).toBe(true);
  });

  it("treats memoryUserRepresentation as optional (absent on a bare config)", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryUserRepresentation).toBeUndefined();
  });
});
