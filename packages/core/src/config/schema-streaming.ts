import { z } from "zod";
import { DeliveryTimingConfigSchema } from "./schema-delivery.js";
import { CoalescerConfigSchema } from "./schema-coalescer.js";

/**
 * Typing indicator mode per channel.
 *
 * - `never`: No typing indicators sent
 * - `instant`: Show typing immediately when request received
 * - `thinking`: Show typing while agent is processing (default)
 * - `message`: Show typing only while message is being delivered
 */
export const TypingModeSchema = z
  .enum(["never", "instant", "thinking", "message"])
  .default("thinking");

/**
 * Block chunking strategy for response splitting.
 *
 * - `paragraph`: Split at double newlines (default, most natural)
 * - `newline`: Split at any newline
 * - `sentence`: Split at sentence boundaries
 * - `length`: Pure character-length based splitting
 */
export const ChunkModeSchema = z
  .enum(["paragraph", "newline", "sentence", "length"])
  .default("paragraph");

/**
 * Table conversion mode for Markdown IR pipeline.
 *
 * - `code`: Convert tables to monospace code blocks with aligned columns
 * - `bullets`: Convert tables to bullet lists with header-prefixed values
 * - `off`: Leave table blocks unchanged (passthrough)
 */
export const TableModeSchema = z
  .enum(["code", "bullets", "off"])
  .default("code");

/**
 * Reply mode for outbound messages in conversations.
 *
 * - `off`: Never set replyTo on outbound messages
 * - `first`: Set replyTo on the first chunk only (default, current behavior)
 * - `all`: Set replyTo on all chunks
 */
export const ReplyModeSchema = z.enum(["off", "first", "all"]).default("first");

/**
 * Per-channel streaming and block delivery configuration.
 *
 * Allows each channel (e.g., telegram, discord) to have independent
 * streaming behavior, typing indicator mode, and delivery timing/coalescer settings.
 */
export const PerChannelStreamingConfigSchema = z.strictObject({
    /** Whether block streaming is enabled for this channel */
    enabled: z.boolean().default(true),
    /** How to split response text into blocks */
    chunkMode: ChunkModeSchema,
    /** Maximum characters per block (falls back to platform maxMessageChars if not set) */
    chunkMaxChars: z.number().int().positive().optional(),
    /** Minimum characters before allowing a split point */
    chunkMinChars: z.number().int().nonnegative().default(100),
    /** Delivery timing configuration (pacing between block deliveries) */
    deliveryTiming: DeliveryTimingConfigSchema.default(() => DeliveryTimingConfigSchema.parse({})),
    /** Block coalescer configuration (accumulation before flush) */
    coalescer: CoalescerConfigSchema.default(() => CoalescerConfigSchema.parse({})),
    /** When to show typing indicators */
    typingMode: TypingModeSchema,
    /** Typing indicator refresh interval in ms (platforms auto-clear after ~10s) */
    typingRefreshMs: z.number().int().positive().default(6000),
    /** Consecutive sendTyping failures before circuit breaker trips (default 3) */
    typingCircuitBreakerThreshold: z.number().int().positive().default(3),
    /** Maximum typing indicator duration in ms before auto-stop (default 60s) */
    typingTtlMs: z.number().int().positive().default(60000),
    /** Whether to use Markdown IR pipeline for format-first chunking (prevents double-chunking with chunkBlocks) */
    useMarkdownIR: z.boolean().default(true),
    /** Table conversion mode when using IR pipeline */
    tableMode: TableModeSchema,
    /** Reply-to threading mode for outbound messages */
    replyMode: ReplyModeSchema,
    /** Per-chat-type reply mode overrides (e.g., { dm: "off", group: "first", forum: "all" }) */
    replyModeByChatType: z.record(
      z.enum(["dm", "group", "thread", "channel", "forum"]),
      z.enum(["off", "first", "all"]),
    ).optional(),
  });

/**
 * Root streaming configuration schema.
 *
 * Controls block-based response delivery across all channels.
 * Per-channel overrides take precedence over these defaults.
 */
export const StreamingConfigSchema = z.strictObject({
    /** Global enable/disable for block streaming (defaults to enabled) */
    enabled: z.boolean().default(true),
    /** Default chunk mode for channels without per-channel override */
    defaultChunkMode: ChunkModeSchema,
    /** Default delivery timing for channels without per-channel override */
    defaultDeliveryTiming: DeliveryTimingConfigSchema.default(() => DeliveryTimingConfigSchema.parse({})),
    /** Default coalescer for channels without per-channel override */
    defaultCoalescer: CoalescerConfigSchema.default(() => CoalescerConfigSchema.parse({})),
    /** Default typing indicator mode */
    defaultTypingMode: TypingModeSchema,
    /** Default typing indicator refresh interval in ms */
    defaultTypingRefreshMs: z.number().int().positive().default(6000),
    /** Default table conversion mode for IR pipeline */
    defaultTableMode: TableModeSchema,
    /** Default for Markdown IR pipeline (true = format-aware chunking with platform rendering) */
    defaultUseMarkdownIR: z.boolean().default(true),
    /** Default reply-to threading mode for channels without per-channel override */
    defaultReplyMode: ReplyModeSchema,
    /** Per-channel-type streaming configuration overrides */
    perChannel: z
      .record(z.string(), PerChannelStreamingConfigSchema)
      .default({}),
  });

export type StreamingConfig = z.infer<typeof StreamingConfigSchema>;
export type PerChannelStreamingConfig = z.infer<
  typeof PerChannelStreamingConfigSchema
>;
export type TypingMode = z.infer<typeof TypingModeSchema>;
export type ChunkMode = z.infer<typeof ChunkModeSchema>;
export type TableMode = z.infer<typeof TableModeSchema>;
export type ReplyMode = z.infer<typeof ReplyModeSchema>;
