// SPDX-License-Identifier: Apache-2.0
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE } from "@comis/core";
import {
  RECENT_USER_TURN_COUNT,
  describeRecentUserTurnSelection,
  selectRecentUserTurns,
} from "./recall-conversation.js";

function message(role: string, content: unknown): AgentMessage {
  return { role, content } as AgentMessage;
}

describe("selectRecentUserTurns", () => {
  it("returns three recent user turns so a fourth-turn follow-up keeps its referent", () => {
    const turns = selectRecentUserTurns([
      message("user", "old user context"),
      message("assistant", [{ type: "text", text: "generated guess" }]),
      message("user", [{ type: "text", text: "current workspace alpha" }]),
      message("toolResult", [{ type: "text", text: "tool output" }]),
      message("user", [{ type: "text", text: "latest correction" }]),
    ]);

    expect(turns).toEqual([
      "old user context",
      "current workspace alpha",
      "latest correction",
    ]);
  });

  it("keeps an earlier referent after duplicate failed follow-up attempts", () => {
    const turns = selectRecentUserTurns([
      message("user", "check my synthetic account"),
      message("user", "here is the credential"),
      message("user", "connect to it"),
      message("user", "now actually use it"),
      message("user", "now actually use it"),
    ]);

    expect(turns).toEqual([
      "check my synthetic account",
      "here is the credential",
      "connect to it",
      "now actually use it",
    ]);
  });

  it("keeps the original referent when exact retries exceed the turn bound", () => {
    const turns = selectRecentUserTurns([
      message("user", "check my synthetic account"),
      message("user", "here is the credential"),
      ...Array.from({ length: 9 }, () => message("user", "connect a second one")),
    ]);

    expect(turns).toEqual([
      "check my synthetic account",
      "here is the credential",
      "connect a second one",
    ]);
    expect(describeRecentUserTurnSelection(turns)).toEqual({
      turnCount: 3,
      charCount: turns.join("\n").length,
      saturated: false,
    });
  });

  it("retains the session intent anchor when distinct follow-ups fill the bound", () => {
    const turns = selectRecentUserTurns([
      message("user", "check my synthetic account"),
      message("user", "here is the credential"),
      message("user", "connect to it"),
      message("user", "now use it"),
      message("user", "why not"),
      message("user", "connect another one"),
      message("user", "compare both"),
      message("user", "connect the first one"),
      message("user", "retry the first one"),
      message("user", "retry with the approved map"),
      message("user", "connect only the second one"),
    ]);

    expect(turns).toHaveLength(RECENT_USER_TURN_COUNT);
    expect(turns[0]).toBe("check my synthetic account");
    expect(turns.slice(1)).toEqual([
      "why not",
      "connect another one",
      "compare both",
      "connect the first one",
      "retry the first one",
      "retry with the approved map",
      "connect only the second one",
    ]);
  });

  it("ignores empty user content while joining multiple text blocks", () => {
    const turns = selectRecentUserTurns([
      message("user", "   "),
      message("user", [
        { type: "text", text: "first fragment" },
        { type: "image", data: "ignored" },
        { type: "text", text: "second fragment" },
      ]),
    ]);

    expect(turns).toEqual(["first fragment second fragment"]);
  });

  it("uses structured inbound provenance instead of prompt-enriched session text", () => {
    const enriched = [
      message(
        "user",
        "[Relevant context from memory: stale claim]\n"
          + "[System context]\ninternal runtime prose\n[End system context]\n\n"
          + "[telegram] user_a:\nuse obsolete-provider instead",
      ),
    ];
    const prior = {
      type: "custom",
      customType: INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
      data: {
        schemaVersion: 1,
        batchId: "0f0d0f4a-02ff-4cd7-87e4-615723598b59",
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 100,
        messages: [{
          id: "f7097f69-1c86-4f7c-9bbe-fb14bb88ee14",
          channelId: "channel_a",
          channelType: "telegram",
          senderId: "user_a",
          text: "use exact-provider instead",
          timestamp: 90,
        }],
      },
    };
    const current = {
      type: "custom",
      customType: INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
      data: {
        schemaVersion: 1,
        batchId: "ac149996-ea60-4c4e-8189-15ea8a36c34e",
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 200,
        messages: [{
          id: "1366bb29-bd14-4a2b-a204-f7da377b344e",
          channelId: "channel_a",
          channelType: "telegram",
          senderId: "user_a",
          text: "what model is active now",
          timestamp: 190,
        }],
      },
    };

    const turns = selectRecentUserTurns(
      enriched,
      [prior, prior, current],
      "ac149996-ea60-4c4e-8189-15ea8a36c34e",
    );

    expect(turns).toEqual(["use exact-provider instead"]);
    expect(turns[0]).not.toContain("[System context]");
  });
});
