// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ModelCompatConfigSchema, ToolSchemaProfileSchema } from "./model-compat.js";

describe('ToolSchemaProfileSchema — "gbnf" enum acceptance', () => {
  it('parses "gbnf" as a valid tool schema profile', () => {
    expect(ToolSchemaProfileSchema.parse("gbnf")).toBe("gbnf");
  });

  it('round-trips toolSchemaProfile: "gbnf" through ModelCompatConfigSchema', () => {
    const result = ModelCompatConfigSchema.parse({ toolSchemaProfile: "gbnf" });
    expect(result.toolSchemaProfile).toBe("gbnf");
  });
});

describe("ToolSchemaProfileSchema — regression pins (enum closed, zero new config keys)", () => {
  it('rejects the unknown profile value "gbnf2" (enum stays closed)', () => {
    expect(ToolSchemaProfileSchema.safeParse("gbnf2").success).toBe(false);
  });

  it("rejects unknown keys alongside a valid profile (strictObject — zero NEW config keys)", () => {
    expect(
      ModelCompatConfigSchema.safeParse({ toolSchemaProfile: "gbnf", bogusKey: true }).success,
    ).toBe(false);
  });

  it('still accepts the existing "xai" and "default" values', () => {
    expect(ToolSchemaProfileSchema.parse("xai")).toBe("xai");
    expect(ToolSchemaProfileSchema.parse("default")).toBe("default");
  });
});
