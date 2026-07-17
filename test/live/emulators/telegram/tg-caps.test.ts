// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A contract test for the Telegram capability descriptor + the
 * caps↔adapter reconciliation.
 *
 * `tg-caps.ts` carries the FLAT emulator `ChannelCaps`; the real
 * production adapter declares a NESTED `ChannelCapability`
 * (channel-capability.ts: `features{}`/`limits{}`/`replyToMetaKey`). This test
 * is the DRIFT TRIPWIRE: it imports the adapter's OWN declared capabilities
 * from `@comis/channels` (via `createTelegramPlugin(...).capabilities`, the
 * exported surface that returns the module-local `CAPABILITIES`) and asserts the
 * overlapping fields reconcile field-by-field. If the adapter ever changes
 * `maxMessageChars` or a feature flag, this test fails LOUDLY — the emulator's
 * caps can never silently drift from the real adapter.
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so this
 * reads the REAL built adapter declaration (run `pnpm build` first if stale).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/telegram/tg-caps.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTelegramPlugin } from "@comis/channels";
import type { ChannelCapability } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import { tgCaps, TG_MAX_MESSAGE_CHARS } from "./tg-caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPS_SOURCE = resolve(HERE, "tg-caps.ts");

/**
 * The adapter's REAL declared capabilities (the reconciliation TARGET). Built
 * via the exported plugin factory — no network until `.start()`, so a bare
 * construction is safe and reads the module-local `CAPABILITIES`.
 */
function adapterCapabilities(): ChannelCapability {
  // The factory only constructs the grammy Bot lazily — no network is touched
  // until activate()/start(), so a bare construction safely reads the
  // module-local `CAPABILITIES` declaration (the reconciliation TARGET).
  const plugin = createTelegramPlugin({
    getBotToken: () => "12345:test",
    logger: createMockLogger(),
  });
  return plugin.capabilities;
}

describe("tg-caps — Telegram ChannelCaps descriptor", () => {
  it("is a flat ChannelCaps for telegram over http with the reconciled message limit", () => {
    expect(tgCaps.channel).toBe("telegram");
    expect(tgCaps.protocol).toBe("http");
    expect(tgCaps.inbound).toBeDefined();
    expect(tgCaps.outbound).toBeDefined();
    // The reconciled limit lives as a sibling const (the flat shape has no slot).
    expect(TG_MAX_MESSAGE_CHARS).toBe(4096);
  });

  it("honest degradation: an unsupported verb (threads) is represented as false, not omitted", () => {
    expect(tgCaps.outbound.threads).toBe(false);
  });
});

describe("tg-caps — caps↔adapter reconciliation (the drift tripwire)", () => {
  it("reconciles the emulator's flat outbound flags against the adapter's nested features field-by-field", () => {
    const caps = adapterCapabilities();
    const f = caps.features;

    // emulator FLAT outbound  ⇄  adapter NESTED features
    expect(tgCaps.outbound.reactions).toBe(f.reactions); // true
    expect(tgCaps.outbound.edits).toBe(f.editMessages); // true
    expect(tgCaps.outbound.deletes).toBe(f.deleteMessages); // true
    expect(tgCaps.outbound.attachments).toBe(f.attachments); // true
    expect(tgCaps.outbound.typing).toBe(f.typing); // true
    expect(tgCaps.outbound.threads).toBe(f.threads); // false

    // emulator buttons:true means the adapter declares a non-"none" flavour.
    expect(f.buttons).toBe("inline");
    expect(tgCaps.outbound.buttons).toBe(true);

    // The reconciled message-length limit.
    expect(TG_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars); // 4096

    // The adapter declares NO inbound history-fetch surface.
    expect(f.fetchHistory).toBe(false);
  });

  it("asserts the EXACT adapter values (a drift in any flips this test red)", () => {
    const f = adapterCapabilities().features;
    expect(f).toMatchObject({
      reactions: true,
      editMessages: true,
      deleteMessages: true,
      fetchHistory: false,
      attachments: true,
      typing: true,
      threads: false,
      buttons: "inline",
    });
    expect(adapterCapabilities().limits.maxMessageChars).toBe(4096);
  });

  it("documents the not-reconciled-yet inbound-only fields (the adapter has no inbound caps surface)", () => {
    // These emulator-only inbound fields are NOT asserted against the adapter
    // (it declares no inbound capability surface). The reconciliation scope is
    // the overlap only — this test just proves they EXIST on the emulator caps,
    // documented as not-reconciled-yet (see the source comment).
    expect(tgCaps.inbound).toHaveProperty("text");
    expect(tgCaps.inbound).toHaveProperty("media");
    expect(tgCaps.inbound).toHaveProperty("slashCommands");
    expect(tgCaps.inbound).toHaveProperty("location");
    // The source explicitly documents the not-reconciled-yet boundary.
    const src = readFileSync(CAPS_SOURCE, "utf8");
    expect(src).toMatch(/not-reconciled-yet/i);
  });
});
