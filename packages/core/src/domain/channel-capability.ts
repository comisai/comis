// SPDX-License-Identifier: Apache-2.0
// Channel capability Zod schema + inferred type — relocated from ports/channel-plugin.ts in Phase 28 commit 1
// (closes L15 per CORE-PORTS-01). Channel-shaped runtime metadata; sibling to other domain Zod schemas.
import { z } from "zod";

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
