// SPDX-License-Identifier: Apache-2.0
/**
 * `matrix-caps` — the Matrix capability descriptor + the caps↔adapter
 * reconciliation seam (the Matrix mirror of `signal-caps.ts` / `msteams-caps.ts`).
 *
 * Two capability shapes exist in this codebase and they DIFFER:
 *
 *   - The emulator side (this file) is a FLAT `ChannelCaps`:
 *     `{ channel, inbound{}, outbound{}, protocol }`.
 *   - The production adapter (matrix-plugin.ts `CAPABILITIES`,
 *     core/channel-capability.ts) is NESTED `ChannelCapability`:
 *     `{ features{}, limits{}, replyToMetaKey }`.
 *
 * By design, this file carries the flat descriptor AND the reconciliation map;
 * the contract test (`matrix-caps.test.ts`) reads the adapter's REAL declared
 * capabilities from `@comis/channels` (via `createMatrixPlugin(...).capabilities`)
 * and asserts the overlapping fields match — a drift tripwire so the emulator's
 * caps can never silently diverge from the adapter's self-declaration.
 *
 * THE MATRIX SCOPE for this descriptor is plaintext text only: every rich
 * feature the adapter declares (`reactions` / `editMessages` / `deleteMessages` /
 * `fetchHistory` / `attachments` / `typing` / `threads`) is `false`, and
 * `features.buttons` is `"none"` (Matrix exposes no button surface here). So
 * every `outbound.*` flag is `false`. The one live capability is inbound/outbound
 * plaintext text, which the round-trip scenario proves against the real adapter.
 *
 * The flat `ChannelCaps` shape has no slot for a message-length limit, so the
 * reconciled `maxMessageChars` is carried as the sibling const
 * {@link MATRIX_MAX_MESSAGE_CHARS} and the contract test asserts it against the
 * adapter's `limits.maxMessageChars`.
 *
 * --- FIELD-BY-FIELD MAP (emulator FLAT ⇄ adapter NESTED) ---
 *   outbound.reactions     == features.reactions      (false — no reaction send)
 *   outbound.edits         == features.editMessages   (false)
 *   outbound.deletes       == features.deleteMessages (false)
 *   outbound.attachments   == features.attachments    (false — no media send here)
 *   outbound.typing        == features.typing         (false)
 *   outbound.threads       == features.threads        (false)
 *   outbound.buttons:false ⇄ features.buttons === "none"
 *   MATRIX_MAX_MESSAGE_CHARS == limits.maxMessageChars (32768)
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
 * The reconciled Matrix message-length limit (the reconciliation seam).
 *
 * The flat `ChannelCaps` shape carries no `maxMessageChars` field, so the
 * reconciled value lives here as a sibling const. The contract test asserts it
 * equals the adapter's `limits.maxMessageChars`, so a drift in the adapter's
 * limit flips the test red. This tracks the normalized-message text cap.
 */
export const MATRIX_MAX_MESSAGE_CHARS = 32768;

/**
 * The Matrix emulator capability descriptor (the flat design-side shape).
 *
 * `outbound.*` mirrors the adapter's `features.*` (the reconciled overlap — see
 * the field map above); every flag is `false` because the plaintext scope sends
 * only text. `inbound.*` describes the emulator's inbound surface, which is
 * not-reconciled-yet (the adapter declares no inbound caps). `buttons` is `false`
 * because the adapter declares the `"none"` flavour — Matrix has no button
 * surface here. `inbound.text` is `true`: the plaintext round-trip the scenario
 * drives through the real adapter.
 */
export const matrixCaps: ChannelCaps = {
  channel: "matrix",
  protocol: "http",
  inbound: {
    // Matrix carries inbound plaintext text (message-mapper maps the
    // m.room.message body). Media, reactions, edits, buttons, threads,
    // slash-commands, and location messages are not in this scope — represented
    // as false (honest, not omitted).
    text: true,
    media: [],
    reactions: false,
    edits: false,
    buttons: false,
    threads: false,
    slashCommands: false,
    location: false,
  },
  outbound: {
    // RECONCILED field-by-field against the adapter's `features` (see the map).
    reactions: false, // == features.reactions (no bot-reaction send here)
    edits: false, // == features.editMessages
    deletes: false, // == features.deleteMessages
    buttons: false, // ⇄ features.buttons === "none" — Matrix has no button surface here
    attachments: false, // == features.attachments (no media send here)
    typing: false, // == features.typing
    threads: false, // == features.threads
    richCards: false, // Matrix has no rich-card surface (adapter declares none).
  },
};
