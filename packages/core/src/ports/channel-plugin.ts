import { z } from "zod";
import type { PluginPort } from "./plugin.js";
import type { ChannelPort } from "./channel.js";

/**
 * ChannelCapabilitySchema: Runtime-validated metadata describing what a
 * channel adapter supports.
 *
 * Capabilities are self-declared by each channel plugin at registration
 * time and validated with this schema. The system uses capabilities for
 * feature negotiation (e.g. "does this channel support threads?").
 */
const ChannelFeaturesSchema = z.strictObject({
    reactions: z.boolean().default(false),
    editMessages: z.boolean().default(false),
    deleteMessages: z.boolean().default(false),
    fetchHistory: z.boolean().default(false),
    attachments: z.boolean().default(false),
    threads: z.boolean().default(false),
    mentions: z.boolean().default(false),
    formatting: z.array(z.string()).default([]),
    /** Whether the channel supports interactive buttons */
    buttons: z.boolean().default(false),
    /** Whether the channel supports rich card embeds */
    cards: z.boolean().default(false),
    /** Whether the channel supports message delivery effects (spoiler, silent) */
    effects: z.boolean().default(false),
  });

const ChannelStreamingSchema = z.strictObject({
    supported: z.boolean().default(false),
    throttleMs: z.number().positive().default(300),
    maxChars: z.number().positive().optional(),
    /** Streaming delivery method: "edit" = edit message in-place, "block" = sequential messages, "none" = no streaming */
    method: z.enum(["edit", "block", "none"]).default("none"),
  });

/** Threading capability metadata for runtime feature detection. */
const ChannelThreadingSchema = z.strictObject({
    /** Whether threading is supported at all (mirrors features.threads for convenience) */
    supported: z.boolean().default(false),
    /** Type of threading: "native" = platform threads (Discord), "reply-chain" = thread_ts reply chains (Slack), "none" = no threading */
    threadType: z.enum(["native", "reply-chain", "none"]).default("none"),
    /** Maximum thread nesting depth (undefined = unlimited within a thread) */
    maxDepth: z.number().int().positive().optional(),
  });

export const ChannelCapabilitySchema = z.strictObject({
    /** Chat types this channel supports */
    chatTypes: z.array(z.enum(["dm", "group", "thread", "channel", "forum"])),

    /** Feature flags for optional capabilities */
    features: ChannelFeaturesSchema.default(() => ChannelFeaturesSchema.parse({})),

    /** Platform-specific message and attachment size limits */
    limits: z.strictObject({
        maxMessageChars: z.number().positive(),
        maxAttachmentSizeMb: z.number().positive().optional(),
      }),

    /** Streaming support configuration */
    streaming: ChannelStreamingSchema.default(() => ChannelStreamingSchema.parse({})),

    /** Threading capability metadata (extends features.threads with detail) */
    threading: ChannelThreadingSchema.default(() => ChannelThreadingSchema.parse({})),

    /** Metadata key used for reply-to references (platform-specific) */
    replyToMetaKey: z.string().optional(),
  });

/** Inferred type from ChannelCapabilitySchema */
export type ChannelCapability = z.infer<typeof ChannelCapabilitySchema>;

/**
 * ChannelStatus: Runtime status snapshot of a connected channel adapter.
 *
 * Returned by ChannelPort.getStatus() for observability and health checks.
 */
export interface ChannelStatus {
  /** Whether the adapter is currently connected and operational */
  readonly connected: boolean;
  /** The channel adapter instance identifier */
  readonly channelId: string;
  /** The channel type (e.g. "telegram", "discord") */
  readonly channelType: string;
  /** Milliseconds since the adapter started */
  readonly uptime?: number;
  /** Timestamp of the last message processed */
  readonly lastMessageAt?: number;
  /** Error description if the adapter is in a failed state */
  readonly error?: string;
  /** Connection mode used by this adapter (for health check stale-exemption logic) */
  readonly connectionMode?: "socket" | "polling" | "webhook";
}

/**
 * ChannelPluginPort: A plugin that provides a channel adapter.
 *
 * Extends the base PluginPort with channel-specific metadata:
 * - channelType: The unique channel type string (e.g. "telegram")
 * - capabilities: Self-declared feature/limit metadata
 * - adapter: The actual ChannelPort implementation
 *
 * Channel plugins register through createChannelRegistry(), which
 * validates capabilities and delegates lifecycle to PluginRegistry.
 */
export interface ChannelPluginPort extends PluginPort {
  /** The channel type this plugin provides (e.g. "telegram", "discord") */
  readonly channelType: string;
  /** Self-declared capability metadata, validated at registration */
  readonly capabilities: ChannelCapability;
  /** The underlying channel adapter implementation */
  readonly adapter: ChannelPort;
}
