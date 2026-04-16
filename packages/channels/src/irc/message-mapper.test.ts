import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mapIrcToNormalized } from "./message-mapper.js";

describe("mapIrcToNormalized", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("channel messages", () => {
    it("maps a channel message with target starting with #", () => {
      const result = mapIrcToNormalized({
        target: "#comis",
        nick: "alice",
        message: "Hello, world!",
      });

      expect(result.channelId).toBe("#comis");
      expect(result.channelType).toBe("irc");
      expect(result.senderId).toBe("alice");
      expect(result.text).toBe("Hello, world!");
      expect(result.attachments).toEqual([]);
      expect(result.metadata).toEqual({
        ircTarget: "#comis",
        ircIsDm: false,
      });
    });

    it("uses Date.now() for timestamp when no server-time tag", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "bob",
        message: "test",
      });

      expect(result.timestamp).toBe(Date.now());
    });
  });

  describe("DM messages", () => {
    it("maps a DM with target as bot nick", () => {
      const result = mapIrcToNormalized({
        target: "ComisBot",
        nick: "charlie",
        message: "Private message",
      });

      // DM: channelId should be sender nick, not target
      expect(result.channelId).toBe("charlie");
      expect(result.channelType).toBe("irc");
      expect(result.senderId).toBe("charlie");
      expect(result.text).toBe("Private message");
      expect(result.metadata).toEqual({
        ircTarget: "ComisBot",
        ircIsDm: true,
      });
    });
  });

  describe("IRCv3 server-time tag", () => {
    it("parses server-time tag as timestamp when present", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "alice",
        message: "timestamped",
        tags: { time: "2026-01-15T10:30:00.000Z" },
      });

      expect(result.timestamp).toBe(new Date("2026-01-15T10:30:00.000Z").getTime());
    });

    it("falls back to Date.now() when server-time tag is absent", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "alice",
        message: "no timestamp",
        tags: {},
      });

      expect(result.timestamp).toBe(Date.now());
    });
  });

  describe("IRCv3 msgid tag", () => {
    it("includes ircMessageId in metadata when msgid tag present", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "alice",
        message: "identified",
        tags: { msgid: "abc123def456" },
      });

      expect(result.metadata).toEqual({
        ircTarget: "#test",
        ircIsDm: false,
        ircMessageId: "abc123def456",
      });
    });

    it("omits ircMessageId when msgid tag is absent", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "alice",
        message: "no id",
      });

      expect(result.metadata).not.toHaveProperty("ircMessageId");
    });
  });

  describe("message shape", () => {
    it("generates a valid UUID for id", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "alice",
        message: "test",
      });

      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("always has empty attachments array", () => {
      const result = mapIrcToNormalized({
        target: "#test",
        nick: "alice",
        message: "test",
      });

      expect(result.attachments).toEqual([]);
    });
  });
});
