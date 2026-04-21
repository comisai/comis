// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Activation mode for group chats.
 *
 * - `always`: Agent responds to every group message
 * - `mention-gated`: Agent responds only when @mentioned or replied to
 * - `custom`: Agent responds when message matches a custom regex pattern
 */
export const GroupActivationModeSchema = z
  .enum(["always", "mention-gated", "custom"])
  .default("mention-gated");

/**
 * Auto-reply engine configuration.
 *
 * Controls whether the agent pipeline activates for inbound messages.
 * This is SEPARATE from the pattern-based auto-reply rules in
 * `schema-integrations.ts` (which map patterns to template responses).
 * The engine determines "should the agent activate at all?" while the
 * integration auto-reply is "respond with a template if pattern matches."
 */
export const AutoReplyEngineConfigSchema = z.strictObject({
    /** Enable the auto-reply engine (default: true) */
    enabled: z.boolean().default(true),
    /** Activation mode for group messages (DMs always activate) */
    groupActivation: GroupActivationModeSchema,
    /** Custom regex patterns for "custom" mode (matched against message text) */
    customPatterns: z.array(z.string().min(1)).default([]),
    /** Inject non-trigger group messages as context history */
    historyInjection: z.boolean().default(true),
    /** Maximum history-injected messages per session (prevents unbounded growth) */
    maxHistoryInjections: z.number().int().positive().default(50),
    /** Maximum group history messages stored per session (ring buffer depth) */
    maxGroupHistoryMessages: z.number().int().positive().default(20),
  });

export type AutoReplyEngineConfig = z.infer<typeof AutoReplyEngineConfigSchema>;
export type GroupActivationMode = z.infer<typeof GroupActivationModeSchema>;
