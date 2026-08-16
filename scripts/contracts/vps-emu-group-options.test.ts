// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  reserveStandaloneMessageIdBase,
  toCreateGroupChatOptions,
} from "../../test/live/bin/vps-emu-group-options.js";

describe("standalone emulator group provisioning", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function reservationDirectory(): string {
    const root = mkdtempSync(resolve(tmpdir(), "comis-emu-contract-"));
    directories.push(root);
    return resolve(root, "reservations");
  }

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
    const directory = reservationDirectory();

    expect(reserveStandaloneMessageIdBase(undefined, directory, 4_000_000_000))
      .toBe(4_000_000_000);
    expect(reserveStandaloneMessageIdBase({}, directory, 4_000_000_000))
      .toBe(4_001_000_000);
    expect(reserveStandaloneMessageIdBase(
      { messageIdBase: 2_000_000_000 },
      directory,
      1_000_000_000,
    )).toBe(4_002_000_000);
  });
});
