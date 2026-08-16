// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextStandaloneMessageIdBase,
  toCreateGroupChatOptions,
} from "../../test/live/bin/vps-emu-group-options.js";

describe("standalone emulator group provisioning", () => {
  afterEach(() => vi.restoreAllMocks());

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
    vi.spyOn(Date, "now").mockReturnValue(1_786_863_916_000);

    expect(nextStandaloneMessageIdBase(undefined)).toBe(1_786_863_916);
    expect(nextStandaloneMessageIdBase({})).toBe(1_786_863_916);
    expect(nextStandaloneMessageIdBase({ messageIdBase: 2_000_000_000 })).toBe(2_001_000_000);
  });
});
