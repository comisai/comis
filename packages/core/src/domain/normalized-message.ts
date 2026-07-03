// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

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
     * `z.looseObject` (zod v4 passthrough equivalent). The one concrete typed
     * field is:
     *
     * - `traceId?: string` — Channel-ingress trace identifier.
     *   Auto-injected by channel adapters before the handler fanout; the
     *   orchestrator's `adapter.onMessage` wrap reads this via
     *   `getMessageTraceId(msg)` to reuse the ingress traceId in its
     *   `runWithContext` call (defense-in-depth).
     *   Must be a valid UUID when present (z.guid validation).
     */
    metadata: z.looseObject({ traceId: z.guid().optional() }).default({}),
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

/**
 * Extract the channel-ingress trace identifier from a NormalizedMessage.
 *
 * Returns the `metadata.traceId` string when it is present and is a string;
 * returns `undefined` otherwise. The defensive `typeof v === "string"` check
 * guards against messages that never passed through the schema validator
 * (e.g. persisted messages or ones constructed from external sources).
 *
 * Usage (orchestrator wrap site):
 * ```typescript
 * const traceId = getMessageTraceId(msg) ?? randomUUID();
 * runWithContext({ traceId, channelType: msg.channelType }, () => processInbound(msg));
 * ```
 */
export function getMessageTraceId(msg: NormalizedMessage): string | undefined {
  const v = msg.metadata.traceId;
  return typeof v === "string" ? v : undefined;
}
