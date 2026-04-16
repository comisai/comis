/**
 * Verbosity configuration schema for channel-aware response style hints.
 * Channel-aware response style hints.
 */
import { z } from "zod";

export const VerbosityLevelSchema = z.enum(["auto", "terse", "concise", "standard", "detailed"]);

export const VerbosityOverrideSchema = z.strictObject({
  /** Override verbosity level for this channel. */
  level: VerbosityLevelSchema.optional(),
  /** Target response length in characters. */
  maxResponseChars: z.number().int().positive().optional(),
  /** Whether to use markdown formatting (undefined = no opinion). */
  useMarkdown: z.boolean().optional(),
  /** Whether code blocks are allowed. */
  allowCodeBlocks: z.boolean().optional(),
});

export const VerbosityConfigSchema = z.strictObject({
  /** Whether verbosity hints are enabled for this agent. */
  enabled: z.boolean().default(true),
  /** Default verbosity level. */
  defaultLevel: VerbosityLevelSchema.default("auto"),
  /** Override level for thread messages. */
  threadLevel: VerbosityLevelSchema.optional(),
  /** Per-channel overrides keyed by channelType. */
  overrides: z.record(z.string(), VerbosityOverrideSchema).default({}),
});

export type VerbosityConfig = z.infer<typeof VerbosityConfigSchema>;
export type VerbosityLevel = z.infer<typeof VerbosityLevelSchema>;
export type VerbosityOverride = z.infer<typeof VerbosityOverrideSchema>;
