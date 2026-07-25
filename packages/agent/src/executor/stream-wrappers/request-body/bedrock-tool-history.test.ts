// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { stripBedrockToolHistory } from "./bedrock-tool-history.js";

describe("stripBedrockToolHistory", () => {
  it("removes provider tool blocks and restores alternating semantic messages", () => {
    const input = [
      { role: "user", content: [{ text: "before" }, { toolResult: { toolUseId: "tool-a" } }] },
      { role: "user", content: [{ cachePoint: { type: "default" } }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "tool-b" } }] },
      { role: "user", content: [{ text: "after" }] },
      { role: "assistant", content: [{ text: "done" }] },
      { role: "assistant", content: [{ text: "continued" }] },
    ];

    expect(stripBedrockToolHistory(input)).toEqual({
      messages: [
        { role: "user", content: [{ text: "before" }, { text: "after" }] },
        { role: "assistant", content: [{ text: "done" }, { text: "continued" }] },
      ],
      toolBlocksStripped: 2,
      messagesDropped: 2,
      messagesMerged: 2,
    });
  });

  it("preserves messages with non-array provider content", () => {
    const message = { role: "user", content: "plain-provider-content" };
    expect(stripBedrockToolHistory([message])).toEqual({
      messages: [message],
      toolBlocksStripped: 0,
      messagesDropped: 0,
      messagesMerged: 0,
    });
  });
});
