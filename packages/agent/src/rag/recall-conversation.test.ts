// SPDX-License-Identifier: Apache-2.0
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
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
});
