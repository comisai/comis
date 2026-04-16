import { describe, it, expect } from "vitest";
import { matchesSecretPattern, isSecretAccessible } from "./secret-access.js";

describe("matchesSecretPattern", () => {
  it("exact match (case-insensitive)", () => {
    expect(matchesSecretPattern("OPENAI_API_KEY", "openai_api_key")).toBe(true);
  });

  it("exact match fails on different name", () => {
    expect(matchesSecretPattern("OPENAI_API_KEY", "anthropic_api_key")).toBe(
      false,
    );
  });

  it("wildcard prefix match", () => {
    expect(matchesSecretPattern("OPENAI_API_KEY", "openai_*")).toBe(true);
  });

  it("wildcard suffix match", () => {
    expect(matchesSecretPattern("MY_OPENAI_KEY", "*_openai_*")).toBe(true);
  });

  it("wildcard star-only matches everything", () => {
    expect(matchesSecretPattern("ANYTHING", "*")).toBe(true);
  });

  it("no wildcard requires exact match", () => {
    expect(matchesSecretPattern("OPENAI_API_KEY", "OPENAI_API")).toBe(false);
  });

  it("handles regex special characters in pattern", () => {
    // Dot should be literal, not regex wildcard
    expect(matchesSecretPattern("my.key", "my.key")).toBe(true);
    expect(matchesSecretPattern("myXkey", "my.key")).toBe(false);
  });
});

describe("isSecretAccessible", () => {
  it("empty array allows all", () => {
    expect(isSecretAccessible("ANY_KEY", [])).toBe(true);
  });

  it("matching pattern allows", () => {
    expect(isSecretAccessible("OPENAI_KEY", ["openai_*"])).toBe(true);
  });

  it("no matching pattern denies", () => {
    expect(isSecretAccessible("STRIPE_KEY", ["openai_*", "anthropic_*"])).toBe(
      false,
    );
  });

  it("multiple patterns, one matches", () => {
    expect(
      isSecretAccessible("ANTHROPIC_KEY", ["openai_*", "anthropic_*"]),
    ).toBe(true);
  });
});
