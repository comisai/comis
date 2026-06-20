// SPDX-License-Identifier: Apache-2.0
/**
 * `tg-caps` — the Telegram capability descriptor + the FOUND-03 caps↔adapter
 * reconciliation seam (the A5 decision), Phase 204.
 *
 * Two capability shapes exist in this codebase and they DIFFER:
 *
 *   - The emulator side (this file, design §3A.4) is a FLAT `ChannelCaps`:
 *     `{ channel, inbound{}, outbound{}, protocol }`.
 *   - The production adapter (telegram-plugin.ts `CAPABILITIES`,
 *     core/channel-capability.ts) is NESTED `ChannelCapability`:
 *     `{ features{}, limits{}, replyToMetaKey }`.
 *
 * The A5 decision (RESOLVED here): `tg-caps.ts` carries the flat descriptor AND
 * the reconciliation map; the FOUND-03 contract test (`tg-caps.test.ts`) reads
 * the adapter's REAL declared capabilities from `@comis/channels` and asserts
 * the overlapping fields match — a drift tripwire so the emulator's caps can
 * never silently diverge from the adapter's self-declaration (threat T-204-08).
 *
 * The flat `ChannelCaps` shape has no slot for a message-length limit, so the
 * reconciled `maxMessageChars` is carried as the sibling const
 * {@link TG_MAX_MESSAGE_CHARS} (the FOUND-03 reconciliation seam) and the
 * contract test asserts it against the adapter's `limits.maxMessageChars`.
 *
 * --- FOUND-03 FIELD-BY-FIELD MAP (emulator FLAT ⇄ adapter NESTED) ---
 *   outbound.reactions    == features.reactions      (true)
 *   outbound.edits        == features.editMessages   (true)
 *   outbound.deletes      == features.deleteMessages (true)
 *   outbound.attachments  == features.attachments    (true)
 *   outbound.typing       == features.typing         (true)
 *   outbound.threads      == features.threads        (false)
 *   outbound.buttons:true ⇄ features.buttons === "inline" (a non-"none" flavour)
 *   TG_MAX_MESSAGE_CHARS  == limits.maxMessageChars  (4096)
 *   (inbound has no history claim) ⇄ features.fetchHistory (false)
 *
 * --- NOT-RECONCILED-YET (documented) ---
 * The emulator's inbound-only fields (`inbound.text` / `inbound.media` /
 * `inbound.slashCommands` / `inbound.location` / `inbound.edits` /
 * `inbound.reactions`) have NO counterpart in the adapter's capability surface
 * (it declares no inbound caps). They are deliberately NOT asserted against
 * `CAPABILITIES` — the reconciliation scope is the overlap only. When the
 * adapter grows an inbound caps surface, extend the map.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change.
 *
 * @module
 */

import type { ChannelCaps } from "../../harness/channel-emulator.js";

/**
 * The reconciled Telegram message-length limit (the FOUND-03 seam).
 *
 * The flat `ChannelCaps` shape carries no `maxMessageChars` field, so the
 * reconciled value lives here as a sibling const. The contract test asserts it
 * equals the adapter's `limits.maxMessageChars` (telegram-plugin.ts), so a
 * drift in the adapter's limit flips the test red.
 */
export const TG_MAX_MESSAGE_CHARS = 4096;

/**
 * The Telegram emulator capability descriptor (the flat design-side shape).
 *
 * `outbound.*` mirrors the adapter's `features.*` (the reconciled overlap — see
 * the field map above). `inbound.*` describes the emulator's inbound surface,
 * which is not-reconciled-yet (the adapter declares no inbound caps). `buttons`
 * is `true` because the adapter declares the non-"none" `"inline"` flavour.
 */
export const tgCaps: ChannelCaps = {
  channel: "telegram",
  protocol: "http",
  inbound: {
    // NOT-RECONCILED-YET — the adapter declares no inbound caps surface.
    text: true,
    media: ["photo", "voice", "document", "video", "video_note"],
    reactions: true,
    edits: true,
    buttons: true,
    threads: false,
    slashCommands: true,
    location: true,
  },
  outbound: {
    // RECONCILED field-by-field against the adapter's `features` (see the map).
    reactions: true, // == features.reactions
    edits: true, // == features.editMessages
    deletes: true, // == features.deleteMessages
    buttons: true, // ⇄ features.buttons === "inline"
    attachments: true, // == features.attachments
    typing: true, // == features.typing
    threads: false, // == features.threads (honest degradation: unsupported → false)
    richCards: false, // Telegram has no rich-card surface (adapter declares none).
  },
};
