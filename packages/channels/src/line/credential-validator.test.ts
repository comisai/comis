import { describe, it, expect, vi } from "vitest";

// Mock the @line/bot-sdk before importing the module under test
vi.mock("@line/bot-sdk", () => {
  const mockGetBotInfo = vi.fn();

  return {
    messagingApi: {
      MessagingApiClient: vi.fn().mockImplementation(function () {
        return { getBotInfo: mockGetBotInfo };
      }),
    },
    // Expose mock for test control
    __mockGetBotInfo: mockGetBotInfo,
  };
});

import { validateLineCredentials } from "./credential-validator.js";

// Access the mock function
const { __mockGetBotInfo: mockGetBotInfo } = await import("@line/bot-sdk") as unknown as {
  __mockGetBotInfo: ReturnType<typeof vi.fn>;
};

describe("validateLineCredentials", () => {
  it("returns LineBotInfo on successful validation", async () => {
    mockGetBotInfo.mockResolvedValueOnce({
      displayName: "Test Bot",
      userId: "U00001",
      basicId: "@testbot",
      chatMode: "bot",
      markAsReadMode: "auto",
    });

    const result = await validateLineCredentials({
      channelAccessToken: "valid-token",
      channelSecret: "valid-secret",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.displayName).toBe("Test Bot");
      expect(result.value.userId).toBe("U00001");
      expect(result.value.basicId).toBe("@testbot");
    }
  });

  it("returns error for empty channel access token", async () => {
    const result = await validateLineCredentials({
      channelAccessToken: "",
      channelSecret: "valid-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("channel access token must not be empty");
    }
  });

  it("returns error for whitespace-only channel access token", async () => {
    const result = await validateLineCredentials({
      channelAccessToken: "   ",
      channelSecret: "valid-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("channel access token must not be empty");
    }
  });

  it("returns error for empty channel secret", async () => {
    const result = await validateLineCredentials({
      channelAccessToken: "valid-token",
      channelSecret: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("channel secret must not be empty");
    }
  });

  it("returns error when getBotInfo API call fails", async () => {
    mockGetBotInfo.mockRejectedValueOnce(new Error("Unauthorized"));

    const result = await validateLineCredentials({
      channelAccessToken: "invalid-token",
      channelSecret: "valid-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid LINE credentials");
      expect(result.error.message).toContain("Unauthorized");
    }
  });
});
