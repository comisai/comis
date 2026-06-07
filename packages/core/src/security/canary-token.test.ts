// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { generateCanaryToken, detectCanaryLeakage } from "./canary-token.js";
import { formatSessionKey, type SessionKey } from "../domain/session-key.js";

describe("generateCanaryToken", () => {
  it("produces deterministic output for same session + secret", () => {
    const token1 = generateCanaryToken("default:alice:ch-1", "test-secret");
    const token2 = generateCanaryToken("default:alice:ch-1", "test-secret");
    expect(token1).toBe(token2);
  });

  // WR-03: callers must salt with formatSessionKey(sessionKey), NOT
  // String(sessionKey). A SessionKey is a plain Zod object with no toString(),
  // so String(key) yields the constant "[object Object]" for EVERY session —
  // collapsing the session-binding to a constant. This test documents that
  // pitfall and pins the correct (formatted) behavior the hook now uses.
  it("formatSessionKey salt yields per-session canaries; String(object) collapses to a constant", () => {
    const keyA: SessionKey = { tenantId: "default", userId: "alice", channelId: "ch-1" };
    const keyB: SessionKey = { tenantId: "default", userId: "bob", channelId: "ch-2" };

    // Correct salt: formatted session key → distinct per-session canaries.
    const formattedA = generateCanaryToken(formatSessionKey(keyA), "secret");
    const formattedB = generateCanaryToken(formatSessionKey(keyB), "secret");
    expect(formattedA).not.toBe(formattedB);

    // The WR-03 bug: String(object) is the SAME for both sessions → dead binding.
    const stringifiedA = generateCanaryToken(String(keyA), "secret");
    const stringifiedB = generateCanaryToken(String(keyB), "secret");
    expect(String(keyA)).toBe("[object Object]");
    expect(stringifiedA).toBe(stringifiedB);

    // And the correct path must NOT equal the dead-binding path.
    expect(formattedA).not.toBe(stringifiedA);
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
