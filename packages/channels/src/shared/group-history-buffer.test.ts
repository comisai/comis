import { describe, it, expect } from "vitest";
import type { NormalizedMessage } from "@comis/core";
import { createGroupHistoryBuffer } from "./group-history-buffer.js";

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    channelId: "test-channel",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

describe("createGroupHistoryBuffer", () => {
  it("stores messages and returns formatted history", () => {
    const buffer = createGroupHistoryBuffer(10);
    buffer.push("session-a", makeMsg({ senderId: "alice", text: "hi there" }));
    buffer.push("session-a", makeMsg({ senderId: "bob", text: "hey" }));
    buffer.push("session-a", makeMsg({ senderId: "alice", text: "what's up?" }));

    const formatted = buffer.getFormatted("session-a");
    expect(formatted).toBeDefined();
    expect(formatted).toContain("[Recent group context (3 messages)]:");
    expect(formatted).toContain("[alice]: hi there");
    expect(formatted).toContain("[bob]: hey");
    expect(formatted).toContain("[alice]: what's up?");
  });

  it("ring buffer evicts oldest when exceeding max", () => {
    const maxMessages = 3;
    const buffer = createGroupHistoryBuffer(maxMessages);

    // Push maxMessages + 2 = 5 messages
    buffer.push("session-a", makeMsg({ senderId: "u1", text: "msg-1" }));
    buffer.push("session-a", makeMsg({ senderId: "u2", text: "msg-2" }));
    buffer.push("session-a", makeMsg({ senderId: "u3", text: "msg-3" }));
    buffer.push("session-a", makeMsg({ senderId: "u4", text: "msg-4" }));
    buffer.push("session-a", makeMsg({ senderId: "u5", text: "msg-5" }));

    expect(buffer.depth("session-a")).toBe(maxMessages);

    const formatted = buffer.getFormatted("session-a")!;
    // Oldest two (msg-1, msg-2) should be evicted
    expect(formatted).not.toContain("msg-1");
    expect(formatted).not.toContain("msg-2");
    expect(formatted).toContain("msg-3");
    expect(formatted).toContain("msg-4");
    expect(formatted).toContain("msg-5");
  });

  it("returns undefined when buffer is empty", () => {
    const buffer = createGroupHistoryBuffer(10);
    expect(buffer.getFormatted("nonexistent")).toBeUndefined();
  });

  it("clear removes all messages for a session", () => {
    const buffer = createGroupHistoryBuffer(10);
    buffer.push("session-a", makeMsg({ text: "test" }));
    buffer.push("session-a", makeMsg({ text: "test2" }));

    expect(buffer.depth("session-a")).toBe(2);

    buffer.clear("session-a");

    expect(buffer.depth("session-a")).toBe(0);
    expect(buffer.getFormatted("session-a")).toBeUndefined();
  });

  it("independent sessions do not interfere", () => {
    const buffer = createGroupHistoryBuffer(10);
    buffer.push("session-a", makeMsg({ senderId: "alice", text: "from A" }));
    buffer.push("session-b", makeMsg({ senderId: "bob", text: "from B" }));

    const formattedA = buffer.getFormatted("session-a")!;
    const formattedB = buffer.getFormatted("session-b")!;

    expect(formattedA).toContain("[alice]: from A");
    expect(formattedA).not.toContain("from B");

    expect(formattedB).toContain("[bob]: from B");
    expect(formattedB).not.toContain("from A");
  });

  it("getFormatted includes label when provided", () => {
    const buffer = createGroupHistoryBuffer(10);
    buffer.push("session-a", makeMsg({ senderId: "alice", text: "hi there" }));
    buffer.push("session-a", makeMsg({ senderId: "bob", text: "hey" }));

    const formatted = buffer.getFormatted("session-a", "Project Planning");
    expect(formatted).toBeDefined();
    expect(formatted).toContain('[Session "Project Planning" - Recent group context (2 messages)]:');
    expect(formatted).toContain("[alice]: hi there");
    expect(formatted).toContain("[bob]: hey");
  });

  it("getFormatted omits label when not provided", () => {
    const buffer = createGroupHistoryBuffer(10);
    buffer.push("session-a", makeMsg({ senderId: "alice", text: "hi" }));

    const formatted = buffer.getFormatted("session-a");
    expect(formatted).toBeDefined();
    expect(formatted).toContain("[Recent group context (1 messages)]:");
    expect(formatted).not.toContain("Session");
  });

  it("getFormatted omits label when empty string", () => {
    const buffer = createGroupHistoryBuffer(10);
    buffer.push("session-a", makeMsg({ senderId: "alice", text: "hi" }));

    const formatted = buffer.getFormatted("session-a", "");
    expect(formatted).toBeDefined();
    expect(formatted).toContain("[Recent group context (1 messages)]:");
    expect(formatted).not.toContain("Session");
  });

  it("handles messages with no text", () => {
    const buffer = createGroupHistoryBuffer(10);
    // NormalizedMessage text is required by schema but can be empty string.
    // We simulate a case where text might be undefined-ish at runtime.
    const msg = makeMsg({ senderId: "alice" });
    // Force text to undefined to test defensive coding
    (msg as Record<string, unknown>).text = undefined;
    buffer.push("session-a", msg);

    const formatted = buffer.getFormatted("session-a")!;
    expect(formatted).toContain("[alice]: ");
    expect(formatted).toContain("[Recent group context (1 messages)]:");
  });
});
