// SPDX-License-Identifier: Apache-2.0
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE } from "@comis/core";
import { selectRecentUserTurns } from "./recall-conversation.js";

function message(role: string, content: unknown): AgentMessage {
  return { role, content } as AgentMessage;
}

describe("selectRecentUserTurns", () => {
  it("returns the two newest non-empty user turns and excludes generated output", () => {
    const turns = selectRecentUserTurns([
      message("user", "old user context"),
      message("assistant", [{ type: "text", text: "generated guess" }]),
      message("user", [{ type: "text", text: "current workspace alpha" }]),
      message("toolResult", [{ type: "text", text: "tool output" }]),
      message("user", [{ type: "text", text: "latest correction" }]),
    ]);

    expect(turns).toEqual(["current workspace alpha", "latest correction"]);
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
        batchId: "prior-batch",
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 100,
        messages: [{
          id: "prior-message",
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
        batchId: "current-batch",
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 200,
        messages: [{
          id: "current-message",
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
      "current-batch",
    );

    expect(turns).toEqual(["use exact-provider instead"]);
    expect(turns[0]).not.toContain("[System context]");
  });
});
