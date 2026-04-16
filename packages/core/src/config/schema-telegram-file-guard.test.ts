import { describe, it, expect } from "vitest";
import { TelegramFileRefGuardConfigSchema } from "./schema-telegram-file-guard.js";

describe("TelegramFileRefGuardConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = TelegramFileRefGuardConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.additionalExtensions).toEqual([]);
      expect(result.data.excludedExtensions).toEqual([]);
    }
  });

  it("accepts fully specified config", () => {
    const result = TelegramFileRefGuardConfigSchema.safeParse({
      enabled: false,
      additionalExtensions: [".docx", ".xlsx"],
      excludedExtensions: [".txt"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.additionalExtensions).toEqual([".docx", ".xlsx"]);
      expect(result.data.excludedExtensions).toEqual([".txt"]);
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = TelegramFileRefGuardConfigSchema.safeParse({
      enabled: true,
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array additionalExtensions", () => {
    const result = TelegramFileRefGuardConfigSchema.safeParse({
      additionalExtensions: ".docx",
    });
    expect(result.success).toBe(false);
  });
});
