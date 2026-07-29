// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  nextStandaloneMessageIdBase,
  toCreateGroupChatOptions,
} from "../../test/live/bin/vps-emu-group-options.js";

describe("standalone emulator group provisioning", () => {
  it("preserves forum and supergroup flags required by topic scenarios", () => {
    const options = toCreateGroupChatOptions({
      chatId: -1_001_234_567_890,
      members: [{ id: 678_314_278, firstName: "owner", username: "owner" }],
      botId: 12_345,
      botUsername: "test_bot",
      supergroup: true,
      forum: true,
    });

    expect(options).toEqual({
      chatId: -1_001_234_567_890,
      members: [{ id: 678_314_278, firstName: "owner", username: "owner" }],
      bot: { id: 12_345, firstName: "bot", username: "test_bot" },
      supergroup: true,
      forum: true,
    });
  });

  it("reserves a new message-id block across standalone restarts", () => {
    expect(nextStandaloneMessageIdBase(undefined)).toBe(100);
    expect(nextStandaloneMessageIdBase({})).toBe(1_000_100);
    expect(nextStandaloneMessageIdBase({ messageIdBase: 1_000_100 })).toBe(2_000_100);
  });
});
