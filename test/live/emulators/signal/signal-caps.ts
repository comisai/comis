// SPDX-License-Identifier: Apache-2.0
/**
 * `signal-caps` — the Signal capability descriptor + the §3A.4 caps↔adapter
 * reconciliation seam (the channel-#2 mirror of the 204 Telegram `tg-caps.ts`),
 * Phase 209 / CHAN2-01.
 *
 * Two capability shapes exist in this codebase and they DIFFER:
 *
 *   - The emulator side (this file, design §3A.4) is a FLAT `ChannelCaps`:
 *     `{ channel, inbound{}, outbound{}, protocol }`.
 *   - The production adapter (signal-plugin.ts `CAPABILITIES`,
 *     core/channel-capability.ts) is NESTED `ChannelCapability`:
 *     `{ features{}, limits{}, replyToMetaKey }`.
 *
 * The §3A.4 decision (mirrored from the 204 A5 decision): `signal-caps.ts`
 * carries the flat descriptor AND the reconciliation map; the contract test
 * (`signal-caps.test.ts`) reads the adapter's REAL declared capabilities from
 * `@comis/channels` (via `createSignalPlugin(...).capabilities`) and asserts the
 * overlapping fields match — a drift tripwire so the emulator's caps can never
 * silently diverge from the adapter's self-declaration (threat T-209-07).
 *
 * THE KEY SIGNAL DIFFERENCE vs Telegram: the adapter declares
 * `features.buttons: "none"` (signal-plugin.ts:26), so `outbound.buttons` is
 * `false` — Signal has NO inline buttons. That is the honest-degrade trigger
 * 209-06 wires into `chan tap` (an unsupported-verb exit, never a silent no-op).
 * Signal DOES support reactions (`features.reactions: true`), so `chan react`
 * works unchanged — the WS1-relevant verb.
 *
 * The flat `ChannelCaps` shape has no slot for a message-length limit, so the
 * reconciled `maxMessageChars` is carried as the sibling const
 * {@link SIGNAL_MAX_MESSAGE_CHARS} (the FOUND-03-style reconciliation seam) and
 * the contract test asserts it against the adapter's `limits.maxMessageChars`.
 *
 * --- §3A.4 FIELD-BY-FIELD MAP (emulator FLAT ⇄ adapter NESTED) ---
 *   outbound.reactions     == features.reactions      (true)
 *   outbound.edits         == features.editMessages   (false — Signal can't edit)
 *   outbound.deletes       == features.deleteMessages (true)
 *   outbound.attachments   == features.attachments    (true)
 *   outbound.typing        == features.typing         (true)
 *   outbound.threads       == features.threads        (false)
 *   outbound.buttons:false ⇄ features.buttons === "none"  (THE honest-degrade trigger)
 *   SIGNAL_MAX_MESSAGE_CHARS == limits.maxMessageChars (65536)
 *   (inbound has no history claim) ⇄ features.fetchHistory (false)
 *
 * --- NOT-RECONCILED-YET (documented) ---
 * The emulator's inbound-only fields (`inbound.text` / `inbound.media` /
 * `inbound.reactions` / `inbound.edits` / `inbound.buttons` / `inbound.threads` /
 * `inbound.slashCommands` / `inbound.location`) have NO counterpart in the
 * adapter's capability surface (it declares no inbound caps). They are
 * deliberately NOT asserted against `CAPABILITIES` — the reconciliation scope is
 * the overlap only. When the adapter grows an inbound caps surface, extend the map.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change.
 *
 * @module
 */

import type { ChannelCaps } from "../../harness/channel-emulator.js";

/**
 * The reconciled Signal message-length limit (the §3A.4 seam).
 *
 * The flat `ChannelCaps` shape carries no `maxMessageChars` field, so the
 * reconciled value lives here as a sibling const. The contract test asserts it
 * equals the adapter's `limits.maxMessageChars` (signal-plugin.ts:29), so a
 * drift in the adapter's limit flips the test red.
 */
export const SIGNAL_MAX_MESSAGE_CHARS = 65536;

/**
 * The Signal emulator capability descriptor (the flat design-side shape).
 *
 * `outbound.*` mirrors the adapter's `features.*` (the reconciled overlap — see
 * the field map above). `inbound.*` describes the emulator's inbound surface,
 * which is not-reconciled-yet (the adapter declares no inbound caps). `buttons`
 * is `false` because the adapter declares the `"none"` flavour — Signal has no
 * inline buttons, the honest-degrade trigger for `chan tap`. `reactions` is
 * `true` (the WS1-relevant verb Signal supports).
 */
export const signalCaps: ChannelCaps = {
  channel: "signal",
  protocol: "http",
  inbound: {
    // NOT-RECONCILED-YET — the adapter declares no inbound caps surface.
    // Signal carries inbound text, media attachments, and reactions
    // (message-mapper.ts maps dataMessage.message / .attachments / .reaction);
    // it has no inline buttons, no edits, no threads, no slash-commands, no
    // location messages — represented as false (honest, not omitted).
    text: true,
    media: ["voice", "document", "video"],
    reactions: true,
    edits: false,
    buttons: false,
    threads: false,
    slashCommands: false,
    location: false,
  },
  outbound: {
    // RECONCILED field-by-field against the adapter's `features` (see the map).
    reactions: true, // == features.reactions
    edits: false, // == features.editMessages (honest: Signal can't edit — DeleteAndRepost)
    deletes: true, // == features.deleteMessages
    buttons: false, // ⇄ features.buttons === "none" — THE honest-degrade trigger
    attachments: true, // == features.attachments
    typing: true, // == features.typing
    threads: false, // == features.threads (honest degradation: unsupported → false)
    richCards: false, // Signal has no rich-card surface (adapter declares none).
  },
};
