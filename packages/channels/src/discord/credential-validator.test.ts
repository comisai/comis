// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock discord.js REST class
const mockGet = vi.fn();

vi.mock("discord.js", () => {
  class MockREST {
    setToken(_token: string) {
      return this;
    }
    get = mockGet;
  }

  return {
    REST: MockREST,
    Routes: {
      user: (id: string) => `/users/${id}`,
    },
  };
});

import { validateDiscordToken } from "./credential-validator.js";

describe("credential-validator / validateDiscordToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok with DiscordBotInfo on valid token", async () => {
    mockGet.mockResolvedValueOnce({
      id: "123456789",
      username: "test_bot",
      discriminator: "0",
    });

    const result = await validateDiscordToken("valid-bot-token");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        id: "123456789",
        username: "test_bot",
        discriminator: "0",
      });
    }
  });

  it("returns err for empty string token without making API call", async () => {
    const result = await validateDiscordToken("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("token must not be empty");
    }
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns err for whitespace-only token without making API call", async () => {
    const result = await validateDiscordToken("   ");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("token must not be empty");
    }
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns err with descriptive message when REST API throws", async () => {
    mockGet.mockRejectedValueOnce(new Error("401: Unauthorized"));

    const result = await validateDiscordToken("bad-token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid Discord bot token");
      expect(result.error.message).toContain("401: Unauthorized");
    }
  });

  it("handles non-Error thrown values", async () => {
    mockGet.mockRejectedValueOnce("string error");

    const result = await validateDiscordToken("some-token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid Discord bot token");
      expect(result.error.message).toContain("string error");
    }
  });
});
