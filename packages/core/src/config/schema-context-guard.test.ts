// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ContextPruningConfigSchema, SourceGateConfigSchema } from "./schema-agent.js";

// ---------------------------------------------------------------------------
// ContextPruningConfigSchema
// ---------------------------------------------------------------------------

describe("ContextPruningConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = ContextPruningConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.softTrimRatio).toBe(0.3);
      expect(result.data.hardClearRatio).toBe(0.5);
      expect(result.data.keepLastAssistants).toBe(3);
      expect(result.data.minPrunableToolChars).toBe(4000);
      expect(result.data.protectedTools).toHaveLength(4);
      expect(result.data.protectedTools).toEqual([
        "memory_search", "memory_get", "memory_store", "file_read",
      ]);
    }
  });

  it("accepts custom values that override defaults", () => {
    const result = ContextPruningConfigSchema.safeParse({
      enabled: false,
      softTrimRatio: 0.2,
      hardClearRatio: 0.6,
      keepLastAssistants: 5,
      minPrunableToolChars: 8000,
      protectedTools: ["bash"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.softTrimRatio).toBe(0.2);
      expect(result.data.hardClearRatio).toBe(0.6);
      expect(result.data.keepLastAssistants).toBe(5);
      expect(result.data.minPrunableToolChars).toBe(8000);
      expect(result.data.protectedTools).toEqual(["bash"]);
    }
  });

  it("rejects softTrimRatio equal to hardClearRatio", () => {
    const result = ContextPruningConfigSchema.safeParse({
      softTrimRatio: 0.5,
      hardClearRatio: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects softTrimRatio greater than hardClearRatio", () => {
    const result = ContextPruningConfigSchema.safeParse({
      softTrimRatio: 0.6,
      hardClearRatio: 0.3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects softTrimRatio > 1", () => {
    const result = ContextPruningConfigSchema.safeParse({ softTrimRatio: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects softTrimRatio < 0", () => {
    const result = ContextPruningConfigSchema.safeParse({ softTrimRatio: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects hardClearRatio > 1", () => {
    const result = ContextPruningConfigSchema.safeParse({ hardClearRatio: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects hardClearRatio < 0", () => {
    const result = ContextPruningConfigSchema.safeParse({ hardClearRatio: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive minPrunableToolChars", () => {
    const result = ContextPruningConfigSchema.safeParse({ minPrunableToolChars: 0 });
    expect(result.success).toBe(false);
    const result2 = ContextPruningConfigSchema.safeParse({ minPrunableToolChars: -1 });
    expect(result2.success).toBe(false);
  });

  it("rejects negative keepLastAssistants", () => {
    const result = ContextPruningConfigSchema.safeParse({ keepLastAssistants: -1 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SourceGateConfigSchema
// ---------------------------------------------------------------------------

describe("SourceGateConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = SourceGateConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResponseBytes).toBe(2_000_000);
      expect(result.data.stripHiddenHtml).toBe(true);
    }
  });

  it("accepts custom values that override defaults", () => {
    const result = SourceGateConfigSchema.safeParse({
      maxResponseBytes: 1_000_000,
      stripHiddenHtml: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResponseBytes).toBe(1_000_000);
      expect(result.data.stripHiddenHtml).toBe(false);
    }
  });

  it("rejects non-positive maxResponseBytes", () => {
    const result = SourceGateConfigSchema.safeParse({ maxResponseBytes: 0 });
    expect(result.success).toBe(false);
    const result2 = SourceGateConfigSchema.safeParse({ maxResponseBytes: -1 });
    expect(result2.success).toBe(false);
  });
});
