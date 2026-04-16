import { describe, it, expect } from "vitest";
import { generateStrongToken, generateRotationId } from "./token-generator.js";

describe("generateStrongToken", () => {
  it("returns a string of exactly 64 characters", () => {
    const token = generateStrongToken();
    expect(token).toHaveLength(64);
  });

  it("output is URL-safe (base64url characters only)", () => {
    const token = generateStrongToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces different values on successive calls", () => {
    const token1 = generateStrongToken();
    const token2 = generateStrongToken();
    expect(token1).not.toBe(token2);
  });
});

describe("generateRotationId", () => {
  it("returns baseId-{suffix} where suffix is 11 chars", () => {
    const result = generateRotationId("my-token");
    const parts = result.split("my-token-");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toHaveLength(11);
  });

  it("produces different suffixes for the same baseId on successive calls", () => {
    const id1 = generateRotationId("tok");
    const id2 = generateRotationId("tok");
    expect(id1).not.toBe(id2);
  });

  it("preserves the baseId prefix exactly", () => {
    const baseId = "complex-base-id-123";
    const result = generateRotationId(baseId);
    expect(result.startsWith(`${baseId}-`)).toBe(true);
  });
});
