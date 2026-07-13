// SPDX-License-Identifier: Apache-2.0
// Channel capability Zod schema + inferred type.
// Channel-shaped runtime metadata; sibling to other domain Zod schemas.
import { z } from "zod";

/**
 * ChannelCapabilitySchema: Runtime-validated metadata describing what a
 * channel adapter supports.
 *
 * Capabilities are self-declared by each channel plugin at registration
 * time and validated with this schema. The system uses capabilities for
 * feature negotiation (e.g. "does this channel support reactions?").
 */
const ChannelFeaturesSchema = z.strictObject({
    reactions: z.boolean().default(false),
    editMessages: z.boolean().default(false),
    deleteMessages: z.boolean().default(false),
    fetchHistory: z.boolean().default(false),
    attachments: z.boolean().default(false),
    /** Whether the channel supports a typing indicator (activity strategy hint). */
    typing: z.boolean().default(false),
    /** Whether the channel supports threads/topics (activity strategy hint). */
    threads: z.boolean().default(false),
    /** Interactive-button capability flavour for this channel: one of
     *  "inline", "components", "blockkit", "quickreply", "adaptivecard",
     *  "cardsv2" (the Cards v2 widget button surface), or "none" when the
     *  platform has no button surface. The default exists only as a safety net
     *  for *new* plugins; in-tree plugins declare it explicitly. */
    buttons: z
      .enum(["inline", "components", "blockkit", "quickreply", "none", "adaptivecard", "cardsv2"])
      .default("none"),
  });

export const ChannelCapabilitySchema = z.strictObject({
    /** Feature flags for optional capabilities */
    features: ChannelFeaturesSchema.default(() => ChannelFeaturesSchema.parse({})),

    /** Platform-specific message size limits */
    limits: z.strictObject({
        maxMessageChars: z.number().positive(),
      }),

    /** Metadata key used for reply-to references (platform-specific) */
    replyToMetaKey: z.string().optional(),

    /** Set reply-to references even on 1:1 (DM) replies. Visible-quote channels
     *  (Telegram/Slack) skip reply-to in DMs to avoid quoting the user's own
     *  message as noise; email needs it always — In-Reply-To/References are
     *  invisible headers a mail client requires to thread the reply. Optional
     *  (absent ⇒ DM reply-to is skipped, the visible-quote default). */
    threadReplyInDm: z.boolean().optional(),
  });

/** Inferred type from ChannelCapabilitySchema */
export type ChannelCapability = z.infer<typeof ChannelCapabilitySchema>;
