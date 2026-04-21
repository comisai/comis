// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  BeforeAgentStartResultSchema,
  BeforeToolCallResultSchema,
  ToolResultPersistResultSchema,
  BeforeCompactionResultSchema,
  mergeBeforeAgentStart,
  mergeBeforeToolCall,
  mergeToolResultPersist,
  mergeBeforeCompaction,
} from "./hook-strategies.js";

// ─── Zod Schema Tests ────────────────────────────────────────────

describe("BeforeAgentStartResultSchema", () => {
  it("parses a valid result with all fields", () => {
    const input = { systemPrompt: "Hello", prependContext: "ctx" };
    const result = BeforeAgentStartResultSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("parses an empty object (all fields optional)", () => {
    const result = BeforeAgentStartResultSchema.parse({});
    expect(result).toEqual({});
  });

  it("applies defaults for omitted optional fields", () => {
    const result = BeforeAgentStartResultSchema.parse({ systemPrompt: "sp" });
    expect(result.systemPrompt).toBe("sp");
    expect(result.prependContext).toBeUndefined();
  });

  it("rejects extra properties (strictObject)", () => {
    expect(() =>
      BeforeAgentStartResultSchema.parse({ systemPrompt: "sp", extra: true }),
    ).toThrow();
  });

  it("rejects wrong types", () => {
    expect(() =>
      BeforeAgentStartResultSchema.parse({ systemPrompt: 42 }),
    ).toThrow();
  });

  it("rejects systemPrompt exceeding 50000 chars", () => {
    const longString = "a".repeat(50_001);
    expect(() =>
      BeforeAgentStartResultSchema.parse({ systemPrompt: longString }),
    ).toThrow();
  });

  it("accepts systemPrompt at exactly 50000 chars", () => {
    const maxString = "a".repeat(50_000);
    const result = BeforeAgentStartResultSchema.parse({ systemPrompt: maxString });
    expect(result.systemPrompt).toBe(maxString);
  });

  it("rejects prependContext exceeding 50000 chars", () => {
    const longString = "a".repeat(50_001);
    expect(() =>
      BeforeAgentStartResultSchema.parse({ prependContext: longString }),
    ).toThrow();
  });

  it("accepts prependContext at exactly 50000 chars", () => {
    const maxString = "a".repeat(50_000);
    const result = BeforeAgentStartResultSchema.parse({ prependContext: maxString });
    expect(result.prependContext).toBe(maxString);
  });

  it("round-trips: parse then re-parse produces identical output", () => {
    const input = { systemPrompt: "test", prependContext: "ctx" };
    const first = BeforeAgentStartResultSchema.parse(input);
    const second = BeforeAgentStartResultSchema.parse(first);
    expect(second).toEqual(first);
  });
});

describe("BeforeToolCallResultSchema", () => {
  it("parses valid result with skip=false equivalent (block=false)", () => {
    const result = BeforeToolCallResultSchema.parse({ block: false });
    expect(result.block).toBe(false);
  });

  it("parses result with block=true and blockReason", () => {
    const input = { block: true, blockReason: "unsafe" };
    const result = BeforeToolCallResultSchema.parse(input);
    expect(result.block).toBe(true);
    expect(result.blockReason).toBe("unsafe");
  });

  it("parses result with params override", () => {
    const input = { params: { key: "value" } };
    const result = BeforeToolCallResultSchema.parse(input);
    expect(result.params).toEqual({ key: "value" });
  });

  it("parses an empty object (all fields optional)", () => {
    const result = BeforeToolCallResultSchema.parse({});
    expect(result).toEqual({});
  });

  it("rejects extra properties (strictObject)", () => {
    expect(() =>
      BeforeToolCallResultSchema.parse({ block: true, unknown: "field" }),
    ).toThrow();
  });

  it("rejects wrong types for block", () => {
    expect(() =>
      BeforeToolCallResultSchema.parse({ block: "yes" }),
    ).toThrow();
  });
});

describe("ToolResultPersistResultSchema", () => {
  it("parses a valid result", () => {
    const result = ToolResultPersistResultSchema.parse({ result: "modified output" });
    expect(result.result).toBe("modified output");
  });

  it("parses an empty object (result is optional)", () => {
    const result = ToolResultPersistResultSchema.parse({});
    expect(result.result).toBeUndefined();
  });

  it("rejects extra properties (strictObject)", () => {
    expect(() =>
      ToolResultPersistResultSchema.parse({ result: "ok", extra: true }),
    ).toThrow();
  });

  it("rejects wrong types for result", () => {
    expect(() =>
      ToolResultPersistResultSchema.parse({ result: 123 }),
    ).toThrow();
  });
});

describe("BeforeCompactionResultSchema", () => {
  it("parses a valid result with cancel=true", () => {
    const input = { cancel: true, cancelReason: "important data" };
    const result = BeforeCompactionResultSchema.parse(input);
    expect(result.cancel).toBe(true);
    expect(result.cancelReason).toBe("important data");
  });

  it("parses an empty object (all fields optional)", () => {
    const result = BeforeCompactionResultSchema.parse({});
    expect(result).toEqual({});
  });

  it("rejects extra properties (strictObject)", () => {
    expect(() =>
      BeforeCompactionResultSchema.parse({ cancel: true, unknown: 1 }),
    ).toThrow();
  });

  it("rejects wrong types for cancel", () => {
    expect(() =>
      BeforeCompactionResultSchema.parse({ cancel: "true" }),
    ).toThrow();
  });
});

// ─── Merge Function Tests ────────────────────────────────────────

describe("mergeBeforeAgentStart", () => {
  it("applies last-writer-wins for conflicting fields", () => {
    const a = { systemPrompt: "first", prependContext: "ctx-a" };
    const b = { systemPrompt: "second", prependContext: "ctx-b" };
    const merged = mergeBeforeAgentStart(a, b);
    expect(merged.systemPrompt).toBe("second");
    expect(merged.prependContext).toBe("ctx-b");
  });

  it("merging with undefined acc preserves next values", () => {
    const next = { systemPrompt: "sp", prependContext: "ctx" };
    const merged = mergeBeforeAgentStart(undefined, next);
    expect(merged).toEqual(next);
  });

  it("undefined fields in next fall back to acc values", () => {
    const acc = { systemPrompt: "keep-this" };
    const next = { prependContext: "new-ctx" };
    const merged = mergeBeforeAgentStart(acc, next);
    expect(merged.systemPrompt).toBe("keep-this");
    expect(merged.prependContext).toBe("new-ctx");
  });

  it("merging multiple results in sequence produces expected final state", () => {
    const r1 = { systemPrompt: "first" };
    const r2 = { prependContext: "middle-ctx" };
    const r3 = { systemPrompt: "final" };
    let merged = mergeBeforeAgentStart(undefined, r1);
    merged = mergeBeforeAgentStart(merged, r2);
    merged = mergeBeforeAgentStart(merged, r3);
    expect(merged.systemPrompt).toBe("final");
    expect(merged.prependContext).toBe("middle-ctx");
  });
});

describe("mergeBeforeToolCall", () => {
  it("applies last-writer-wins for block field", () => {
    const a = { block: false };
    const b = { block: true, blockReason: "security" };
    const merged = mergeBeforeToolCall(a, b);
    expect(merged.block).toBe(true);
    expect(merged.blockReason).toBe("security");
  });

  it("preserves non-conflicting fields across merges", () => {
    const a = { params: { key: "val" } };
    const b = { block: true, blockReason: "unsafe" };
    const merged = mergeBeforeToolCall(a, b);
    expect(merged.params).toEqual({ key: "val" });
    expect(merged.block).toBe(true);
    expect(merged.blockReason).toBe("unsafe");
  });

  it("merging with undefined acc preserves next", () => {
    const next = { block: true, blockReason: "denied" };
    const merged = mergeBeforeToolCall(undefined, next);
    expect(merged).toEqual(next);
  });
});

describe("mergeToolResultPersist", () => {
  it("applies last-writer-wins for result field", () => {
    const a = { result: "original" };
    const b = { result: "modified" };
    const merged = mergeToolResultPersist(a, b);
    expect(merged.result).toBe("modified");
  });

  it("undefined result in next falls back to acc", () => {
    const a = { result: "keep" };
    const b = {};
    const merged = mergeToolResultPersist(a, b);
    expect(merged.result).toBe("keep");
  });

  it("merging with undefined acc preserves next", () => {
    const next = { result: "output" };
    const merged = mergeToolResultPersist(undefined, next);
    expect(merged.result).toBe("output");
  });
});

describe("mergeBeforeCompaction", () => {
  it("applies last-writer-wins for cancel field", () => {
    const a = { cancel: false };
    const b = { cancel: true, cancelReason: "important" };
    const merged = mergeBeforeCompaction(a, b);
    expect(merged.cancel).toBe(true);
    expect(merged.cancelReason).toBe("important");
  });

  it("preserves non-conflicting fields across merges", () => {
    const a = { cancel: true };
    const b = { cancelReason: "new-reason" };
    const merged = mergeBeforeCompaction(a, b);
    expect(merged.cancel).toBe(true);
    expect(merged.cancelReason).toBe("new-reason");
  });

  it("merging multiple results in sequence", () => {
    const r1 = { cancel: true, cancelReason: "first" };
    const r2 = { cancel: false };
    const r3 = { cancelReason: "final-reason" };
    let merged = mergeBeforeCompaction(undefined, r1);
    merged = mergeBeforeCompaction(merged, r2);
    merged = mergeBeforeCompaction(merged, r3);
    expect(merged.cancel).toBe(false);
    expect(merged.cancelReason).toBe("final-reason");
  });
});
