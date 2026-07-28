// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  findAssistantReplyAfterInbound,
  telegramInboundGuid,
  wireContainsAssistantReply,
} from "../../test/live/self-driving/scripts/drive-session-oracle.mjs";

const ownInboundId = "f8cd362e-d29e-5887-836b-df7b3ea26ffa";

function sessionRecord(value: unknown): string {
  return JSON.stringify(value);
}

describe("live driver session correlation", () => {
  it("derives the normalized Telegram identity returned by the channel mapper", () => {
    expect(telegramInboundGuid(12345, -1_001_234_567_890, 134)).toBe(ownInboundId);
  });

  it("ignores another concurrent reply before the requested inbound turn", () => {
    const source = [
      sessionRecord({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer for the other sender" }],
        },
      }),
      sessionRecord({
        type: "message",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: `[System context]\n{"message_id":"${ownInboundId}"}\n\nPick a place nearby`,
          }],
        },
      }),
      sessionRecord({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "reasoning" }],
        },
      }),
      sessionRecord({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Nearby to which city?" }],
        },
      }),
    ].join("\n");

    expect(findAssistantReplyAfterInbound(source, ownInboundId)).toBe("Nearby to which city?");
  });

  it("does not accept an unrelated group wire reply as this drive's answer", () => {
    const outbound = [
      { method: "sendMessage", text: "Answer for the other sender" },
    ];

    expect(wireContainsAssistantReply(outbound, "Nearby to which city?")).toBe(false);
    expect(
      wireContainsAssistantReply(
        [...outbound, { method: "sendMessage", text: "Nearby to which city?" }],
        "Nearby to which city?",
      ),
    ).toBe(true);
  });

  it("correlates Markdown session text with Telegram rendered HTML", () => {
    expect(
      wireContainsAssistantReply(
        [{
          method: "sendMessage",
          text: "Got it—category: <b>groceries</b>. Please resend it.",
        }],
        "Got it—category: **groceries**. Please resend it.",
      ),
    ).toBe(true);
  });
});
