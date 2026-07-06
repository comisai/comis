// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A contract test for the Google Chat capability descriptor + the
 * caps↔adapter reconciliation (the drift tripwire applied to the Google Chat
 * channel).
 *
 * `googlechat-caps.ts` carries the FLAT emulator `ChannelCaps`; the real
 * production adapter declares a NESTED `ChannelCapability` (channel-capability.ts:
 * `features{}`/`limits{}`/`replyToMetaKey`). This test is the DRIFT TRIPWIRE: it
 * imports the adapter's OWN declared capabilities from `@comis/channels` (via
 * `createGoogleChatPlugin(...).capabilities`, the exported surface that returns
 * the module-local `CAPABILITIES`) and asserts the overlapping fields reconcile
 * field-by-field. If the adapter ever flips a feature flag or changes
 * `maxMessageChars`, this test fails LOUDLY — the emulator's caps can never
 * silently drift from the real adapter.
 *
 * THE KEY GOOGLE CHAT DIFFERENCES vs Teams:
 *  - `features.reactions: false` — a service-account app reaches no reaction
 *    surface at all (neither inbound nor outbound), so BOTH `inbound.reactions`
 *    and `outbound.reactions` are `false` (unlike Teams, where reactions are an
 *    inbound capability).
 *  - `features.buttons: "cardsv2"` (a non-"none" flavour) → `outbound.buttons: true`,
 *    and a Cards v2 click is an INBOUND event (`inbound.buttons: true`).
 *  - `features.attachments: false` / `features.typing: false` — outbound upload
 *    and typing indicators are app-auth-unreachable.
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so this
 * reads the REAL built adapter declaration (run `pnpm build` first if stale).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/googlechat/googlechat-caps.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createGoogleChatPlugin } from "@comis/channels";
import type { ChannelCapability } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import { googlechatCaps, GOOGLECHAT_MAX_MESSAGE_CHARS } from "./googlechat-caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPS_SOURCE = resolve(HERE, "googlechat-caps.ts");

/**
 * The adapter's REAL declared capabilities (the reconciliation TARGET). Built via
 * the exported plugin factory — the Google Chat factory is lazy (it constructs
 * the adapter + token provider but opens no pull loop and mints no token until an
 * outbound send), so a bare construction safely reads the module-local
 * `CAPABILITIES` declaration.
 */
function adapterCapabilities(): ChannelCapability {
  const plugin = createGoogleChatPlugin({
    serviceAccountKey: "{}",
    subscriptionName: "projects/test-project/subscriptions/comis-inbound",
    allowFrom: [],
    allowMode: "open",
    logger: createMockLogger(),
  });
  return plugin.capabilities;
}

describe("googlechat-caps — Google Chat ChannelCaps descriptor", () => {
  it("is a flat ChannelCaps for googlechat over http with the reconciled message limit", () => {
    expect(googlechatCaps.channel).toBe("googlechat");
    expect(googlechatCaps.protocol).toBe("http");
    expect(googlechatCaps.inbound).toBeDefined();
    expect(googlechatCaps.outbound).toBeDefined();
    // The reconciled limit lives as a sibling const (the flat shape has no slot).
    expect(GOOGLECHAT_MAX_MESSAGE_CHARS).toBe(4000);
  });

  it("declares the Google Chat surface: Cards v2 buttons in+out, threads, edit/delete, NO reactions either way", () => {
    // GOOGLE CHAT: a service-account app has no reaction surface — both the
    // inbound and the outbound reaction flags are honestly false (unlike Teams,
    // where reactions are an inbound capability).
    expect(googlechatCaps.inbound.reactions).toBe(false);
    expect(googlechatCaps.outbound.reactions).toBe(false);
    // Cards v2 button clicks are an inbound event (CARD_CLICKED); the bot renders
    // Cards v2 interactive buttons outbound.
    expect(googlechatCaps.inbound.buttons).toBe(true);
    expect(googlechatCaps.outbound.buttons).toBe(true);
    // Threaded replies route through the send path — supported both ways.
    expect(googlechatCaps.inbound.threads).toBe(true);
    expect(googlechatCaps.outbound.threads).toBe(true);
    // Edit/delete are supported outbound (a text-masked patch / a self-delete).
    expect(googlechatCaps.outbound.edits).toBe(true);
    expect(googlechatCaps.outbound.deletes).toBe(true);
    // Outbound upload + typing are app-auth-unreachable — honestly false.
    expect(googlechatCaps.outbound.attachments).toBe(false);
    expect(googlechatCaps.outbound.typing).toBe(false);
  });
});

describe("googlechat-caps — caps↔adapter reconciliation (the drift tripwire)", () => {
  it("reconciles the emulator's flat flags against the adapter's nested features field-by-field", () => {
    const caps = adapterCapabilities();
    const f = caps.features;

    // GOOGLE CHAT: features.reactions is false (no reaction surface at all).
    expect(googlechatCaps.outbound.reactions).toBe(f.reactions); // false
    expect(googlechatCaps.inbound.reactions).toBe(false); // no inbound reaction path

    // emulator FLAT outbound  ⇄  adapter NESTED features
    expect(googlechatCaps.outbound.edits).toBe(f.editMessages); // true — text-masked patch
    expect(googlechatCaps.outbound.deletes).toBe(f.deleteMessages); // true — self-delete
    expect(googlechatCaps.outbound.attachments).toBe(f.attachments); // false — no upload
    expect(googlechatCaps.outbound.typing).toBe(f.typing); // false — no typing API
    expect(googlechatCaps.outbound.threads).toBe(f.threads); // true — threaded replies

    // emulator buttons:true ⇄ the adapter declares a non-"none" flavour
    // ("cardsv2"). The Google Chat honest-support signal.
    expect(f.buttons).toBe("cardsv2");
    expect(googlechatCaps.outbound.buttons).toBe(f.buttons === "none" ? false : true);

    // The reconciled message-length limit.
    expect(GOOGLECHAT_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars); // 4000

    // The adapter declares NO inbound history-fetch surface (admin-approval-gated).
    expect(f.fetchHistory).toBe(false);
  });

  it("asserts the EXACT adapter values (a drift in any flips this test red)", () => {
    const caps = adapterCapabilities();
    expect(caps.features).toMatchObject({
      reactions: false,
      editMessages: true,
      deleteMessages: true,
      fetchHistory: false,
      attachments: false,
      typing: false,
      threads: true,
      buttons: "cardsv2",
    });
    expect(caps.limits.maxMessageChars).toBe(4000);
    // The reply/edit/delete target metadata key the adapter self-declares.
    expect(caps.replyToMetaKey).toBe("googlechatMessageName");
  });

  it("documents the not-reconciled-yet inbound-only fields (the adapter has no broader inbound caps surface)", () => {
    // These emulator-only inbound fields (beyond the button/thread overlap) are
    // NOT asserted against the adapter (it declares no broader inbound capability
    // surface). The reconciliation scope is the overlap only — this test proves
    // they EXIST on the emulator caps, documented as not-reconciled-yet.
    expect(googlechatCaps.inbound).toHaveProperty("text");
    expect(googlechatCaps.inbound).toHaveProperty("media");
    expect(googlechatCaps.inbound).toHaveProperty("threads");
    // The source explicitly documents the not-reconciled-yet boundary.
    const src = readFileSync(CAPS_SOURCE, "utf8");
    expect(src).toMatch(/not-reconciled-yet/i);
  });
});
