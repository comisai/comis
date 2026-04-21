// SPDX-License-Identifier: Apache-2.0
/**
 * Notification configuration schema for proactive notifications.
 *
 * Controls per-agent notification behavior: rate limiting, deduplication,
 * primary delivery channel, and notification chain depth.
 *
 * Rate limiting and channel resolution config.
 */
import { z } from "zod";

export const NotificationConfigSchema = z.strictObject({
  /** Whether proactive notifications are enabled for this agent. */
  enabled: z.boolean().default(true),
  /** Maximum notifications per hour (rolling window). Must be positive. */
  maxPerHour: z.number().int().positive().default(30),
  /** Deduplication window in milliseconds. 0 disables dedup. */
  dedupeWindowMs: z.number().int().nonnegative().default(300_000),
  /** Preferred delivery channel. Falls back to session-based resolution if unset. */
  primaryChannel: z.strictObject({
    channelType: z.string().min(1),
    channelId: z.string().min(1),
  }).optional(),
  /** Maximum notification chain depth (0 = no chaining). */
  maxChainDepth: z.number().int().nonnegative().default(0),
});

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
