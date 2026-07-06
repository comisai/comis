// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { decodeMatrixAction } from "../matrix-actions.js";

describe("decodeMatrixAction", () => {
  it("decodes sendTyping to a typing-on descriptor keyed on chatId", () => {
    expect(decodeMatrixAction("sendTyping", { chatId: "!r:hs" })).toEqual({
      kind: "sendTyping",
      roomId: "!r:hs",
      typing: true,
    });
  });

  it("suppresses typing during streaming (the streamed text is itself the activity)", () => {
    expect(decodeMatrixAction("sendTyping", { chatId: "!r:hs", streaming: true })).toEqual({
      kind: "sendTyping",
      roomId: "!r:hs",
      typing: false,
    });
  });

  it("decodes stopTyping to a typing-off descriptor", () => {
    expect(decodeMatrixAction("stopTyping", { chatId: "!r:hs" })).toEqual({
      kind: "sendTyping",
      roomId: "!r:hs",
      typing: false,
    });
  });

  it("resolves the room id from roomId or channelId as well as chatId", () => {
    expect(decodeMatrixAction("join", { roomId: "!a:hs" })).toEqual({ kind: "join", roomId: "!a:hs" });
    expect(decodeMatrixAction("leave", { channelId: "!b:hs" })).toEqual({
      kind: "leave",
      roomId: "!b:hs",
    });
  });

  it("decodes setTopic with an optional htmlTopic", () => {
    expect(decodeMatrixAction("setTopic", { chatId: "!r:hs", topic: "hello" })).toEqual({
      kind: "setTopic",
      roomId: "!r:hs",
      topic: "hello",
      htmlTopic: undefined,
    });
    expect(
      decodeMatrixAction("setTopic", { chatId: "!r:hs", topic: "hi", htmlTopic: "<b>hi</b>" }),
    ).toEqual({ kind: "setTopic", roomId: "!r:hs", topic: "hi", htmlTopic: "<b>hi</b>" });
  });

  it("decodes markRead with the target event id", () => {
    expect(decodeMatrixAction("markRead", { chatId: "!r:hs", eventId: "$e:hs" })).toEqual({
      kind: "markRead",
      roomId: "!r:hs",
      eventId: "$e:hs",
    });
  });

  it("rejects a known action missing its room id as unsupported", () => {
    expect(decodeMatrixAction("sendTyping", {}).kind).toBe("unsupported");
    expect(decodeMatrixAction("join", {}).kind).toBe("unsupported");
  });

  it("rejects setTopic with no topic and markRead with no event id", () => {
    expect(decodeMatrixAction("setTopic", { chatId: "!r:hs" }).kind).toBe("unsupported");
    expect(decodeMatrixAction("markRead", { chatId: "!r:hs" }).kind).toBe("unsupported");
  });

  it("rejects an unknown action as unsupported carrying its name", () => {
    expect(decodeMatrixAction("pin", {})).toEqual({
      kind: "unsupported",
      action: "pin",
      reason: expect.any(String),
    });
  });
});
