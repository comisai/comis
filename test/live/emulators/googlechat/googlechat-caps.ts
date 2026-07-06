// SPDX-License-Identifier: Apache-2.0
/**
 * `googlechat-caps` — the Google Chat capability descriptor + the caps↔adapter
 * reconciliation seam (the Google Chat mirror of `msteams-caps.ts`).
 *
 * Two capability shapes exist in this codebase and they DIFFER:
 *
 *   - The emulator side (this file) is a FLAT `ChannelCaps`:
 *     `{ channel, inbound{}, outbound{}, protocol }`.
 *   - The production adapter (googlechat-plugin.ts `CAPABILITIES`,
 *     core/channel-capability.ts) is NESTED `ChannelCapability`:
 *     `{ features{}, limits{}, replyToMetaKey }`.
 *
 * By design, this file carries the flat descriptor AND the reconciliation map;
 * the contract test (`googlechat-caps.test.ts`) reads the adapter's REAL declared
 * capabilities from `@comis/channels` (via `createGoogleChatPlugin(...).capabilities`)
 * and asserts the overlapping fields match — a drift tripwire so the emulator's
 * caps can never silently diverge from the adapter's self-declaration.
 *
 * THE KEY GOOGLE CHAT DIFFERENCE vs Teams: a service-account app reaches NO
 * reaction surface at all — `features.reactions` is `false`, so BOTH
 * `inbound.reactions` and `outbound.reactions` are honestly `false` (Teams maps a
 * `true` `features.reactions` to its INBOUND messageReaction path; Google Chat has
 * neither an inbound nor an outbound reaction). A Cards v2 click is an INBOUND
 * event (`inbound.buttons: true`) and the bot renders Cards v2 buttons outbound
 * (`features.buttons: "cardsv2"` → `outbound.buttons: true`), and threaded replies
 * route through the send path (`features.threads: true`). Outbound upload and
 * typing indicators are app-auth-unreachable (`features.attachments`/`typing`
 * false).
 *
 * --- FIELD-BY-FIELD MAP (emulator FLAT ⇄ adapter NESTED) ---
 *   inbound.reactions:false  ⇄ (no inbound reaction path — GOOGLE CHAT: none at all)
 *   outbound.reactions       == features.reactions      (false — no send-reaction API)
 *   outbound.edits           == features.editMessages   (true — text-masked messages.patch)
 *   outbound.deletes         == features.deleteMessages (true — messages.delete of the bot's own)
 *   outbound.attachments     == features.attachments    (false — outbound upload is user-auth-only)
 *   outbound.typing          == features.typing         (false — no typing API)
 *   outbound.threads         == features.threads        (true — threaded reply on the send path)
 *   outbound.buttons:true    ⇄ features.buttons !== "none"  (true ⇄ "cardsv2")
 *   GOOGLECHAT_MAX_MESSAGE_CHARS == limits.maxMessageChars (4000)
 *   (inbound has no history claim) ⇄ features.fetchHistory (false)
 *
 * --- NOT-RECONCILED-YET (documented) ---
 * The emulator's inbound-only fields other than the button/thread overlap
 * (`inbound.text` / `inbound.media` / `inbound.edits` / `inbound.slashCommands` /
 * `inbound.location`) have no counterpart in the adapter's capability surface (it
 * declares no inbound caps beyond the overlap above). They are deliberately NOT
 * asserted against `CAPABILITIES` — the reconciliation scope is the overlap only.
 * `outbound.richCards` (Cards v2) has no dedicated `features` field either (it
 * rides `features.buttons: "cardsv2"`), so it is documented, not reconciled.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change.
 *
 * @module
 */

import type { ChannelCaps } from "../../harness/channel-emulator.js";

/**
 * The reconciled Google Chat message-length limit (the reconciliation seam).
 *
 * The flat `ChannelCaps` shape carries no `maxMessageChars` field, so the
 * reconciled value lives here as a sibling const. The contract test asserts it
 * equals the adapter's `limits.maxMessageChars` (googlechat-plugin.ts), so a
 * drift in the adapter's limit flips the test red.
 */
export const GOOGLECHAT_MAX_MESSAGE_CHARS = 4000;

/**
 * The Google Chat emulator capability descriptor (the flat design-side shape).
 *
 * `outbound.*` mirrors the adapter's `features.*` (the reconciled overlap — see
 * the field map above). `inbound.*` describes the emulator's inbound surface:
 * text, media (images/voice/documents/video resolved via the
 * `googlechat-attachment://` resolver), Cards v2 button clicks (CARD_CLICKED
 * events), and space threads. It has no reaction path (a service-account app
 * cannot react), no inbound edit path, no slash-command kind (a slash command
 * arrives as a MESSAGE event), and no location messages — all honestly false.
 */
export const googlechatCaps: ChannelCaps = {
  channel: "googlechat",
  protocol: "http",
  inbound: {
    // Google Chat delivers inbound text (MESSAGE events → mapGoogleChatEventToNormalized),
    // media attachments (attachmentDataRef.resourceName → googlechat-attachment://
    // resolver), Cards v2 button clicks (CARD_CLICKED events with the rendered
    // approval verb), and space threads (message.thread.name). It has no inbound
    // reaction path, no inbound edit path, no distinct slash-command kind, and no
    // location messages — represented as false (honest, not omitted).
    text: true,
    media: ["photo", "voice", "document", "video"],
    // GOOGLE CHAT: no reaction surface at all (unlike Teams, where reactions are inbound).
    reactions: false,
    edits: false,
    buttons: true, // Cards v2 button click is an inbound CARD_CLICKED event.
    threads: true,
    slashCommands: false,
    location: false,
  },
  outbound: {
    // A service-account app has no send-reaction API — reactToMessage/removeReaction
    // are permanently omitted (googlechat-plugin.ts). == features.reactions (false).
    reactions: false,
    // RECONCILED field-by-field against the adapter's `features` (see the map).
    edits: true, // == features.editMessages (text-masked messages.patch / edit-in-place)
    deletes: true, // == features.deleteMessages (messages.delete of the bot's own message)
    buttons: true, // ⇄ features.buttons === "cardsv2" (a non-"none" flavour → true)
    attachments: false, // == features.attachments (outbound upload is user-auth-only)
    typing: false, // == features.typing (no typing API)
    threads: true, // == features.threads (threaded reply routes through the send path)
    richCards: true, // Cards v2 render (rides features.buttons:"cardsv2"; documented, not reconciled).
  },
};
