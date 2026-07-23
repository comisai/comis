// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import { CanonicalLocaleSchema } from "./response-locale-policy.js";

const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

/**
 * Voice-specific metadata for voice notes and audio messages.
 */
export const VoiceMetaSchema = z.strictObject({
    /** Base64-encoded waveform amplitude data (256 samples, 0-255) */
    waveform: z.string().optional(),
    /** Audio codec name (e.g., "opus", "vorbis", "aac") */
    codec: z.string().optional(),
  });

export type VoiceMeta = z.infer<typeof VoiceMetaSchema>;

/**
 * Attachment embedded within a message (images, files, audio, etc.)
 */
export const AttachmentSchema = z.strictObject({
    type: z.enum(["image", "file", "audio", "video", "link"]),
    // Accepts both standard URLs and custom protocol schemes
    // (e.g. tg-file://) for deferred media resolution
    url: z.string().min(1),
    mimeType: z.string().optional(),
    fileName: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    /** Audio/video duration in milliseconds */
    durationMs: z.number().int().nonnegative().optional(),
    /** Whether this is a voice note (not regular audio) */
    isVoiceNote: z.boolean().optional(),
    /** Voice-specific metadata (waveform, codec) */
    voiceMeta: VoiceMetaSchema.optional(),
    /** Transcription text (filled by STT pipeline) */
    transcription: z.string().optional(),
  });

export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * One physical channel message represented inside a synthetic coalesced turn.
 *
 * The queue may combine multiple rapid messages into one model prompt. This
 * credential-redacted projection keeps the original identities available for
 * durable session provenance without retaining adapter-specific metadata or
 * plaintext secret assignments.
 */
const OriginalInboundMessageSchema = z.strictObject({
    id: z.guid(),
    channelId: z.string().min(1),
    channelType: z.string().min(1),
    senderId: z.string().min(1),
    text: z.string().max(32768),
    timestamp: z.number().int().positive().max(MAX_DATE_EPOCH_MS),
  });

export type OriginalInboundMessage = z.infer<typeof OriginalInboundMessageSchema>;

/** Session custom-entry payload containing the credential-redacted physical batch. */
const InboundMessageProvenanceBatchSchema = z.strictObject({
    schemaVersion: z.literal(1),
    batchId: z.guid(),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive().max(32),
    recordedAt: z.number().int().positive().max(MAX_DATE_EPOCH_MS),
    messages: z.array(OriginalInboundMessageSchema).min(1).max(10_000),
  }).refine((batch) => batch.chunkIndex < batch.chunkCount, {
    message: "chunkIndex must be less than chunkCount",
    path: ["chunkIndex"],
  });

type InboundMessageProvenanceBatch = z.infer<
  typeof InboundMessageProvenanceBatchSchema
>;

/** SDK custom-entry discriminator for structured inbound provenance. */
export const INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE = "comis.inbound-message-provenance";

/**
 * NormalizedMessage: Channel-agnostic representation of an incoming message.
 *
 * Every channel adapter converts its native message format into this shape
 * before it reaches core logic. This is the single source of truth for
 * what a "message" looks like inside Comis.
 */
export const NormalizedMessageSchema = z.strictObject({
    id: z.guid(),
    channelId: z.string().min(1),
    channelType: z.string().min(1),
    senderId: z.string().min(1),
    text: z.string().max(32768),
    timestamp: z.number().int().positive(),
    attachments: z.array(AttachmentSchema).default([]),
    replyTo: z.guid().optional(),
    /** Normalized chat type derived from platform metadata. */
    chatType: z.enum(["dm", "group", "thread", "channel", "forum"]).optional(),
    /**
     * Channel-agnostic metadata bag. Admits arbitrary adapter-specific keys
     * (e.g. `isButtonCallback`, `callbackData`, `telegramThreadId`) via
     * `z.looseObject` (zod v4 passthrough equivalent). Typed fields are:
     *
     * - `traceId?: string` — Channel-ingress trace identifier.
     *   Auto-injected by channel adapters before the handler fanout; downstream
     *   orchestration verifies it against the inherited request scope and uses
     *   it when an unscoped custom adapter needs a fallback entry boundary.
     *   Must be a valid UUID when present (z.guid validation).
     * - `locale?: string` — canonical BCP-47 response locale supplied by a
     *   trusted ingress adapter for this turn.
     */
    metadata: z.looseObject({
      traceId: z.guid().optional(),
      /** Canonical BCP-47 response locale resolved at the trusted ingress boundary. */
      locale: CanonicalLocaleSchema.optional(),
    }).default({}),
    /** Exact physical messages represented by a synthetic coalesced turn. */
    originalMessages: z.array(OriginalInboundMessageSchema).min(1).max(10_000).optional(),
  });

export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

/**
 * Parse unknown input into a NormalizedMessage, returning Result<T, ZodError>.
 */
export function parseMessage(raw: unknown): Result<NormalizedMessage, z.ZodError> {
  const result = NormalizedMessageSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

/** Parse a structured inbound-provenance custom-entry payload. */
export function parseInboundMessageProvenanceBatch(
  raw: unknown,
): Result<InboundMessageProvenanceBatch, z.ZodError> {
  const result = InboundMessageProvenanceBatchSchema.safeParse(raw);
  if (result.success) return ok(result.data);
  return err(result.error);
}

/**
 * Return the physical inbound messages represented by a normalized message.
 * An uncoalesced message projects to a one-element list.
 */
export function getOriginalInboundMessages(
  message: NormalizedMessage,
): OriginalInboundMessage[] {
  if (message.originalMessages !== undefined) return message.originalMessages;
  return [{
    id: message.id,
    channelId: message.channelId,
    channelType: message.channelType,
    // Restart continuations retain the user's routing identity on the live
    // message, but their durable authorship is Comis itself.
    senderId: message.metadata?.isRestartContinuation === true
      ? "system"
      : message.senderId,
    text: message.text,
    timestamp: message.timestamp,
  }];
}

/**
 * Extract the channel-ingress trace identifier from a NormalizedMessage.
 *
 * Returns the `metadata.traceId` string when it is present and is a string;
 * returns `undefined` otherwise. The defensive `typeof v === "string"` check
 * guards against messages that never passed through the schema validator
 * (e.g. persisted messages or ones constructed from external sources).
 *
 * Usage (inbound boundary):
 * ```typescript
 * const traceId = getMessageTraceId(msg) ?? randomUUID();
 * runWithContext({ traceId, channelType: msg.channelType }, () => processInbound(msg));
 * ```
 */
export function getMessageTraceId(msg: NormalizedMessage): string | undefined {
  const v = msg.metadata.traceId;
  return typeof v === "string" ? v : undefined;
}
