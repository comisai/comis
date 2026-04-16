import { describe, it, expect } from "vitest";
import {
  buildMessagingSection,
  buildBackgroundTaskSection,
  buildSilentRepliesSection,
  buildHeartbeatsSection,
} from "./messaging-sections.js";

// ---------------------------------------------------------------------------
// buildMessagingSection
// ---------------------------------------------------------------------------

describe("buildMessagingSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildMessagingSection(["message"], true)).toEqual([]);
  });

  it("returns empty when message tool not in toolNames", () => {
    expect(buildMessagingSection(["exec", "read"], false)).toEqual([]);
  });

  it("returns Messaging heading with routing and rules when message tool present", () => {
    const result = buildMessagingSection(["message"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Messaging");
    expect(joined).toContain("### Routing");
    expect(joined).toContain("### Message Tool");
    expect(joined).toContain("### Rules");
  });

  it("includes Reply Tags subsection with reply tag syntax", () => {
    const result = buildMessagingSection(["message"], false);
    const joined = result.join("\n");
    expect(joined).toContain("### Reply Tags");
    expect(joined).toContain('<reply to="channel-id">');
    expect(joined).toContain("<reply>message</reply>");
  });

  it("includes current channel info when channelContext provided", () => {
    const result = buildMessagingSection(["message"], false, {
      channelType: "telegram",
      channelId: "chat-123",
    });
    const joined = result.join("\n");
    expect(joined).toContain("telegram");
    expect(joined).toContain("chat-123");
  });

  it("omits current channel info when channelContext not provided", () => {
    const result = buildMessagingSection(["message"], false);
    const joined = result.join("\n");
    expect(joined).not.toContain("Your current channel:");
  });
});

// ---------------------------------------------------------------------------
// buildBackgroundTaskSection
// ---------------------------------------------------------------------------

describe("buildBackgroundTaskSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildBackgroundTaskSection(["sessions_spawn"], true)).toEqual([]);
  });

  it("returns empty when sessions_spawn not in toolNames", () => {
    expect(buildBackgroundTaskSection(["exec"], false)).toEqual([]);
  });

  it("returns Background Tasks heading with spawn instructions", () => {
    const result = buildBackgroundTaskSection(["sessions_spawn"], false);
    const joined = result.join("\n");
    expect(joined).toContain("## Background Tasks");
    expect(joined).toContain("sessions_spawn");
  });

  it("includes channel context when provided", () => {
    const result = buildBackgroundTaskSection(["sessions_spawn"], false, {
      channelType: "discord",
      channelId: "guild-456",
    });
    const joined = result.join("\n");
    expect(joined).toContain("discord");
    expect(joined).toContain("guild-456");
  });
});

// ---------------------------------------------------------------------------
// buildSilentRepliesSection
// ---------------------------------------------------------------------------

describe("buildSilentRepliesSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildSilentRepliesSection(true)).toEqual([]);
  });

  it("returns Silent Replies heading with NO_REPLY and HEARTBEAT_OK tokens", () => {
    const result = buildSilentRepliesSection(false);
    const joined = result.join("\n");
    expect(joined).toContain("## Silent Replies");
    expect(joined).toContain("NO_REPLY");
    expect(joined).toContain("HEARTBEAT_OK");
  });

  it("includes right/wrong examples", () => {
    const result = buildSilentRepliesSection(false);
    const joined = result.join("\n");
    expect(joined).toContain("WRONG:");
    expect(joined).toContain("RIGHT:");
  });
});

// ---------------------------------------------------------------------------
// buildHeartbeatsSection
// ---------------------------------------------------------------------------

describe("buildHeartbeatsSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildHeartbeatsSection("check status", true)).toEqual([]);
  });

  it("returns empty when no heartbeat prompt provided", () => {
    expect(buildHeartbeatsSection(undefined, false)).toEqual([]);
  });

  it("returns Heartbeats heading with prompt text when provided", () => {
    const result = buildHeartbeatsSection("system check", false);
    const joined = result.join("\n");
    expect(joined).toContain("## Heartbeats");
    expect(joined).toContain("system check");
  });
});
