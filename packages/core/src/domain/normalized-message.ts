// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import { CanonicalLocaleSchema } from "./response-locale-policy.js";
import { STT_ERROR_KINDS } from "../media/voice-error.js";

const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

/** Cross-channel ceiling for one normalized physical message. */
export const MAX_NORMALIZED_MESSAGE_TEXT_CHARS = 65_536;

/** Defensive ceiling for earlier group messages attached to one activating turn. */
export const MAX_GROUP_HISTORY_CONTEXT_MESSAGES = 10_000;

/**
 * One earlier group message supplied as attributed, untrusted turn context.
 *
 * This is runtime context, not conversation identity or operator policy.
 */
export const GroupHistoryContextEntrySchema = z.strictObject({
  senderId: z.string().min(1),
  text: z.string().max(MAX_NORMALIZED_MESSAGE_TEXT_CHARS),
});

export type GroupHistoryContextEntry = z.infer<typeof GroupHistoryContextEntrySchema>;

/** Runtime-owned auto-reply policy applied to the current activated group turn. */
export const AutoReplyPolicyContextSchema = z.strictObject({
  groupActivation: z.enum(["always", "mention-gated", "custom"]),
  historyInjection: z.boolean(),
});

export type AutoReplyPolicyContext = z.infer<typeof AutoReplyPolicyContextSchema>;

/** One platform message explicitly referenced by the current inbound reply. */
export const ReplyContextSchema = z.strictObject({
  messageId: z.string().min(1),
  senderKind: z.enum(["agent", "user", "unknown"]),
  text: z.string().max(MAX_NORMALIZED_MESSAGE_TEXT_CHARS).optional(),
});

export type ReplyContext = z.infer<typeof ReplyContextSchema>;

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
    text: z.string().max(MAX_NORMALIZED_MESSAGE_TEXT_CHARS),
    timestamp: z.number().int().positive().max(MAX_DATE_EPOCH_MS),
    /** Present when the physical inbound was a platform interaction, not typed text. */
    interaction: z.literal("button_callback").optional(),
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
 * Content-free receipt from automatic inbound link prefetching.
 *
 * This field is produced by the trusted media preprocessor and recorded after
 * the session trajectory opens. It contains counts and elapsed time only:
 * never a URL, page title, response body, or error message.
 */
export const LinkPrefetchReceiptSchema = z.strictObject({
  detected: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  validationRejected: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  capped: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type LinkPrefetchReceipt = z.infer<typeof LinkPrefetchReceiptSchema>;

const SttSelectionSourceSchema = z.enum([
  "explicit",
  "keyless-local",
  "follow-main-key",
  "fallback",
]);

/**
 * Content-free evidence from one automatic inbound transcription attempt.
 *
 * The trusted media preprocessor creates this receipt before the session
 * trajectory opens. It deliberately excludes the attachment URL, transcript,
 * provider error text, and audio content.
 */
const SttPreprocessReceiptBaseSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  keyless: z.boolean(),
  model: z.string().min(1).max(256).optional(),
  source: SttSelectionSourceSchema,
  onSkip: z.array(z.string().min(1).max(256)).max(16).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  audioBytes: z.number().int().nonnegative().optional(),
});

export const SttPreprocessReceiptSchema = z.discriminatedUnion("outcome", [
  SttPreprocessReceiptBaseSchema.extend({
    outcome: z.literal("ok"),
  }),
  SttPreprocessReceiptBaseSchema.extend({
    outcome: z.literal("failed"),
    errorKind: z.enum(STT_ERROR_KINDS),
  }),
]);

export const SttPreprocessReceiptsSchema = z
  .array(SttPreprocessReceiptSchema)
  .max(16);

export type SttPreprocessReceipt = z.infer<
  typeof SttPreprocessReceiptSchema
>;

/**
 * Content-free evidence that sanitized inbound images were injected directly
 * into the executing agent model's multimodal request.
 *
 * The trusted media preprocessor creates this receipt before the session
 * trajectory opens. It excludes image bytes, attachment URLs, captions,
 * extracted text, and model output.
 */
export const VisionDirectPreprocessReceiptSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  mainProvider: z.string().min(1).max(128),
  model: z.string().min(1).max(256).optional(),
  path: z.literal("vision-direct"),
  outcome: z.literal("ok"),
});

export type VisionDirectPreprocessReceipt = z.infer<
  typeof VisionDirectPreprocessReceiptSchema
>;

/**
 * Content-free proof that the internal completion relay is rewriting a
 * runtime-settled action result rather than handling ordinary cross-session
 * prose. Consumers must also verify the internal relay channel and sender.
 */
export const RuntimeActionEvidenceSchema = z.strictObject({
  kind: z.literal("background_completion"),
});

export type RuntimeActionEvidence = z.infer<
  typeof RuntimeActionEvidenceSchema
>;

/**
 * Runtime-owned proof that a background result observed successful web fetches.
 * Only exact SHA-256 URL digests cross the relay boundary: fetched URLs, page
 * content, titles, and snippets remain out of metadata and telemetry.
 */
export const CitationEvidenceSchema = z.strictObject({
  kind: z.literal("web_fetch"),
  urlDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100),
});

export type CitationEvidence = z.infer<typeof CitationEvidenceSchema>;

export interface SttPreprocessSelection {
  readonly provider: string;
  readonly keyless: boolean;
  readonly model?: string;
  readonly source: z.infer<typeof SttSelectionSourceSchema>;
  readonly onSkip?: string[];
}

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
    text: z.string().max(MAX_NORMALIZED_MESSAGE_TEXT_CHARS),
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
      /** Trusted, counts-only automatic link-prefetch receipt. */
      linkPrefetch: LinkPrefetchReceiptSchema.optional(),
      /** Trusted, content-free automatic inbound transcription receipts. */
      sttPreprocess: SttPreprocessReceiptsSchema.optional(),
      /** Trusted, content-free direct model-vision preprocessing receipt. */
      visionPreprocess: VisionDirectPreprocessReceiptSchema.optional(),
      /** Runtime-owned current-action receipt for internal completion rewrites. */
      runtimeActionEvidence: RuntimeActionEvidenceSchema.optional(),
      /** Runtime-owned exact-URL digests from successful background web fetches. */
      citationEvidence: CitationEvidenceSchema.optional(),
      /** Trusted projection of earlier group chatter, rendered as untrusted prompt context. */
      groupHistoryContext: z
        .array(GroupHistoryContextEntrySchema)
        .max(MAX_GROUP_HISTORY_CONTEXT_MESSAGES)
        .optional(),
      /** Runtime-owned group activation policy used for this turn. */
      autoReplyPolicyContext: AutoReplyPolicyContextSchema.optional(),
      /** Bounded content and attribution for the platform message explicitly replied to. */
      replyContext: ReplyContextSchema.optional(),
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
    ...(message.metadata?.isButtonCallback === true
      ? { interaction: "button_callback" as const }
      : {}),
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
