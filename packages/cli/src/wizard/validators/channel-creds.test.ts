// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  validateChannelCredential,
  getChannelCredentialTypes,
} from "./channel-creds.js";

describe("validateChannelCredential", () => {
  describe("empty values", () => {
    it("rejects empty value for telegram", () => {
      const result = validateChannelCredential("telegram", "botToken", "");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });

    it("rejects empty value for discord", () => {
      const result = validateChannelCredential("discord", "botToken", "");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });

    it("rejects whitespace-only value for slack", () => {
      const result = validateChannelCredential("slack", "botToken", "   ");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });
  });

  describe("telegram", () => {
    it("accepts valid telegram token", () => {
      // Format: digits:alphanumeric, 30+ chars
      const token = "1234567890:ABCdefGHI-jklMNO0123456789";
      const result = validateChannelCredential("telegram", "botToken", token);
      expect(result).toBeUndefined();
    });

    it("rejects too-short telegram token", () => {
      const token = "123:ABC";
      const result = validateChannelCredential("telegram", "botToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Telegram");
    });

    it("rejects wrong format telegram token", () => {
      // Missing the digits:alnum pattern
      const token = "a".repeat(35);
      const result = validateChannelCredential("telegram", "botToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Telegram");
    });
  });

  describe("discord", () => {
    it("accepts valid discord token (50+ chars)", () => {
      const token = "a".repeat(50);
      const result = validateChannelCredential("discord", "botToken", token);
      expect(result).toBeUndefined();
    });

    it("rejects discord token under 50 chars", () => {
      const token = "a".repeat(49);
      const result = validateChannelCredential("discord", "botToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Discord");
    });
  });

  describe("slack", () => {
    it("accepts valid slack bot token", () => {
      const token = "xoxb-" + "a".repeat(15); // 20 chars total
      const result = validateChannelCredential("slack", "botToken", token);
      expect(result).toBeUndefined();
    });

    it("rejects slack bot token with wrong prefix", () => {
      const token = "xoxa-" + "a".repeat(15);
      const result = validateChannelCredential("slack", "botToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Slack bot token");
    });

    it("rejects slack bot token that is too short", () => {
      const token = "xoxb-" + "a".repeat(5); // 10 chars total
      const result = validateChannelCredential("slack", "botToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Slack bot token");
    });

    it("accepts valid slack app token", () => {
      const token = "xapp-" + "a".repeat(15); // 20 chars total
      const result = validateChannelCredential("slack", "appToken", token);
      expect(result).toBeUndefined();
    });

    it("rejects slack app token with wrong prefix", () => {
      const token = "xoxb-" + "a".repeat(15);
      const result = validateChannelCredential("slack", "appToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Slack app token");
    });

    it("rejects slack app token that is too short", () => {
      const token = "xapp-" + "a".repeat(5); // 10 chars total
      const result = validateChannelCredential("slack", "appToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid Slack app token");
    });
  });

  describe("LINE", () => {
    it("accepts valid channel token (100+ chars)", () => {
      const token = "a".repeat(100);
      const result = validateChannelCredential("line", "channelToken", token);
      expect(result).toBeUndefined();
    });

    it("rejects channel token under 100 chars", () => {
      const token = "a".repeat(99);
      const result = validateChannelCredential("line", "channelToken", token);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid LINE channel access token");
    });

    it("accepts valid channel secret (32 hex chars)", () => {
      const secret = "abcdef1234567890abcdef1234567890";
      const result = validateChannelCredential("line", "channelSecret", secret);
      expect(result).toBeUndefined();
    });

    it("rejects channel secret under 32 chars", () => {
      const secret = "abcdef1234567890abcdef123456789"; // 31 chars
      const result = validateChannelCredential("line", "channelSecret", secret);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid LINE channel secret");
    });

    it("rejects non-hex channel secret", () => {
      const secret = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"; // 32 chars but not hex
      const result = validateChannelCredential("line", "channelSecret", secret);
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid LINE channel secret");
    });
  });

  describe("channels with no credentials", () => {
    it("returns undefined for whatsapp", () => {
      expect(
        validateChannelCredential("whatsapp", "anything", "any-value"),
      ).toBeUndefined();
    });

    it("returns undefined for signal", () => {
      expect(
        validateChannelCredential("signal", "anything", "any-value"),
      ).toBeUndefined();
    });

    it("returns undefined for irc", () => {
      expect(
        validateChannelCredential("irc", "anything", "any-value"),
      ).toBeUndefined();
    });
  });

  describe("case insensitivity", () => {
    it("normalizes channel type to lowercase", () => {
      const token = "a".repeat(50);
      expect(
        validateChannelCredential("Discord", "botToken", token),
      ).toBeUndefined();
    });
  });
});

describe("getChannelCredentialTypes", () => {
  it("returns ['botToken'] for telegram", () => {
    expect(getChannelCredentialTypes("telegram")).toEqual(["botToken"]);
  });

  it("returns ['botToken'] for discord", () => {
    expect(getChannelCredentialTypes("discord")).toEqual(["botToken"]);
  });

  it("returns ['botToken', 'appToken'] for slack", () => {
    expect(getChannelCredentialTypes("slack")).toEqual([
      "botToken",
      "appToken",
    ]);
  });

  it("returns ['channelToken', 'channelSecret'] for line", () => {
    expect(getChannelCredentialTypes("line")).toEqual([
      "channelToken",
      "channelSecret",
    ]);
  });

  it("returns [] for whatsapp", () => {
    expect(getChannelCredentialTypes("whatsapp")).toEqual([]);
  });

  it("returns [] for signal", () => {
    expect(getChannelCredentialTypes("signal")).toEqual([]);
  });

  it("returns [] for irc", () => {
    expect(getChannelCredentialTypes("irc")).toEqual([]);
  });

  it("returns [] for unknown channel", () => {
    expect(getChannelCredentialTypes("unknown-channel")).toEqual([]);
  });

  it("is case insensitive", () => {
    expect(getChannelCredentialTypes("Telegram")).toEqual(["botToken"]);
    expect(getChannelCredentialTypes("SLACK")).toEqual([
      "botToken",
      "appToken",
    ]);
  });
});
