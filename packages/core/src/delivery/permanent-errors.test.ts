// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isPermanentError, PERMANENT_ERROR_PATTERNS } from "./permanent-errors.js";

describe("PERMANENT_ERROR_PATTERNS", () => {
  it("exports 7 patterns", () => {
    expect(PERMANENT_ERROR_PATTERNS).toHaveLength(7);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(PERMANENT_ERROR_PATTERNS)).toBe(true);
  });
});

describe("isPermanentError", () => {
  // -------------------------------------------------------------------------
  // Permanent errors -- should return true
  // -------------------------------------------------------------------------

  describe("permanent errors", () => {
    it("matches 'chat not found'", () => {
      expect(isPermanentError("Bad Request: chat not found")).toBe(true);
    });

    it("matches 'user not found'", () => {
      expect(isPermanentError("Error: user not found")).toBe(true);
    });

    it("matches 'bot was blocked by the user'", () => {
      expect(isPermanentError("Forbidden: bot was blocked by the user")).toBe(true);
    });

    it("matches 'Bot was blocked' (capitalized)", () => {
      expect(isPermanentError("Bot was blocked")).toBe(true);
    });

    it("matches 'Forbidden: bot was kicked from the group chat'", () => {
      expect(isPermanentError("Forbidden: bot was kicked from the group chat")).toBe(true);
    });

    it("matches 'chat_id is empty'", () => {
      expect(isPermanentError("Bad Request: chat_id is empty")).toBe(true);
    });

    it("matches 'no conversation reference found'", () => {
      expect(isPermanentError("Error: no conversation reference found for user")).toBe(true);
    });

    it("matches 'ambiguous recipient'", () => {
      expect(isPermanentError("Error: ambiguous message recipient")).toBe(true);
    });

    it("matches 'ambiguous target recipient'", () => {
      expect(isPermanentError("ambiguous target recipient detected")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Case insensitivity
  // -------------------------------------------------------------------------

  describe("case insensitivity", () => {
    it("matches 'CHAT NOT FOUND' (uppercase)", () => {
      expect(isPermanentError("CHAT NOT FOUND")).toBe(true);
    });

    it("matches 'Chat Not Found' (mixed case)", () => {
      expect(isPermanentError("Chat Not Found")).toBe(true);
    });

    it("matches 'BOT WAS BLOCKED' (uppercase)", () => {
      expect(isPermanentError("BOT WAS BLOCKED by the user")).toBe(true);
    });

    it("matches 'User Not Found' (mixed case)", () => {
      expect(isPermanentError("User Not Found")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Transient errors -- should return false
  // -------------------------------------------------------------------------

  describe("transient errors (not permanent)", () => {
    it("returns false for 'Request timeout'", () => {
      expect(isPermanentError("Request timeout")).toBe(false);
    });

    it("returns false for 'Internal Server Error'", () => {
      expect(isPermanentError("Internal Server Error")).toBe(false);
    });

    it("returns false for 'rate limit exceeded'", () => {
      expect(isPermanentError("429 Too Many Requests: rate limit exceeded")).toBe(false);
    });

    it("returns false for '500 Server Error'", () => {
      expect(isPermanentError("500 Server Error")).toBe(false);
    });

    it("returns false for 'ECONNRESET'", () => {
      expect(isPermanentError("ECONNRESET: connection reset by peer")).toBe(false);
    });

    it("returns false for 'ETIMEDOUT'", () => {
      expect(isPermanentError("ETIMEDOUT")).toBe(false);
    });

    it("returns false for generic network error", () => {
      expect(isPermanentError("Network error: could not reach server")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isPermanentError("")).toBe(false);
    });

    it("returns false for 'Bad Request: message is too long'", () => {
      expect(isPermanentError("Bad Request: message is too long")).toBe(false);
    });
  });
});
