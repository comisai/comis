// SPDX-License-Identifier: Apache-2.0
/**
 * `assertValidGroupSpec` — the loud-failure gate for `EMU_GROUPS`.
 *
 * Live incident: two silent-acceptance shapes made every mention-gated group arc undrivable while
 * the emulator launch banner still looked healthy. (1) `{id: -100…}` instead of `{chatId: -100…}`
 * left chatId undefined and the emulator minted its own id, so the driver addressed a chat the
 * plan never referenced. (2) A `botId`/`botUsername` inconsistent with the emulator's own identity
 * made the group's bot member a different bot than the daemon authenticates as, so
 * `isBotMentioned` was permanently false. Both must throw, naming the expected shape.
 */
import { describe, it, expect } from "vitest";
import {
  assertValidGroupSpec,
  EMULATOR_BOT_ID,
  EMULATOR_BOT_USERNAME,
} from "./vps-emu-group-options.js";

const members = [{ id: 678314278, firstName: "U1", username: "u1" }];

describe("assertValidGroupSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(() =>
      assertValidGroupSpec({ chatId: -1001234567890, members, supergroup: true, forum: true }),
    ).not.toThrow();
  });

  it("rejects `id` in place of `chatId` and names the correct key", () => {
    expect(() => assertValidGroupSpec({ id: -1001234567890, members })).toThrowError(/chatId/);
  });

  it("rejects a missing chatId rather than letting the emulator mint one", () => {
    expect(() => assertValidGroupSpec({ members })).toThrowError(/chatId is required/);
  });

  it("rejects a botId that is not the emulator's bot id", () => {
    expect(() =>
      assertValidGroupSpec({ chatId: -1001234567890, members, botId: 1234567 }),
    ).toThrowError(new RegExp(String(EMULATOR_BOT_ID)));
  });

  it("rejects a botUsername that is not the emulator's handle", () => {
    expect(() =>
      assertValidGroupSpec({ chatId: -1001234567890, members, botUsername: "comis_test_bot" }),
    ).toThrowError(new RegExp(EMULATOR_BOT_USERNAME));
  });

  it("rejects empty members", () => {
    expect(() => assertValidGroupSpec({ chatId: -1001234567890, members: [] })).toThrowError(
      /members/,
    );
  });
});
