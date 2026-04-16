import { describe, it, expect } from "vitest";
import { mapSignalToNormalized } from "./message-mapper.js";
import type { SignalEnvelope } from "./signal-client.js";

const BASE_URL = "http://127.0.0.1:8080";

function makeEnvelope(overrides?: Partial<SignalEnvelope>): SignalEnvelope {
  return {
    source: "+15551234567",
    sourceUuid: "uuid-sender-123",
    sourceName: "Test User",
    timestamp: 1700000000000,
    dataMessage: {
      message: "Hello from Signal",
      groupInfo: null,
      attachments: null,
      reaction: null,
    },
    ...overrides,
  };
}

describe("mapSignalToNormalized", () => {
  it("returns null for envelopes without dataMessage", () => {
    const envelope = makeEnvelope({ dataMessage: null });
    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).toBeNull();
  });

  it("maps DM message correctly", () => {
    const envelope = makeEnvelope();
    const result = mapSignalToNormalized(envelope, BASE_URL);

    expect(result).not.toBeNull();
    expect(result!.channelType).toBe("signal");
    expect(result!.senderId).toBe("uuid-sender-123");
    expect(result!.channelId).toBe("uuid-sender-123");
    expect(result!.text).toBe("Hello from Signal");
    expect(result!.timestamp).toBe(1700000000000);
    expect(result!.metadata.signalTimestamp).toBe(1700000000000);
    expect(result!.metadata.signalSenderName).toBe("Test User");
  });

  it("maps group message with group: prefix channelId", () => {
    const envelope = makeEnvelope({
      dataMessage: {
        message: "Group message",
        groupInfo: {
          groupId: "group-abc-123",
          groupName: "Test Group",
        },
        attachments: null,
        reaction: null,
      },
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("group:group-abc-123");
    expect(result!.metadata.signalGroupId).toBe("group-abc-123");
    expect(result!.metadata.signalGroupName).toBe("Test Group");
  });

  it("maps reaction events", () => {
    const envelope = makeEnvelope({
      dataMessage: {
        message: null,
        groupInfo: null,
        attachments: null,
        reaction: {
          emoji: "\u{1F44D}",
          targetAuthorUuid: "uuid-target",
          targetSentTimestamp: 1699999999999,
        },
      },
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("\u{1F44D}");
    expect(result!.metadata.signalReaction).toBe(true);
    expect(result!.metadata.signalReactionTarget).toBe(1699999999999);
    expect(result!.metadata.signalReactionEmoji).toBe("\u{1F44D}");
  });

  it("maps reaction remove events", () => {
    const envelope = makeEnvelope({
      dataMessage: {
        message: null,
        groupInfo: null,
        attachments: null,
        reaction: {
          emoji: "\u{1F44D}",
          targetAuthorUuid: "uuid-target",
          targetSentTimestamp: 1699999999999,
          isRemove: true,
        },
      },
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.metadata.signalReactionRemove).toBe(true);
  });

  it("returns null for empty messages without attachments", () => {
    const envelope = makeEnvelope({
      dataMessage: {
        message: "",
        groupInfo: null,
        attachments: [],
        reaction: null,
      },
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).toBeNull();
  });

  it("maps attachments via media handler", () => {
    const envelope = makeEnvelope({
      dataMessage: {
        message: "Check this out",
        groupInfo: null,
        attachments: [
          { id: "att-123", contentType: "image/jpeg", filename: "photo.jpg", size: 1024 },
        ],
        reaction: null,
      },
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].type).toBe("image");
    expect(result!.attachments[0].url).toBe("http://127.0.0.1:8080/api/v1/attachments/att-123");
  });

  it("includes quote metadata when present", () => {
    const envelope = makeEnvelope({
      dataMessage: {
        message: "Reply to quote",
        groupInfo: null,
        attachments: null,
        reaction: null,
        quote: {
          id: 1699999999999,
          authorUuid: "uuid-author",
          text: "Original message",
        },
      },
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.metadata.signalQuoteId).toBe(1699999999999);
    expect(result!.metadata.signalQuoteAuthor).toBe("uuid-author");
    expect(result!.metadata.signalQuoteText).toBe("Original message");
  });

  it("falls back to source when sourceUuid is missing", () => {
    const envelope = makeEnvelope({
      sourceUuid: undefined,
      source: "+15559876543",
    });

    const result = mapSignalToNormalized(envelope, BASE_URL);
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe("+15559876543");
  });
});
