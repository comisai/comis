// SPDX-License-Identifier: Apache-2.0
/**
 * Signal `SignalEnvelope` builders (CHAN2-01 / invariant I4, Phase 209).
 *
 * The Signal emulator's SSE `/api/v1/events` stream (Plan 04) serves these
 * builder-produced `SignalEnvelope` values, and the foundation-proof scenario
 * (Plan 05) round-trips them through the REAL production Signal adapter
 * (`mapSignalToNormalized`). Because the builders import the Signal adapter's
 * OWN exported `SignalEnvelope` / `SignalAttachment` wire interface (re-exported
 * `type`-only from the `@comis/channels` barrel; defined in
 * `packages/channels/src/signal/signal-client.ts`) and return-annotate against
 * it, every emitted envelope is *guaranteed* to be exactly the shape the adapter
 * parses — a wire-shape drift becomes a COMPILE error here, not a silent runtime
 * mismatch. That is the whole point: it forecloses the hand-rolled-struct drift
 * problem this milestone exists to avoid (design §1.3). There is no third-party
 * SDK to pin (Signal speaks signal-cli JSON-RPC, not a typed client library) —
 * the I4 contract IS the adapter's exported interface itself.
 *
 * Analog (the untyped literal this replaces): `injectInboundMessage` in
 * `test/e2e/mocks/signal/mock-signal-server.ts:242-271` — same runtime shape,
 * which uses `Record<string, unknown>`; the I4 upgrade to a TYPED, return-
 * annotated builder is the genuinely-new value here. The grammy-typed Telegram
 * twin is `test/live/emulators/telegram/tg-payloads.ts`.
 *
 * Scope (Phase 209, CHAN2-01): the `dataMessage.message` envelope (the DM/group
 * text round-trip — what `mapSignalToNormalized` parses to `NormalizedMessage.text`)
 * and the `dataMessage.reaction` envelope (the react FLOW — `{ emoji,
 * targetSentTimestamp }` → `metadata.signalReaction=true` /
 * `signalReactionEmoji` / `signalReactionTarget`, `message-mapper.ts:46-67`). A
 * `group:<id>` channel sets `dataMessage.groupInfo.groupId` (the `isGroup`
 * branch, `message-mapper.ts:33-34`).
 *
 * SECURITY (SEC-02): the `SignalEnvelope` / `SignalAttachment` imports are
 * `type`-only (erased at build) so this file carries NO `@comis/*` runtime edge
 * into the never-published harness (`harness-never-published.test.ts`).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change. The lone product touch (the `type`-only barrel re-export of the wire
 * interface) is VISIBILITY-only — erased at build, no behavior moved.
 *
 * @module
 */

import type { SignalEnvelope, SignalAttachment } from "@comis/channels";

/**
 * Options for {@link makeMessageEnvelope}.
 *
 * Mirrors the fields `mapSignalToNormalized` reads (`message-mapper.ts:24-94`):
 * the sender identity (`sourceUuid` ?? `sourceNumber` ?? `source` →
 * `NormalizedMessage.senderId`), the message text (`dataMessage.message` →
 * `.text`), and the optional `group:<id>` channel (→ `dataMessage.groupInfo`).
 */
export interface MakeMessageEnvelopeOptions {
  /**
   * The sender's Signal identifier. The mapper resolves `senderId` as
   * `sourceUuid ?? sourceNumber ?? source`; the builder stamps `source` /
   * `sourceNumber` / `sourceName` to it so a DM channel id equals the sender
   * (the mock-signal-server.ts:248-251 shape).
   */
  readonly from: string;
  /** The message body (`dataMessage.message` → `NormalizedMessage.text`). */
  readonly content: string;
  /**
   * The channel id. A `group:<id>` prefix sets `dataMessage.groupInfo.groupId`
   * (the `isGroup` branch, `message-mapper.ts:33-34`); any other value is a DM
   * (no `groupInfo`, the channel id IS the sender). Defaults to the DM form.
   */
  readonly channel?: string;
  /**
   * The Signal message timestamp (`envelope.timestamp` → the durable
   * `metadata.signalTimestamp`, and `dataMessage.timestamp`). Defaults to a
   * monotonically-increasing source ({@link nextSignalTimestamp}) so a suite
   * gets strictly-ordered envelopes without managing the counter.
   */
  readonly timestamp?: number;
  /** The sender's Signal UUID. Defaults to the all-zero placeholder uuid (the mock shape). */
  readonly sourceUuid?: string;
  /** A display name (`envelope.sourceName` → `metadata.signalSenderName`). Defaults to `from`. */
  readonly sourceName?: string;
}

