// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { CoalescerConfigSchema } from "./schema-coalescer.js";

describe("CoalescerConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = CoalescerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minChars).toBe(0);
      expect(result.data.maxChars).toBe(500);
      expect(result.data.idleMs).toBe(1500);
      expect(result.data.codeBlockPolicy).toBe("standalone");
      expect(result.data.adaptiveIdle).toBe(false);
    }
  });

  it("accepts fully specified config", () => {
    const result = CoalescerConfigSchema.safeParse({
      minChars: 50,
      maxChars: 1000,
      idleMs: 2000,
      codeBlockPolicy: "coalesce",
      adaptiveIdle: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minChars).toBe(50);
      expect(result.data.maxChars).toBe(1000);
      expect(result.data.idleMs).toBe(2000);
      expect(result.data.codeBlockPolicy).toBe("coalesce");
      expect(result.data.adaptiveIdle).toBe(true);
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = CoalescerConfigSchema.safeParse({
      maxChars: 500,
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid codeBlockPolicy enum value", () => {
    const result = CoalescerConfigSchema.safeParse({
      codeBlockPolicy: "merge",
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero idleMs (must be positive)", () => {
    const result = CoalescerConfigSchema.safeParse({
      idleMs: 0,
    });
    expect(result.success).toBe(false);
  });
});
