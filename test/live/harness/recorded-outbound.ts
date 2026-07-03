// SPDX-License-Identifier: Apache-2.0
/**
 * `RecordedOutbound` — the LIFTED channel-agnostic outbound-oracle subset
 * (CHAN2-02).
 *
 * The foundation-design bug this fixes: the channel-agnostic subset of an
 * outbound record (`{ method, messageId, text? }` — the EXACT bit the dual
 * oracle `assert/channel-trace.ts` and the generic `harness/control-api.ts`
 * actually consume) lived INSIDE the Telegram emulator
 * (`emulators/telegram/tg-emulator.ts:116-143`). So the "generic" `/control/*`
 * surface had a type edge on ONE specific channel — a second channel (Signal)
 * could not feed `assertChannelTrace` / `control-api` without depending
 * on the Telegram emulator. The telegram-first build anchored the shared type
 * under `emulators/telegram/`; this module lifts the agnostic subset UP to the
 * `harness/` layer so BOTH channels share a channel-neutral type.
 *
 * This is the channel-agnostic SUBSET, not the full per-channel record. The
 * Telegram emulator keeps its FULL `RecordedOutbound` (a SUPERSET adding
 * `raw`/`parseMode`/`replyMarkup`/`reactions`/… the telegram-specific extras)
 * and that superset is assignable to this subset, so the Telegram emulator + its
 * tests compile unchanged. A second channel records the same minimal subset with
 * NO telegram dependency.
 *
 * The fields are exactly what the channel-agnostic consumers read:
 *   - `method`    — the wire verb (`"sendMessage"` / `"send"` / `"react"`); any
 *                   channel records it.
 *   - `messageId` — the reply-wait watermark the control-api filters on
 *                   (`o.messageId > afterMessageId`).
 *   - `text?`     — the outbound text the dual oracle compares to
 *                   `delivery_mirror.text` (absent on a reaction-only outbound).
 *
 * Hard constraint (mirrors `channel-emulator.ts`): this is the SHARED type, so it
 * depends on NOTHING channel-specific — no `grammy`, no `@comis/channels`, no
 * `emulators/telegram/` edge. The lift must not re-import the very dependency it
 * removes.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture
 * rule.
 *
 * @module
 */

/**
 * The channel-agnostic outbound-oracle subset every emulated channel's outbound
 * record satisfies (the lifted shared type).
 *
 * A per-channel emulator's full record (e.g. Telegram's, with `raw` + the
 * telegram-specific extras) is a SUPERSET of this interface and assignable to
 * it. The generic `control-api` + the dual oracle read ONLY these fields, so a
 * second channel feeds them by recording exactly this subset.
 */
export interface RecordedOutbound {
  /**
   * The wire method/verb, e.g. `"sendMessage"` (Telegram) or `"send"` (Signal).
   * Channel-neutral: any outbound a channel records names its method here.
   */
  method: string;
  /**
   * The outbound message id — the reply-wait watermark the control-api filters
   * on (`o.messageId > afterMessageId`). For Telegram the minted `message_id`;
   * for Signal the `timestamp` the adapter reads as the message id.
   */
  messageId: number;
  /**
   * The outbound text, when the outbound carries one (absent on a reaction-only
   * outbound). The dual oracle (`assert/channel-trace.ts`) compares this to
   * `delivery_mirror.text` — the channel-neutral cross-check field.
   */
  text?: string;
}
