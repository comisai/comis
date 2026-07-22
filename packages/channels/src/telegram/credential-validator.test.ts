// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateBotToken, validateWebhookSecret } from "./credential-validator.js";
import { Bot } from "grammy";

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

    it("classifies transport failures separately from invalid credentials", async () => {
      mockGetMe.mockRejectedValueOnce(
        Object.assign(new Error("Network request for getMe failed"), { name: "HttpError" }),
      );

      const result = await validateBotToken("123:token", "http://127.0.0.1:54321");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as Error & { failureKind?: string }).failureKind).toBe("network");
        expect(result.error.message).toContain("Telegram bot validation failed");
      }
    });

    it("classifies Telegram authentication responses separately from service failures", async () => {
      mockGetMe
        .mockRejectedValueOnce(
          Object.assign(new Error("Unauthorized"), { name: "GrammyError", error_code: 401 }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("Service unavailable"), { name: "GrammyError", error_code: 503 }),
        );

      const authResult = await validateBotToken("123:token");
      const serviceResult = await validateBotToken("123:token");

      expect(authResult.ok).toBe(false);
      expect(serviceResult.ok).toBe(false);
      if (!authResult.ok) {
        expect((authResult.error as Error & { failureKind?: string }).failureKind).toBe("auth");
      }
      if (!serviceResult.ok) {
        expect((serviceResult.error as Error & { failureKind?: string }).failureKind).toBe("dependency");
      }
    });

    it("redacts credentials embedded in Telegram SDK failures", async () => {
      const credential = `xoxb-${"s".repeat(32)}`;
      mockGetMe.mockRejectedValueOnce(new Error(`request failed with ${credential}`));

      const result = await validateBotToken("123456:test-token");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid Telegram bot token");
        expect(result.error.message).not.toContain(credential);
      }
    });

    it("returns err for empty string token without making API call", async () => {
      const result = await validateBotToken("");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("token must not be empty");
        expect((result.error as Error & { failureKind?: string }).failureKind).toBe("validation");
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

    it("passes client.apiRoot to grammy Bot constructor when apiRoot is provided", async () => {
      // apiRoot threads through to grammy for E2E redirection to 127.0.0.1
      // mock. Production callers leave it undefined and grammy uses its
      // default (https://api.telegram.org).
      mockGetMe.mockResolvedValueOnce({ id: 1, is_bot: true, username: "bot" });
      const mockBot = vi.mocked(Bot);
      mockBot.mockClear();

      await validateBotToken("123:token", "http://127.0.0.1:54321");

      expect(mockBot).toHaveBeenCalledWith("123:token", {
        client: { apiRoot: "http://127.0.0.1:54321" },
      });
    });

    it("calls grammy Bot constructor with token only when apiRoot is omitted", async () => {
      mockGetMe.mockResolvedValueOnce({ id: 1, is_bot: true, username: "bot" });
      const mockBot = vi.mocked(Bot);
      mockBot.mockClear();

      await validateBotToken("123:token");

      // Production-path call shape: positional token only, no options object.
      expect(mockBot).toHaveBeenCalledWith("123:token");
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
