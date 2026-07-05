// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A contract test for the Microsoft Teams capability descriptor + the
 * caps↔adapter reconciliation (the drift tripwire applied to the Teams channel).
 *
 * `msteams-caps.ts` carries the FLAT emulator `ChannelCaps`; the real production
 * adapter declares a NESTED `ChannelCapability` (channel-capability.ts:
 * `features{}`/`limits{}`/`replyToMetaKey`). This test is the DRIFT TRIPWIRE: it
 * imports the adapter's OWN declared capabilities from `@comis/channels` (via
 * `createMsTeamsPlugin(...).capabilities`, the exported surface that returns the
 * module-local `CAPABILITIES`) and asserts the overlapping fields reconcile
 * field-by-field. If the adapter ever flips a feature flag (esp. `buttons`) or
 * changes `maxMessageChars`, this test fails LOUDLY — the emulator's caps can
 * never silently drift from the real adapter.
 *
 * THE KEY TEAMS DIFFERENCES vs Telegram/Signal:
 *  - `features.reactions: true` is an INBOUND capability (Teams exposes no
 *    bot-reaction send API), so it reconciles to `inbound.reactions`, and
 *    `outbound.reactions` is `false`.
 *  - `features.buttons: "adaptivecard"` (a non-"none" flavour) → `outbound.buttons: true`.
 *  - `features.threads: true` (unlike Telegram/Signal's `false`).
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so this
 * reads the REAL built adapter declaration (run `pnpm build` first if stale).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/msteams/msteams-caps.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMsTeamsPlugin } from "@comis/channels";
import type { ChannelCapability } from "@comis/core";
import { createMockLogger } from "../../../support/mock-logger.js";
import { msteamsCaps, MSTEAMS_MAX_MESSAGE_CHARS } from "./msteams-caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPS_SOURCE = resolve(HERE, "msteams-caps.ts");

/**
 * The adapter's REAL declared capabilities (the reconciliation TARGET). Built via
 * the exported plugin factory — the Teams factory is lazy (it constructs the
 * adapter + token provider but opens no connection and mints no token until an
 * outbound send), so a bare construction safely reads the module-local
 * `CAPABILITIES` declaration.
 */
function adapterCapabilities(): ChannelCapability {
  const plugin = createMsTeamsPlugin({
    appId: "test-app-id",
    appPassword: "test-secret",
    tenantId: "00000000-0000-0000-0000-000000000001",
    allowFrom: [],
    allowMode: "open",
    logger: createMockLogger(),
  });
  return plugin.capabilities;
}

describe("msteams-caps — Microsoft Teams ChannelCaps descriptor", () => {
  it("is a flat ChannelCaps for msteams over http with the reconciled message limit", () => {
    expect(msteamsCaps.channel).toBe("msteams");
    expect(msteamsCaps.protocol).toBe("http");
    expect(msteamsCaps.inbound).toBeDefined();
    expect(msteamsCaps.outbound).toBeDefined();
    // The reconciled limit lives as a sibling const (the flat shape has no slot).
    expect(MSTEAMS_MAX_MESSAGE_CHARS).toBe(28000);
  });

  it("declares the Teams-specific surface: inbound reactions/buttons/threads, outbound cards + threads, no send-reaction", () => {
    // TEAMS: reactions are INBOUND (messageReaction activities); there is no
    // bot-reaction send API, so the outbound side is honestly false.
    expect(msteamsCaps.inbound.reactions).toBe(true);
    expect(msteamsCaps.outbound.reactions).toBe(false);
    // Adaptive Card button clicks are an inbound activity (invoke); the bot
    // renders Adaptive Card buttons outbound.
    expect(msteamsCaps.inbound.buttons).toBe(true);
    expect(msteamsCaps.outbound.buttons).toBe(true);
    // Teams supports threads (channel/group replyToId root) — unlike TG/Signal.
    expect(msteamsCaps.outbound.threads).toBe(true);
    // Edit/delete are supported outbound (Bot Framework update/deleteActivity).
    expect(msteamsCaps.outbound.edits).toBe(true);
    expect(msteamsCaps.outbound.deletes).toBe(true);
  });
});

describe("msteams-caps — caps↔adapter reconciliation (the drift tripwire)", () => {
  it("reconciles the emulator's flat flags against the adapter's nested features field-by-field", () => {
    const caps = adapterCapabilities();
    const f = caps.features;

    // TEAMS: features.reactions is the INBOUND capability (no send-reaction API).
    expect(msteamsCaps.inbound.reactions).toBe(f.reactions); // true
    expect(msteamsCaps.outbound.reactions).toBe(false); // no bot-reaction send API

    // emulator FLAT outbound  ⇄  adapter NESTED features
    expect(msteamsCaps.outbound.edits).toBe(f.editMessages); // true — updateActivity
    expect(msteamsCaps.outbound.deletes).toBe(f.deleteMessages); // true — deleteActivity
    expect(msteamsCaps.outbound.attachments).toBe(f.attachments); // true
    expect(msteamsCaps.outbound.typing).toBe(f.typing); // true
    expect(msteamsCaps.outbound.threads).toBe(f.threads); // true — replyToId thread root

    // emulator buttons:true ⇄ the adapter declares a non-"none" flavour
    // ("adaptivecard"). The Teams honest-support signal (vs Signal's "none").
    expect(f.buttons).toBe("adaptivecard");
    expect(msteamsCaps.outbound.buttons).toBe(f.buttons === "none" ? false : true);

    // The reconciled message-length limit.
    expect(MSTEAMS_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars); // 28000

    // The adapter declares NO inbound history-fetch surface (Connector has no read).
    expect(f.fetchHistory).toBe(false);
  });

  it("asserts the EXACT adapter values (a drift in any flips this test red)", () => {
    const caps = adapterCapabilities();
    expect(caps.features).toMatchObject({
      reactions: true,
      editMessages: true,
      deleteMessages: true,
      fetchHistory: false,
      attachments: true,
      typing: true,
      threads: true,
      buttons: "adaptivecard",
    });
    expect(caps.limits.maxMessageChars).toBe(28000);
    // The reply/edit/delete target metadata key the adapter self-declares.
    expect(caps.replyToMetaKey).toBe("teamsActivityId");
  });

  it("documents the not-reconciled-yet inbound-only fields (the adapter has no broader inbound caps surface)", () => {
    // These emulator-only inbound fields (beyond the reactions overlap) are NOT
    // asserted against the adapter (it declares no broader inbound capability
    // surface). The reconciliation scope is the overlap only — this test proves
    // they EXIST on the emulator caps, documented as not-reconciled-yet.
    expect(msteamsCaps.inbound).toHaveProperty("text");
    expect(msteamsCaps.inbound).toHaveProperty("media");
    expect(msteamsCaps.inbound).toHaveProperty("threads");
    // The source explicitly documents the not-reconciled-yet boundary.
    const src = readFileSync(CAPS_SOURCE, "utf8");
    expect(src).toMatch(/not-reconciled-yet/i);
  });
});
