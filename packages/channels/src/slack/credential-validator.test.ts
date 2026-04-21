// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateSlackCredentials } from "./credential-validator.js";

// Mock the @slack/web-api WebClient
const mockAuthTest = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return { auth: { test: mockAuthTest } };
  }),
}));

describe("credential-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateSlackCredentials", () => {
    it("returns err for empty botToken", async () => {
      const result = await validateSlackCredentials({
        botToken: "",
        mode: "socket",
        appToken: "xapp-1-valid",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("botToken must not be empty");
      }
      expect(mockAuthTest).not.toHaveBeenCalled();
    });

    it("returns err for whitespace-only botToken", async () => {
      const result = await validateSlackCredentials({
        botToken: "   ",
        mode: "http",
        signingSecret: "secret",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("botToken must not be empty");
      }
    });

    it("returns err for socket mode without appToken", async () => {
      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "socket",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Socket Mode requires appToken");
      }
    });

    it("returns err for socket mode with empty appToken", async () => {
      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "socket",
        appToken: "",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Socket Mode requires appToken");
      }
    });

    it("returns err for socket mode with non-xapp- appToken", async () => {
      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "socket",
        appToken: "xoxb-wrong-type",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must start with "xapp-"');
      }
    });

    it("returns err for http mode without signingSecret", async () => {
      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "http",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("HTTP Mode requires signingSecret");
      }
    });

    it("returns err for http mode with empty signingSecret", async () => {
      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "http",
        signingSecret: "",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("HTTP Mode requires signingSecret");
      }
    });

    it("returns ok with SlackBotInfo on successful auth.test()", async () => {
      mockAuthTest.mockResolvedValueOnce({
        ok: true,
        user_id: "U123ABC",
        team_id: "T456DEF",
        bot_id: "B789GHI",
      });

      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "socket",
        appToken: "xapp-1-valid-token",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          userId: "U123ABC",
          teamId: "T456DEF",
          botId: "B789GHI",
        });
      }
    });

    it("returns ok for http mode with valid credentials", async () => {
      mockAuthTest.mockResolvedValueOnce({
        ok: true,
        user_id: "U111",
        team_id: "T222",
        bot_id: "B333",
      });

      const result = await validateSlackCredentials({
        botToken: "xoxb-valid-token",
        mode: "http",
        signingSecret: "abc123secret",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe("U111");
      }
    });

    it("returns err when auth.test() throws", async () => {
      mockAuthTest.mockRejectedValueOnce(new Error("invalid_auth"));

      const result = await validateSlackCredentials({
        botToken: "xoxb-bad-token",
        mode: "socket",
        appToken: "xapp-1-valid",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Slack auth.test() failed");
        expect(result.error.message).toContain("invalid_auth");
      }
    });

    it("handles non-Error thrown values from auth.test()", async () => {
      mockAuthTest.mockRejectedValueOnce("string error");

      const result = await validateSlackCredentials({
        botToken: "xoxb-token",
        mode: "http",
        signingSecret: "secret",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Slack auth.test() failed");
        expect(result.error.message).toContain("string error");
      }
    });

    it("handles undefined fields in auth.test() response gracefully", async () => {
      mockAuthTest.mockResolvedValueOnce({
        ok: true,
        user_id: undefined,
        team_id: undefined,
        bot_id: undefined,
      });

      const result = await validateSlackCredentials({
        botToken: "xoxb-token",
        mode: "socket",
        appToken: "xapp-1-token",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // undefined ?? "" -> "" -> String("") -> ""
        expect(result.value.userId).toBe("");
        expect(result.value.teamId).toBe("");
        expect(result.value.botId).toBe("");
      }
    });
  });
});
