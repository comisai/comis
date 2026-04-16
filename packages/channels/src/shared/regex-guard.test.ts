import { describe, it, expect } from "vitest";
import { isRegexSafe, MAX_PATTERN_LENGTH } from "./regex-guard.js";

describe("isRegexSafe", () => {
  // ---------------------------------------------------------------------------
  // Safe patterns
  // ---------------------------------------------------------------------------

  it("accepts empty string", () => {
    expect(isRegexSafe("")).toEqual({ safe: true });
  });

  it("accepts simple literal: 'hello'", () => {
    expect(isRegexSafe("hello")).toEqual({ safe: true });
  });

  it("accepts digit quantifier: '\\d+'", () => {
    expect(isRegexSafe("\\d+")).toEqual({ safe: true });
  });

  it("accepts alternation: 'foo|bar'", () => {
    expect(isRegexSafe("foo|bar")).toEqual({ safe: true });
  });

  it("accepts anchored: '^test$'", () => {
    expect(isRegexSafe("^test$")).toEqual({ safe: true });
  });

  it("accepts single quantifier without group", () => {
    expect(isRegexSafe("a+b*c?")).toEqual({ safe: true });
  });

  it("accepts simple group with single quantifier: '(abc)+'", () => {
    // This is (abc)+ -- the group content has no quantifier, so not nested
    // But our regex catches (...)+ if content has quantifier
    expect(isRegexSafe("(abc)+")).toEqual({ safe: true });
  });

  // ---------------------------------------------------------------------------
  // Unsafe patterns -- nested quantifiers
  // ---------------------------------------------------------------------------

  it("rejects (a+)+", () => {
    const result = isRegexSafe("(a+)+");
    expect(result.safe).toBe(false);
    expect((result as { safe: false; reason: string }).reason).toContain("nested quantifiers");
  });

  it("rejects (.*)*", () => {
    const result = isRegexSafe("(.*)*");
    expect(result.safe).toBe(false);
    expect((result as { safe: false; reason: string }).reason).toContain("nested quantifiers");
  });

  it("rejects (.+)+", () => {
    const result = isRegexSafe("(.+)+");
    expect(result.safe).toBe(false);
  });

  it("rejects (a*)*", () => {
    const result = isRegexSafe("(a*)*");
    expect(result.safe).toBe(false);
  });

  it("rejects (a+)*", () => {
    const result = isRegexSafe("(a+)*");
    expect(result.safe).toBe(false);
  });

  it("rejects (a*)+", () => {
    const result = isRegexSafe("(a*)+");
    expect(result.safe).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Unsafe patterns -- excessive length
  // ---------------------------------------------------------------------------

  it("rejects pattern exceeding 200 characters", () => {
    const longPattern = "a".repeat(MAX_PATTERN_LENGTH + 1);
    const result = isRegexSafe(longPattern);
    expect(result.safe).toBe(false);
    expect((result as { safe: false; reason: string }).reason).toContain("maximum length");
  });

  it("accepts pattern at exactly 200 characters", () => {
    const exactPattern = "a".repeat(MAX_PATTERN_LENGTH);
    expect(isRegexSafe(exactPattern)).toEqual({ safe: true });
  });

  // ---------------------------------------------------------------------------
  // Unsafe patterns -- excessive quantifier complexity with groups
  // ---------------------------------------------------------------------------

  it("rejects pattern with many quantifiers and groups", () => {
    // 6 quantifiers + group = too complex
    const result = isRegexSafe("(a+b+c+d+e+f+)");
    expect(result.safe).toBe(false);
    expect((result as { safe: false; reason: string }).reason).toContain("excessive quantifier complexity");
  });

  it("accepts many quantifiers without groups", () => {
    // 6 quantifiers but no group
    expect(isRegexSafe("a+b+c+d+e+f+")).toEqual({ safe: true });
  });
});