/**
 * Build a well-formed signal-cli `SignalEnvelope` carrying a text
 * `dataMessage.message` (the CHAN2-01 DM/group text round-trip).
 *
 * The return annotation IS the adapter's OWN `SignalEnvelope` (the I4 tripwire):
 * a drift in the wire interface (`signal-client.ts:31`) fails to compile here.
 * The literal is byte-for-byte the proven `mock-signal-server.ts:247-260` shape
 * — flat top-level keys (`source` / `sourceUuid` / `dataMessage`), NOT wrapped
 * in an outer `envelope:` key. For a `group:<id>` channel it sets
 * `dataMessage.groupInfo.groupId` (the `isGroup` branch the mapper reads); a DM
 * omits `groupInfo` (the channel id is the sender). `groupInfo` is set only when
 * the channel is a group (exactOptionalPropertyTypes — an absent group is NOT
 * `groupInfo: undefined`).
 */
export function makeMessageEnvelope(opts: MakeMessageEnvelopeOptions): SignalEnvelope {
  const ts = opts.timestamp ?? nextSignalTimestamp();
  const channel = opts.channel ?? opts.from;
  const isGroup = channel.startsWith("group:");
  return {
    source: opts.from,
    sourceNumber: opts.from,
    sourceUuid: opts.sourceUuid ?? "00000000-0000-0000-0000-000000000000",
    sourceName: opts.sourceName ?? opts.from,
    timestamp: ts,
    dataMessage: {
      message: opts.content,
      // The `isGroup` branch (message-mapper.ts:33-34): a `group:<id>` channel
      // carries groupInfo.groupId; a DM omits it (the channel id is the sender).
      ...(isGroup ? { groupInfo: { groupId: channel.slice("group:".length) } } : {}),
    },
  };
}

/**
 * Options for {@link makeReactionEnvelope}.
 *
 * Mirrors the reaction fields `mapSignalToNormalized` reads
 * (`message-mapper.ts:46-67`): an `emoji` + a `targetSentTimestamp` (the
 * EXISTING message's timestamp the reaction targets — both required for the
 * mapper to treat the envelope as a reaction, `:48`).
 */
export interface MakeReactionEnvelopeOptions {
  /** The reactor's Signal identifier (→ `senderId`, as in {@link MakeMessageEnvelopeOptions}). */
  readonly from: string;
  /**
   * The reaction emoji (`dataMessage.reaction.emoji` → `metadata.signalReactionEmoji`
   * AND `NormalizedMessage.text`, `message-mapper.ts:51,61`).
   */
  readonly emoji: string;
  /**
   * The `targetSentTimestamp` — the timestamp of the message being reacted to
   * (`dataMessage.reaction.targetSentTimestamp` → `metadata.signalReactionTarget`,
   * `message-mapper.ts:50`). REQUIRED: the mapper only treats the envelope as a
   * reaction when BOTH `emoji` and `targetSentTimestamp` are present (`:48`).
   */
  readonly targetSentTimestamp: number;
  /** The channel id (DM by default; `group:<id>` sets groupInfo). */
  readonly channel?: string;
  /** This reaction envelope's own timestamp. Defaults to {@link nextSignalTimestamp}. */
  readonly timestamp?: number;
  /** When true, set `reaction.isRemove` (→ `metadata.signalReactionRemove`, `message-mapper.ts:52-54`). Omitted otherwise (exactOptional). */
  readonly remove?: boolean;
  /** The reaction target's author (`reaction.targetAuthor`). Omitted when absent. */
  readonly targetAuthor?: string;
}

