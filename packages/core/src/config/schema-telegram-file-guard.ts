// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Telegram file reference guard configuration schema.
 *
 * Detects when the LLM hallucinates file paths or references in responses
 * destined for Telegram (where file:// links are meaningless). The guard
 * can strip or annotate such references before delivery.
 *
 * Enabled by default for Telegram channels.
 */
export const TelegramFileRefGuardConfigSchema = z.strictObject({
  /** Whether the file reference guard is active */
  enabled: z.boolean().default(true),
  /** Additional file extensions to detect beyond the built-in curated set */
  additionalExtensions: z.array(z.string()).default([]),
  /** File extensions to exclude from guard detection */
  excludedExtensions: z.array(z.string()).default([]),
});

export type TelegramFileRefGuardConfig = z.infer<typeof TelegramFileRefGuardConfigSchema>;
