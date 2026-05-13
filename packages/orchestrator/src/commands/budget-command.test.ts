// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseUserTokenBudget, MIN_USER_BUDGET, MAX_USER_BUDGET } from "./budget-command.js";

describe("parseUserTokenBudget", () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  it("exports MIN_USER_BUDGET as 10000", () => {
    expect(MIN_USER_BUDGET).toBe(10_000);
  });

  it("exports MAX_USER_BUDGET as 10000000", () => {
    expect(MAX_USER_BUDGET).toBe(10_000_000);
  });

  // -----------------------------------------------------------------------
  // +Nk syntax (start of message)
  // -----------------------------------------------------------------------

  it("parses +500k at start of message", () => {
    const result = parseUserTokenBudget("+500k hello world");
    expect(result.tokens).toBe(500_000);
    expect(result.cleanedText).toBe("hello world");
  });

  it("parses +100k standalone (no body text)", () => {
    const result = parseUserTokenBudget("+100k");
    expect(result.tokens).toBe(100_000);
    expect(result.cleanedText).toBe("");
  });

  // -----------------------------------------------------------------------
  // +Nm syntax (start of message)
  // -----------------------------------------------------------------------

  it("parses +2m at start of message", () => {
    const result = parseUserTokenBudget("+2m analyze this code");
    expect(result.tokens).toBe(2_000_000);
    expect(result.cleanedText).toBe("analyze this code");
  });

  // -----------------------------------------------------------------------
  // End-of-message matching
  // -----------------------------------------------------------------------

  it("parses +500k at end of message", () => {
    const result = parseUserTokenBudget("hello +500k");
    expect(result.tokens).toBe(500_000);
    expect(result.cleanedText).toBe("hello");
  });

  // -----------------------------------------------------------------------
  // Case insensitivity
  // -----------------------------------------------------------------------

  it("parses +500K uppercase as case insensitive", () => {
    const result = parseUserTokenBudget("+500K UPPERCASE");
    expect(result.tokens).toBe(500_000);
    expect(result.cleanedText).toBe("UPPERCASE");
  });

  it("parses +2M uppercase suffix", () => {
    const result = parseUserTokenBudget("+2M do things");
    expect(result.tokens).toBe(2_000_000);
    expect(result.cleanedText).toBe("do things");
  });

  // -----------------------------------------------------------------------
  // False positive rejection (mid-sentence)
  // -----------------------------------------------------------------------

  it("rejects mid-sentence +500k (not at start or end)", () => {
    const result = parseUserTokenBudget("I earned +500k last year");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("I earned +500k last year");
  });

  it("rejects +Nk surrounded by other words", () => {
    const result = parseUserTokenBudget("My salary is +200k per year now");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("My salary is +200k per year now");
  });

  // -----------------------------------------------------------------------
  // Range enforcement
  // -----------------------------------------------------------------------

  it("rejects +5k below MIN_USER_BUDGET of 10K", () => {
    const result = parseUserTokenBudget("+5k too small");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("+5k too small");
  });

  it("rejects +999m above MAX_USER_BUDGET of 10M", () => {
    const result = parseUserTokenBudget("+999m too large");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("+999m too large");
  });

  it("accepts exactly MIN_USER_BUDGET (10k)", () => {
    const result = parseUserTokenBudget("+10k at minimum");
    expect(result.tokens).toBe(10_000);
    expect(result.cleanedText).toBe("at minimum");
  });

  it("accepts exactly MAX_USER_BUDGET (10m)", () => {
    const result = parseUserTokenBudget("+10m at maximum");
    expect(result.tokens).toBe(10_000_000);
    expect(result.cleanedText).toBe("at maximum");
  });

  // -----------------------------------------------------------------------
  // No match cases
  // -----------------------------------------------------------------------

  it("returns undefined tokens for plain text", () => {
    const result = parseUserTokenBudget("no budget here");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("no budget here");
  });

  it("returns undefined tokens for empty string", () => {
    const result = parseUserTokenBudget("");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("handles leading whitespace before +Nk", () => {
    const result = parseUserTokenBudget("  +500k hello");
    expect(result.tokens).toBe(500_000);
    expect(result.cleanedText).toBe("hello");
  });

  it("handles trailing whitespace after +Nk at end", () => {
    const result = parseUserTokenBudget("hello +500k  ");
    expect(result.tokens).toBe(500_000);
    expect(result.cleanedText).toBe("hello");
  });

  it("rejects +0k (zero tokens)", () => {
    const result = parseUserTokenBudget("+0k hello");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("+0k hello");
  });

  it("does not match without + prefix", () => {
    const result = parseUserTokenBudget("500k hello");
    expect(result.tokens).toBeUndefined();
    expect(result.cleanedText).toBe("500k hello");
  });
});