/**
 * Build a well-formed signal-cli `SignalEnvelope` carrying a
 * `dataMessage.reaction` (the CHAN2-01 react FLOW — the WS1-relevant verb Signal
 * supports, unlike Telegram's button callbacks).
 *
 * The return annotation IS the adapter's OWN `SignalEnvelope` (the I4 tripwire).
 * The mapper (`message-mapper.ts:47-67`) requires BOTH `reaction.emoji` and
 * `reaction.targetSentTimestamp` to classify the envelope as a reaction — so the
 * builder sets both unconditionally. `isRemove` / `targetAuthor` are spread only
 * when supplied (exactOptionalPropertyTypes — an absent optional is NOT
 * `: undefined`). For a `group:<id>` channel `groupInfo.groupId` is set (the
 * group-reaction case); a DM omits it.
 */
export function makeReactionEnvelope(opts: MakeReactionEnvelopeOptions): SignalEnvelope {
  const ts = opts.timestamp ?? nextSignalTimestamp();
  const channel = opts.channel ?? opts.from;
  const isGroup = channel.startsWith("group:");
  return {
    source: opts.from,
    sourceNumber: opts.from,
    sourceUuid: "00000000-0000-0000-0000-000000000000",
    sourceName: opts.from,
    timestamp: ts,
    dataMessage: {
      // A reaction envelope carries no text message — the mapper reads `reaction`
      // FIRST (message-mapper.ts:47) and returns the reaction NormalizedMessage
      // before the regular-message branch.
      reaction: {
        emoji: opts.emoji,
        targetSentTimestamp: opts.targetSentTimestamp,
        ...(opts.targetAuthor !== undefined ? { targetAuthor: opts.targetAuthor } : {}),
        ...(opts.remove === true ? { isRemove: true } : {}),
      },
      ...(isGroup ? { groupInfo: { groupId: channel.slice("group:".length) } } : {}),
    },
  };
}

/**
 * Options for {@link makeSignalAttachment}.
 *
 * A signal-cli attachment descriptor (`signal-client.ts:70`) — what
 * `buildSignalAttachments` reads (`media-handler.ts`) to produce a
 * `NormalizedMessage.attachments` entry.
 */
export interface MakeSignalAttachmentOptions {
  /** The attachment id (signal-cli's content-addressed id). */
  readonly id: string;
  /** The MIME type (`contentType` → the normalized attachment's type). Omitted when absent. */
  readonly contentType?: string;
  /** The original filename. Omitted when absent. */
  readonly filename?: string;
  /** The size in bytes. Omitted when absent. */
  readonly size?: number;
}

/**
 * Build a single signal-cli `SignalAttachment` (the I4 attachment tripwire).
 *
 * The return annotation IS the adapter's OWN `SignalAttachment` (`signal-client.ts:70`):
 * a drift fails to compile here. Optional fields are spread only when defined
 * (exactOptionalPropertyTypes). Used to populate `dataMessage.attachments` on a
 * media envelope.
 */
export function makeSignalAttachment(opts: MakeSignalAttachmentOptions): SignalAttachment {
  return {
    id: opts.id,
    ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
    ...(opts.filename !== undefined ? { filename: opts.filename } : {}),
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  };
}

/**
 * Module-level strictly-monotonic Signal-timestamp source.
 *
 * signal-cli envelopes are ordered by their millisecond `timestamp`; a reaction
 * targets an earlier message by its `targetSentTimestamp`. Starting at the
 * proven `mock-signal-server.ts:64` base (`1_700_000_000_000`) keeps the
 * emitted envelopes in a realistic, strictly-increasing range so a later
 * reaction's `targetSentTimestamp` can name an earlier message's `timestamp`.
 */
let signalTimestampCounter = 1_700_000_000_000;

/**
 * Return the next strictly-increasing Signal millisecond timestamp.
 */
export function nextSignalTimestamp(): number {
  signalTimestampCounter += 1;
  return signalTimestampCounter;
}

/**
 * Reset the {@link nextSignalTimestamp} counter to its initial base (so the next
 * call returns `1_700_000_000_001`). For per-test isolation when a suite needs a
 * deterministic sequence.
 */
export function resetSignalTimestampCounter(): void {
  signalTimestampCounter = 1_700_000_000_000;
}
