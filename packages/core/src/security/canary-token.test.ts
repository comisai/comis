import { describe, it, expect } from "vitest";
import { generateCanaryToken, detectCanaryLeakage } from "./canary-token.js";

describe("generateCanaryToken", () => {
  it("produces deterministic output for same session + secret", () => {
    const token1 = generateCanaryToken("default:alice:ch-1", "test-secret");
    const token2 = generateCanaryToken("default:alice:ch-1", "test-secret");
    expect(token1).toBe(token2);
  });

  it("produces different tokens for different sessions", () => {
    const token1 = generateCanaryToken("default:alice:ch-1", "test-secret");
    const token2 = generateCanaryToken("default:bob:ch-2", "test-secret");
    expect(token1).not.toBe(token2);
  });

  it("produces different tokens for different secrets", () => {
    const token1 = generateCanaryToken("default:alice:ch-1", "secret-a");
    const token2 = generateCanaryToken("default:alice:ch-1", "secret-b");
    expect(token1).not.toBe(token2);
  });

  it('returns a token matching format "CTKN_" followed by 16 hex chars', () => {
    const token = generateCanaryToken("default:alice:ch-1", "test-secret");
    expect(token).toMatch(/^CTKN_[a-f0-9]{16}$/);
  });
});

describe("detectCanaryLeakage", () => {
  it("returns true when response contains the canary token", () => {
    const canary = generateCanaryToken("default:alice:ch-1", "test-secret");
    const response = `Here is some text with ${canary} embedded in it.`;
    expect(detectCanaryLeakage(response, canary)).toBe(true);
  });

  it("returns false when response does not contain the canary token", () => {
    const canary = generateCanaryToken("default:alice:ch-1", "test-secret");
    const response = "This response has no canary token in it.";
    expect(detectCanaryLeakage(response, canary)).toBe(false);
  });

  it("returns true when canary is at the start of the response", () => {
    const canary = generateCanaryToken("default:alice:ch-1", "test-secret");
    const response = `${canary} starts this response.`;
    expect(detectCanaryLeakage(response, canary)).toBe(true);
  });

  it("returns true when canary is at the end of the response", () => {
    const canary = generateCanaryToken("default:alice:ch-1", "test-secret");
    const response = `This response ends with ${canary}`;
    expect(detectCanaryLeakage(response, canary)).toBe(true);
  });
});
