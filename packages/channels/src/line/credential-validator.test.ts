// SPDX-License-Identifier: Apache-2.0
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

  it("classifies an unreachable LINE API as a network failure (not a bad credential)", async () => {
    const { CredentialValidationError } = await import("../shared/credential-validation-error.js");
    mockGetBotInfo.mockRejectedValueOnce(new Error("fetch failed: connect ETIMEDOUT 1.2.3.4:443"));

    const result = await validateLineCredentials({
      channelAccessToken: "valid-but-unreachable",
      channelSecret: "valid-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CredentialValidationError);
      expect((result.error as InstanceType<typeof CredentialValidationError>).kind).toBe("network");
      expect(result.error.message).toContain("unreachable");
    }
  });

  it("passes baseURL to MessagingApiClient when apiRoot is provided (E2E seam)", async () => {
    // apiRoot threads through as httpClientConfig.baseURL so getBotInfo()
    // hits the 127.0.0.1 mock instead of api.line.me.
    mockGetBotInfo.mockResolvedValueOnce({
      displayName: "Mock", userId: "U", basicId: "@m", chatMode: "bot", markAsReadMode: "auto",
    });
    const sdk = await import("@line/bot-sdk");
    const mockCtor = vi.mocked(sdk.messagingApi.MessagingApiClient);
    mockCtor.mockClear();

    await validateLineCredentials({
      channelAccessToken: "tok",
      channelSecret: "sec",
      apiRoot: "http://127.0.0.1:54325",
    });

    expect(mockCtor).toHaveBeenCalledWith({
      channelAccessToken: "tok",
      baseURL: "http://127.0.0.1:54325",
    });
  });

  it("omits baseURL from MessagingApiClient when apiRoot is undefined (production byte-identical)", async () => {
    mockGetBotInfo.mockResolvedValueOnce({
      displayName: "Mock", userId: "U", basicId: "@m", chatMode: "bot", markAsReadMode: "auto",
    });
    const sdk = await import("@line/bot-sdk");
    const mockCtor = vi.mocked(sdk.messagingApi.MessagingApiClient);
    mockCtor.mockClear();

    await validateLineCredentials({
      channelAccessToken: "tok",
      channelSecret: "sec",
    });

    expect(mockCtor).toHaveBeenCalledWith({ channelAccessToken: "tok" });
  });
});
