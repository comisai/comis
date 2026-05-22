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
  });

/** Inferred type from ChannelCapabilitySchema */
export type ChannelCapability = z.infer<typeof ChannelCapabilitySchema>;
