// SPDX-License-Identifier: Apache-2.0
/**
 * `msteams-caps` — the Microsoft Teams capability descriptor + the caps↔adapter
 * reconciliation seam (the Teams mirror of `tg-caps.ts` / `signal-caps.ts`).
 *
 * Two capability shapes exist in this codebase and they DIFFER:
 *
 *   - The emulator side (this file) is a FLAT `ChannelCaps`:
 *     `{ channel, inbound{}, outbound{}, protocol }`.
 *   - The production adapter (msteams-plugin.ts `CAPABILITIES`,
 *     core/channel-capability.ts) is NESTED `ChannelCapability`:
 *     `{ features{}, limits{}, replyToMetaKey }`.
 *
 * By design, this file carries the flat descriptor AND the reconciliation map;
 * the contract test (`msteams-caps.test.ts`) reads the adapter's REAL declared
 * capabilities from `@comis/channels` (via `createMsTeamsPlugin(...).capabilities`)
 * and asserts the overlapping fields match — a drift tripwire so the emulator's
 * caps can never silently diverge from the adapter's self-declaration.
 *
 * THE KEY TEAMS DIFFERENCE vs Telegram/Signal: `features.reactions: true` is an
 * INBOUND capability. Teams exposes NO bot-reaction send API, so the plugin
 * permanently omits `reactToMessage`/`removeReaction` (msteams-plugin.ts:11-13).
 * The reconciliation therefore maps `features.reactions` to the emulator's
 * `inbound.reactions` (the messageReaction inbound path), NOT `outbound.reactions`
 * (which is `false` — there is nothing to send). A second Teams difference:
 * `features.buttons: "adaptivecard"` (an Adaptive Card button surface — a
 * non-"none" flavour → `outbound.buttons: true`), and `features.threads: true`
 * (channel/group thread root via `replyToId`, unlike Telegram/Signal's `false`).
 *
 * The flat `ChannelCaps` shape has no slot for a message-length limit, so the
 * reconciled `maxMessageChars` is carried as the sibling const
 * {@link MSTEAMS_MAX_MESSAGE_CHARS} and the contract test asserts it against the
 * adapter's `limits.maxMessageChars`.
 *
 * --- FIELD-BY-FIELD MAP (emulator FLAT ⇄ adapter NESTED) ---
 *   inbound.reactions      == features.reactions      (true — TEAMS: reactions are INBOUND)
 *   outbound.reactions:false ⇄ (no send-reaction API; NOT reconciled to features.reactions)
 *   outbound.edits         == features.editMessages   (true — Bot Framework updateActivity)
 *   outbound.deletes       == features.deleteMessages (true — Bot Framework deleteActivity)
 *   outbound.attachments   == features.attachments    (true — inline image send / by-reference file)
 *   outbound.typing        == features.typing         (true — {type:"typing"} keepalive)
 *   outbound.threads       == features.threads        (true — replyToId thread root)
 *   outbound.buttons:true  ⇄ features.buttons !== "none"  (true ⇄ "adaptivecard")
 *   MSTEAMS_MAX_MESSAGE_CHARS == limits.maxMessageChars (28000)
 *   (inbound has no history claim) ⇄ features.fetchHistory (false)
 *
 * --- NOT-RECONCILED-YET (documented) ---
 * The emulator's inbound-only fields other than `inbound.reactions`
 * (`inbound.text` / `inbound.media` / `inbound.edits` / `inbound.buttons` /
 * `inbound.threads` / `inbound.slashCommands` / `inbound.location`) have no
 * counterpart in the adapter's capability surface (it declares no inbound caps
 * beyond the reactions overlap above). They are deliberately NOT asserted against
 * `CAPABILITIES` — the reconciliation scope is the overlap only. `outbound.richCards`
 * (Adaptive Cards) has no dedicated `features` field either (it rides
 * `features.buttons: "adaptivecard"`), so it is documented, not reconciled.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change.
 *
 * @module
 */

import type { ChannelCaps } from "../../harness/channel-emulator.js";

/**
 * The reconciled Teams message-length limit (the reconciliation seam).
 *
 * The flat `ChannelCaps` shape carries no `maxMessageChars` field, so the
 * reconciled value lives here as a sibling const. The contract test asserts it
 * equals the adapter's `limits.maxMessageChars` (msteams-plugin.ts:99), so a
 * drift in the adapter's limit flips the test red.
 */
export const MSTEAMS_MAX_MESSAGE_CHARS = 28000;

/**
 * The Microsoft Teams emulator capability descriptor (the flat design-side shape).
 *
 * `outbound.*` mirrors the adapter's `features.*` (the reconciled overlap — see
 * the field map above) EXCEPT `outbound.reactions`, which is `false` because
 * Teams has no bot-reaction send API (the plugin's `features.reactions: true` is
 * an INBOUND capability, mapped to `inbound.reactions`). `inbound.*` describes
 * the emulator's inbound surface: text, media (images/files/video resolved via
 * the `msteams-file://` resolver), reactions (`messageReaction` activities),
 * buttons (Adaptive Card action `invoke` clicks), and channel/group threads.
 */
export const msteamsCaps: ChannelCaps = {
  channel: "msteams",
  protocol: "http",
  inbound: {
    // Teams delivers inbound text (message activities → mapMsTeamsActivityToNormalized),
    // media attachments (contentUrl / content.downloadUrl → msteams-file:// resolver),
    // reactions (messageReaction activities), Adaptive Card button clicks (invoke
    // activities with verb "comis.approval.resolve"), and channel/group threads
    // (conversation.id ";messageid=" suffix / replyToId). It has no inbound edit
    // path, no slash-commands, and no location messages — represented as false
    // (honest, not omitted).
    text: true,
    media: ["photo", "document", "video"],
    // RECONCILED — TEAMS: features.reactions is an INBOUND capability (messageReaction).
    reactions: true, // == features.reactions
    edits: false,
    buttons: true, // Adaptive Card action invoke (a button click is an inbound activity).
    threads: true,
    slashCommands: false,
    location: false,
  },
  outbound: {
    // Teams exposes NO bot-reaction send API — reactToMessage/removeReaction are
    // permanently omitted (msteams-plugin.ts:11-13). NOT reconciled to
    // features.reactions (which is the INBOUND capability above).
    reactions: false,
    // RECONCILED field-by-field against the adapter's `features` (see the map).
    edits: true, // == features.editMessages (Bot Framework updateActivity / edit-in-place)
    deletes: true, // == features.deleteMessages (Bot Framework deleteActivity)
    buttons: true, // ⇄ features.buttons === "adaptivecard" (a non-"none" flavour → true)
    attachments: true, // == features.attachments (inline image send; non-image by reference)
    typing: true, // == features.typing ({type:"typing"} keepalive)
    threads: true, // == features.threads (replyToId thread root — TEAMS supports threads)
    richCards: true, // Teams renders Adaptive Cards (rides features.buttons:"adaptivecard"; documented, not reconciled).
  },
};
