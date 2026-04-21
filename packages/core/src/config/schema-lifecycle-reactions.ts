// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Timing thresholds for lifecycle reaction state transitions.
 *
 * Controls debounce to prevent flicker, hold duration for terminal
 * states, and soft/hard stall detection thresholds.
 */
export const LifecycleReactionsTimingSchema = z.strictObject({
  /** Debounce period (ms) before committing a phase transition emoji */
  debounceMs: z.number().int().nonnegative().default(700),
  /** How long (ms) to hold done emoji before cleanup */
  holdDoneMs: z.number().int().nonnegative().default(3000),
  /** How long (ms) to hold error emoji before cleanup */
  holdErrorMs: z.number().int().nonnegative().default(5000),
  /** Soft stall warning threshold (ms) -- emits reaction:stall_detected with severity "soft" */
  stallSoftMs: z.number().int().positive().default(15000),
  /** Hard stall warning threshold (ms) -- emits reaction:stall_detected with severity "hard" */
  stallHardMs: z.number().int().positive().default(30000),
});

/**
 * Per-channel overrides for lifecycle reaction behavior.
 *
 * Allows individual channels to opt in/out or use a different emoji tier
 * without affecting the global default.
 */
export const LifecycleReactionsPerChannelSchema = z.strictObject({
  /** Override enabled state for this channel (omit to use global) */
  enabled: z.boolean().optional(),
  /** Override emoji tier for this channel (omit to use global) */
  emojiTier: z.enum(["unicode", "platform", "custom"]).optional(),
});

/**
 * Lifecycle status reactions configuration schema.
 *
 * When enabled, the agent reacts to its own processing messages with emoji
 * that reflect the current phase (thinking, tool use, generating, done, error).
 * Emoji tier selects between simple Unicode, platform-native, or custom emoji.
 */
export const LifecycleReactionsConfigSchema = z.strictObject({
  /** Whether lifecycle reactions are enabled globally */
  enabled: z.boolean().default(false),
  /** Emoji set to use: unicode (cross-platform), platform (channel-native), or custom */
  emojiTier: z.enum(["unicode", "platform", "custom"]).default("unicode"),
  /** Timing thresholds for debounce, hold, and stall detection */
  timing: LifecycleReactionsTimingSchema.default(() => LifecycleReactionsTimingSchema.parse({})),
  /** Per-channel overrides keyed by channel type (e.g., "telegram", "discord") */
  perChannel: z.record(z.string(), LifecycleReactionsPerChannelSchema).default({}),
});

export type LifecycleReactionsConfig = z.infer<typeof LifecycleReactionsConfigSchema>;
export type LifecycleReactionsTimingConfig = z.infer<typeof LifecycleReactionsTimingSchema>;
