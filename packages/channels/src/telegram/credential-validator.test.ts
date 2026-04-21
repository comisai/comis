// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateBotToken, validateWebhookSecret } from "./credential-validator.js";

// Mock the Grammy Bot class
const mockGetMe = vi.fn();
vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function () {
    return { api: { getMe: mockGetMe } };
  }),
}));

describe("credential-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateBotToken", () => {
    it("returns ok with BotInfo on valid token", async () => {
      mockGetMe.mockResolvedValueOnce({
        id: 123456789,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      });

      const result = await validateBotToken("123456:valid-token");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          id: 123456789,
          username: "test_bot",
          isBot: true,
        });
      }
    });

    it("returns ok with empty username when getMe has no username", async () => {
      mockGetMe.mockResolvedValueOnce({
        id: 999,
        is_bot: true,
        first_name: "NoUsernameBot",
        username: undefined,
      });

      const result = await validateBotToken("999:token");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.username).toBe("");
      }
    });

    it("returns err with descriptive message when getMe throws", async () => {
      mockGetMe.mockRejectedValueOnce(new Error("Not Found: bot token is invalid"));

      const result = await validateBotToken("bad:token");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid Telegram bot token");
        expect(result.error.message).toContain("Not Found: bot token is invalid");
      }
    });

    it("returns err for empty string token without making API call", async () => {
      const result = await validateBotToken("");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("token must not be empty");
      }
      expect(mockGetMe).not.toHaveBeenCalled();
    });

    it("returns err for whitespace-only token without making API call", async () => {
      const result = await validateBotToken("   ");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("token must not be empty");
      }
      expect(mockGetMe).not.toHaveBeenCalled();
    });

    it("handles non-Error thrown values", async () => {
      mockGetMe.mockRejectedValueOnce("string error");

      const result = await validateBotToken("123:token");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid Telegram bot token");
        expect(result.error.message).toContain("string error");
      }
    });
  });

  describe("validateWebhookSecret", () => {
    it("returns ok for a valid ASCII secret", () => {
      const result = validateWebhookSecret("my-secret-token-123");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("my-secret-token-123");
      }
    });

    it("returns ok for a single-character secret", () => {
      const result = validateWebhookSecret("x");
      expect(result.ok).toBe(true);
    });

    it("returns ok for 256-character secret", () => {
      const result = validateWebhookSecret("a".repeat(256));
      expect(result.ok).toBe(true);
    });

    it("returns err for empty string", () => {
      const result = validateWebhookSecret("");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("must not be empty");
      }
    });

    it("returns err for secret exceeding 256 characters", () => {
      const result = validateWebhookSecret("a".repeat(257));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("1-256 characters");
        expect(result.error.message).toContain("257");
      }
    });

    it("returns err for non-ASCII characters", () => {
      const result = validateWebhookSecret("hello-world-\u00e9");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("ASCII");
      }
    });

    it("returns err for emoji characters", () => {
      const result = validateWebhookSecret("secret-with-emoji-\u{1F600}");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("ASCII");
      }
    });

    it("accepts all printable ASCII characters", () => {
      // All printable ASCII from space (32) to tilde (126)
      let secret = "";
      for (let i = 32; i <= 126; i++) {
        secret += String.fromCharCode(i);
      }
      const result = validateWebhookSecret(secret);
      expect(result.ok).toBe(true);
    });
  });
});
