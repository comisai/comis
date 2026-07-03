// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { mapMsTeamsActivityToNormalized, type TeamsActivity } from "./message-mapper.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build a minimal message activity; each test overrides only the fields it
 * exercises. The base is a team-channel activity with a full sender.
 */
function makeActivity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "activity-1",
    text: "hello",
    conversation: { id: "19:conv@thread.tacv2", conversationType: "channel" },
    from: { id: "29:user-id", aadObjectId: "aad-object-id" },
    serviceUrl: "https://smba.example.net/amer/",
    ...overrides,
  };
}

describe("mapMsTeamsActivityToNormalized", () => {
  it("normalizes a personal (1:1) activity to chatType dm", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({ conversation: { id: "19:dm@thread.tacv2", conversationType: "personal" } }),
    );
    expect(result?.chatType).toBe("dm");
  });

  it("normalizes a groupChat activity to chatType group", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({ conversation: { id: "19:grp@thread.tacv2", conversationType: "groupChat" } }),
    );
    expect(result?.chatType).toBe("group");
  });

  it("normalizes a team-channel activity to chatType channel", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({ conversation: { id: "19:chn@thread.tacv2", conversationType: "channel" } }),
    );
    expect(result?.chatType).toBe("channel");
  });

  it("defaults chatType to channel when conversationType is absent", () => {
    const result = mapMsTeamsActivityToNormalized({
      type: "message",
      conversation: { id: "19:no-type@thread.tacv2" },
      from: { id: "29:user-id" },
    });
    expect(result?.chatType).toBe("channel");
  });

  it("strips the trailing messageid reply suffix from the channelId", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        conversation: {
          id: "19:abc@thread.tacv2;messageid=1700000000000",
          conversationType: "channel",
        },
      }),
    );
    expect(result?.channelId).toBe("19:abc@thread.tacv2");
  });

  it("leaves the channelId unchanged when no messageid suffix is present", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({ conversation: { id: "19:plain@thread.tacv2", conversationType: "channel" } }),
    );
    expect(result?.channelId).toBe("19:plain@thread.tacv2");
  });

  it("prefers from.aadObjectId over from.id for the senderId", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({ from: { id: "29:fallback-id", aadObjectId: "aad-primary" } }),
    );
    expect(result?.senderId).toBe("aad-primary");
  });

  it("falls back to from.id for senderId when aadObjectId is absent", () => {
    const result = mapMsTeamsActivityToNormalized(makeActivity({ from: { id: "29:only-id" } }));
    expect(result?.senderId).toBe("29:only-id");
  });

  it("falls back to the unknown sentinel senderId when from is absent", () => {
    const result = mapMsTeamsActivityToNormalized(makeActivity({ from: undefined }));
    expect(result?.senderId).toBe("unknown");
  });

  it("strips at-mention markup from the normalized text", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({ text: '<at id="0">Support Bot</at> hello team' }),
    );
    expect(result?.text).toBe("hello team");
  });

  it("yields empty text when the activity carries no text", () => {
    const result = mapMsTeamsActivityToNormalized(makeActivity({ text: undefined }));
    expect(result?.text).toBe("");
  });

  it("returns null for a non-message conversationUpdate activity", () => {
    const result = mapMsTeamsActivityToNormalized(makeActivity({ type: "conversationUpdate" }));
    expect(result).toBeNull();
  });

  it("records teamsActivityId, serviceUrl, tenantId and replyToId in metadata", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        id: "act-42",
        serviceUrl: "https://smba.example.net/amer/",
        replyToId: "reply-7",
        channelData: { tenant: { id: "tenant-a" } },
        conversation: { id: "19:c@thread.tacv2", conversationType: "channel", tenantId: "tenant-b" },
      }),
    );
    expect(result?.metadata.teamsActivityId).toBe("act-42");
    expect(result?.metadata.serviceUrl).toBe("https://smba.example.net/amer/");
    expect(result?.metadata.replyToId).toBe("reply-7");
    // channelData.tenant.id wins over conversation.tenantId
    expect(result?.metadata.tenantId).toBe("tenant-a");
  });

  it("falls back to conversation.tenantId when channelData tenant is absent", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        channelData: undefined,
        conversation: { id: "19:c@thread.tacv2", conversationType: "channel", tenantId: "tenant-b" },
      }),
    );
    expect(result?.metadata.tenantId).toBe("tenant-b");
  });

  it("drops absent optional metadata keys rather than storing undefined", () => {
    const result = mapMsTeamsActivityToNormalized({
      type: "message",
      conversation: { id: "19:c@thread.tacv2", conversationType: "personal" },
      from: { id: "29:user-id" },
    });
    expect(result?.metadata.teamsActivityId).toBeUndefined();
    expect(result?.metadata.serviceUrl).toBeUndefined();
    expect(result?.metadata.replyToId).toBeUndefined();
    expect(result?.metadata.tenantId).toBeUndefined();
  });

  it("sets channelType msteams with a fresh uuid, positive timestamp and empty attachments", () => {
    const result = mapMsTeamsActivityToNormalized(makeActivity());
    expect(result?.channelType).toBe("msteams");
    expect(result?.id).toMatch(UUID_RE);
    expect(Number.isInteger(result?.timestamp)).toBe(true);
    expect(result?.timestamp ?? 0).toBeGreaterThan(0);
    expect(result?.attachments).toEqual([]);
  });

  it("extracts the channel thread root from the messageid suffix, leaving channelId stripped", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        conversation: {
          id: "19:abc@thread.tacv2;messageid=1700000000000",
          conversationType: "channel",
        },
      }),
    );
    expect(result?.metadata.msteamsThreadId).toBe("1700000000000");
    // The stripped channelId is unchanged — the send path interpolates it.
    expect(result?.channelId).toBe("19:abc@thread.tacv2");
  });

  it("falls back to replyToId for the channel thread root when no messageid suffix is present", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        conversation: { id: "19:plain@thread.tacv2", conversationType: "channel" },
        replyToId: "reply-root-9",
      }),
    );
    expect(result?.metadata.msteamsThreadId).toBe("reply-root-9");
  });

  it("sets no thread root for a personal (1:1) activity", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        conversation: {
          id: "19:dm@thread.tacv2;messageid=1700000000000",
          conversationType: "personal",
        },
        replyToId: "reply-root-9",
      }),
    );
    expect(result?.metadata.msteamsThreadId).toBeUndefined();
  });

  it("flags mentionedBot true when an entity mentions the recipient id", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        recipient: { id: "28:bot-app-id" },
        entities: [{ type: "mention", mentioned: { id: "28:bot-app-id" } }],
      }),
    );
    expect(result?.metadata.mentionedBot).toBe(true);
  });

  it("flags mentionedBot false when no entity mentions the recipient id", () => {
    const result = mapMsTeamsActivityToNormalized(
      makeActivity({
        recipient: { id: "28:bot-app-id" },
        entities: [{ type: "mention", mentioned: { id: "29:someone-else" } }],
      }),
    );
    expect(result?.metadata.mentionedBot).toBe(false);
  });
});
