// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { toCreateGroupChatOptions } from "../../test/live/bin/vps-emu-group-options.js";

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
});
