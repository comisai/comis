import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { executeSlackAction } from "./slack-actions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
    level: "debug",
  } as any;
}

function makeMockApp() {
  return {
    client: {
      pins: {
        add: vi.fn(),
        remove: vi.fn(),
      },
      conversations: {
        setTopic: vi.fn(),
        setPurpose: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        create: vi.fn().mockResolvedValue({ channel: { id: "C123" } }),
        invite: vi.fn(),
        kick: vi.fn(),
        info: vi.fn().mockResolvedValue({
          channel: {
            id: "C123",
            name: "general",
            topic: { value: "General chat" },
            purpose: { value: "General purpose" },
            is_archived: false,
            num_members: 42,
          },
        }),
        members: vi.fn().mockResolvedValue({ members: ["U1", "U2", "U3"] }),
      },
      bookmarks: {
        add: vi.fn(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSlackAction", () => {
  let app: ReturnType<typeof makeMockApp>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeMockApp();
    logger = makeLogger();
  });

  // -- pin / unpin --

  it("pin: calls pins.add with channel and timestamp", async () => {
    const result = await executeSlackAction(
      app, "pin", { channel_id: "C123", message_id: "1234567890.123456" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ pinned: true });
    }
    expect(app.client.pins.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234567890.123456",
    });
  });

  it("unpin: calls pins.remove with channel and timestamp", async () => {
    const result = await executeSlackAction(
      app, "unpin", { channel_id: "C123", message_id: "1234567890.123456" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ unpinned: true });
    }
    expect(app.client.pins.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234567890.123456",
    });
  });

  // -- set_topic / set_purpose --

  it("set_topic: calls conversations.setTopic", async () => {
    const result = await executeSlackAction(
      app, "set_topic", { channel_id: "C123", topic: "New Topic" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ topicSet: true });
    }
    expect(app.client.conversations.setTopic).toHaveBeenCalledWith({
      channel: "C123",
      topic: "New Topic",
    });
  });

  it("set_purpose: calls conversations.setPurpose", async () => {
    const result = await executeSlackAction(
      app, "set_purpose", { channel_id: "C123", purpose: "New Purpose" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ purposeSet: true });
    }
    expect(app.client.conversations.setPurpose).toHaveBeenCalledWith({
      channel: "C123",
      purpose: "New Purpose",
    });
  });

  // -- archive / unarchive --

  it("archive: calls conversations.archive", async () => {
    const result = await executeSlackAction(
      app, "archive", { channel_id: "C123" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ archived: true });
    }
    expect(app.client.conversations.archive).toHaveBeenCalledWith({ channel: "C123" });
  });

  it("unarchive: calls conversations.unarchive", async () => {
    const result = await executeSlackAction(
      app, "unarchive", { channel_id: "C123" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ unarchived: true });
    }
    expect(app.client.conversations.unarchive).toHaveBeenCalledWith({ channel: "C123" });
  });

  // -- create_channel --

  it("create_channel: calls conversations.create and returns channelId", async () => {
    const result = await executeSlackAction(
      app, "create_channel", { name: "new-channel", is_private: false }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.channelId).toBe("C123");
      expect(value.name).toBe("new-channel");
    }
    expect(app.client.conversations.create).toHaveBeenCalledWith({
      name: "new-channel",
      is_private: false,
    });
  });

  // -- invite / kick --

  it("invite: calls conversations.invite with joined user_ids", async () => {
    const result = await executeSlackAction(
      app, "invite", { channel_id: "C123", user_ids: ["U1", "U2"] }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ invited: true });
    }
    expect(app.client.conversations.invite).toHaveBeenCalledWith({
      channel: "C123",
      users: "U1,U2",
    });
  });

  it("kick: calls conversations.kick", async () => {
    const result = await executeSlackAction(
      app, "kick", { channel_id: "C123", user_id: "U1" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kicked: true });
    }
    expect(app.client.conversations.kick).toHaveBeenCalledWith({
      channel: "C123",
      user: "U1",
    });
  });

  // -- channel_info --

  it("channel_info: returns mapped channel info", async () => {
    const result = await executeSlackAction(
      app, "channel_info", { channel_id: "C123" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.id).toBe("C123");
      expect(value.name).toBe("general");
      expect(value.topic).toBe("General chat");
      expect(value.purpose).toBe("General purpose");
      expect(value.isArchived).toBe(false);
      expect(value.memberCount).toBe(42);
    }
  });

  // -- members_list --

  it("members_list: returns member list", async () => {
    const result = await executeSlackAction(
      app, "members_list", { channel_id: "C123" }, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.members).toEqual(["U1", "U2", "U3"]);
    }
  });

  // -- bookmark_add --

  it("bookmark_add: calls bookmarks.add", async () => {
    const result = await executeSlackAction(
      app, "bookmark_add",
      { channel_id: "C123", title: "Wiki", link: "https://wiki.example.com" },
      logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ bookmarkAdded: true });
    }
    expect(app.client.bookmarks.add).toHaveBeenCalledWith({
      channel_id: "C123",
      title: "Wiki",
      link: "https://wiki.example.com",
      type: "link",
    });
  });

  // -- sendTyping --

  it("sendTyping: returns ok with typing=false (Slack unsupported)", async () => {
    const result = await executeSlackAction(
      app, "sendTyping", {}, logger,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value.typing).toBe(false);
    }
  });

  // -- Default (unsupported) --

  it("returns err for unsupported action and logs warning", async () => {
    const result = await executeSlackAction(
      app, "unknownAction", {}, logger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Unsupported action: unknownAction on slack");
    }
    expect(logger.warn).toHaveBeenCalled();
  });

  // -- Error handling --

  it("wraps thrown errors in err result", async () => {
    app.client.pins.add.mockRejectedValue(new Error("API rate limited"));

    const result = await executeSlackAction(
      app, "pin", { channel_id: "C123", message_id: "ts-1" }, logger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Slack action 'pin' failed");
      expect(result.error.message).toContain("API rate limited");
    }
  });
});
