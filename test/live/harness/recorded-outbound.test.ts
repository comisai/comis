// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the LIFTED channel-agnostic `RecordedOutbound` subset
 * (CHAN2-02).
 *
 * The foundation-design bug this proves fixed: the channel-agnostic outbound
 * oracle subset (`{ method, messageId, text? }` — the bit the dual oracle +
 * the generic `control-api` actually consume) was anchored INSIDE the Telegram
 * emulator (`emulators/telegram/tg-emulator.ts`), so the "generic" control plane
 * had a type edge on a specific channel. A second channel (Signal)
 * could not feed `assertChannelTrace` / `control-api` without depending on the
 * Telegram emulator. This module lifts the agnostic subset UP to `harness/` so
 * BOTH channels share a channel-neutral type.
 *
 * Pure type/structural tests — no daemon, no key, no network, fast. They assert:
 *   - the lifted `RecordedOutbound` is the channel-agnostic subset
 *     (`{ method: string; messageId: number; text?: string }`) the oracle reads.
 *   - Telegram's FULL `RecordedOutbound` (a superset with `raw`/`parseMode`/…)
 *     is assignable to the lifted subset — so the Telegram emulator + its tests
 *     stay green (it is a SUPERSET of the lifted type, not a divergent shape).
 *   - a hand-built SECOND-channel-shaped record (`{ method, messageId, text }`)
 *     also satisfies the subset — channel-agnosticism with NO telegram edge.
 *   - the module is channel-agnostic — `recorded-outbound.ts` imports neither
 *     grammy nor any `@comis/*` channel package (the lift must not re-import the
 *     telegram dependency it is removing).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`,
 * collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/harness/recorded-outbound.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { RecordedOutbound } from "./recorded-outbound.js";
// The Telegram emulator's FULL record — must remain a SUPERSET of the lifted subset.
import type { RecordedOutbound as TgRecordedOutbound } from "../emulators/telegram/tg-emulator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE = resolve(HERE, "recorded-outbound.ts");

// ---------------------------------------------------------------------------
// The lifted channel-agnostic subset — the type IS the contract.
// ---------------------------------------------------------------------------

describe("lifted channel-agnostic RecordedOutbound subset", () => {
  it("constructs a minimal channel-neutral outbound record { method, messageId } and reads text?", () => {
    const minimal: RecordedOutbound = { method: "send", messageId: 1 };
    expect(minimal.method).toBe("send");
    expect(minimal.messageId).toBe(1);
    // `text` is optional — absent on the minimal record.
    expect(minimal.text).toBeUndefined();

    const withText: RecordedOutbound = { method: "send", messageId: 2, text: "hi" };
    expect(withText.text).toBe("hi");
  });

  it("keys the reply-wait watermark on messageId (the field control-api reads structurally)", () => {
    // The control-api reply-wait filters `o.messageId > afterMessageId`, so the
    // lifted subset MUST expose a numeric `messageId` any channel records.
    const records: RecordedOutbound[] = [
      { method: "send", messageId: 10, text: "first" },
      { method: "send", messageId: 11, text: "second" },
    ];
    const newer = records.filter((o) => o.messageId > 10);
    expect(newer).toHaveLength(1);
    expect(newer[0]?.text).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Telegram's full record is a SUPERSET of the lifted subset (assignability).
// ---------------------------------------------------------------------------

describe("Telegram RecordedOutbound is a superset of the lifted subset", () => {
  it("assigns a full Telegram record (with raw/parseMode/reactions) to the lifted subset", () => {
    // A representative FULL telegram record — exactly the shape sendMessage/
    // setMessageReaction build in tg-emulator.ts (method + messageId + raw +
    // the telegram-specific extras).
    const tg: TgRecordedOutbound = {
      method: "sendMessage",
      messageId: 42,
      text: "hello",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [] },
      reactions: ["👍"],
      raw: { chat_id: 1, text: "hello" },
    };
    // The assignment itself is the proof: a superset value flows into the subset
    // type with NO cast. If the lift diverged from a subset, this line fails tsc.
    const lifted: RecordedOutbound = tg;
    expect(lifted.method).toBe("sendMessage");
    expect(lifted.messageId).toBe(42);
    expect(lifted.text).toBe("hello");
  });

  it("treats an array of full Telegram records as an array of the lifted subset", () => {
    const tgRecords: TgRecordedOutbound[] = [
      { method: "sendMessage", messageId: 1, text: "a", raw: {} },
      { method: "setMessageReaction", messageId: 2, reactions: ["❤️"], raw: {} },
    ];
    // readonly RecordedOutbound[] is exactly the type control-api's
    // ControlEmulator.outbound() / waitForOutbound() surface.
    const lifted: readonly RecordedOutbound[] = tgRecords;
    expect(lifted).toHaveLength(2);
    expect(lifted[1]?.method).toBe("setMessageReaction");
  });
});

// ---------------------------------------------------------------------------
// A non-telegram record satisfies the subset (channel-agnosticism proof).
// ---------------------------------------------------------------------------

describe("a non-telegram outbound record satisfies the lifted subset", () => {
  it("accepts a hand-built second-channel-shaped record with no telegram dependency", () => {
    // The shape a Signal emulator records on `POST /api/v1/rpc` method `send`:
    // { method: "send", messageId: <timestamp>, text } — NO grammy, NO telegram.
    const signalShaped = { method: "send", messageId: 123, text: "hi" } satisfies RecordedOutbound;
    expect(signalShaped.method).toBe("send");
    expect(signalShaped.messageId).toBe(123);
    expect(signalShaped.text).toBe("hi");
  });

  it("accepts a minimal second-channel record without text (e.g. a reaction-only outbound)", () => {
    // Annotated as the subset (not `satisfies`, which would narrow away the
    // optional `text` key) so the optional-field access is the type under test.
    const reactionOnly: RecordedOutbound = { method: "react", messageId: 999 };
    expect(reactionOnly.method).toBe("react");
    expect(reactionOnly.text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Channel-agnostic — the lift must not re-import the telegram dependency.
// ---------------------------------------------------------------------------

describe("the lifted module is channel-agnostic", () => {
  it("recorded-outbound.ts imports neither grammy nor an @comis channel package nor the telegram emulator", () => {
    const src = readFileSync(MODULE_SOURCE, "utf8");
    // Strip comment lines so a doc-comment mentioning grammy/telegram is not a false LEAK.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/from\s+["']grammy/);
    expect(code).not.toMatch(/from\s+["']@comis\/channels/);
    expect(code).not.toMatch(/from\s+["'][^"']*emulators\/telegram/);
  });
});
