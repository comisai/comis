import { z } from "zod";

/**
 * Message envelope configuration schema.
 *
 * Controls how inbound user messages are enriched with metadata
 * (provider name, timestamp, elapsed time) before they reach the LLM.
 * The envelope gives the agent conversational awareness about timing,
 * source platform, and relative gaps between messages.
 */
export const EnvelopeConfigSchema = z.strictObject({
    /**
     * Timezone mode for timestamp formatting.
     *
     * - `'utc'`: Format timestamps in UTC (default)
     * - `'local'`: Format timestamps in server-local timezone
     * - Any other string: Treated as IANA timezone (e.g., "America/New_York")
     */
    timezoneMode: z.string().default("utc"),
    /** Time display format: 12-hour or 24-hour clock */
    timeFormat: z.enum(["12h", "24h"]).default("12h"),
    /** Whether to show elapsed time since previous message (e.g., +2m, +1h) */
    showElapsed: z.boolean().default(true),
    /** Whether to show the platform provider prefix (e.g., [telegram], [discord]) */
    showProvider: z.boolean().default(true),
    /**
     * Maximum elapsed time to display in milliseconds.
     * Elapsed times beyond this threshold are omitted (too stale to be useful).
     * Default: 86_400_000 (24 hours).
     */
    elapsedMaxMs: z.number().int().positive().default(86_400_000),
  });

export type EnvelopeConfig = z.infer<typeof EnvelopeConfigSchema>;
