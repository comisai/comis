// SPDX-License-Identifier: Apache-2.0
/**
 * Poll domain types: Zod schemas for poll creation input and normalized
 * poll result output across all supported platforms.
 *
 * PollInput validates agent poll creation requests.
 * NormalizedPollResult provides a platform-agnostic representation
 * of poll results (votes, closure state) for cross-platform consistency.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Poll Input (creation)
// ---------------------------------------------------------------------------

export const PollInputSchema = z.strictObject({
  question: z.string().min(1, "Poll question is required"),
  options: z
    .array(z.string().min(1))
    .min(2, "Poll requires at least 2 options")
    .max(10, "Poll allows at most 10 options"),
  maxSelections: z.number().int().min(1).default(1),
  durationHours: z.number().int().min(1).optional(),
});

export type PollInput = z.infer<typeof PollInputSchema>;

// ---------------------------------------------------------------------------
// Normalized Poll Result (cross-platform)
// ---------------------------------------------------------------------------

export const PollOptionResultSchema = z.strictObject({
  text: z.string(),
  voterCount: z.number().int().nonnegative(),
});

export const NormalizedPollResultSchema = z.strictObject({
  pollId: z.string(),
  question: z.string(),
  options: z.array(PollOptionResultSchema),
  totalVoters: z.number().int().nonnegative(),
  isClosed: z.boolean(),
  platform: z.string(),
});

export type NormalizedPollResult = z.infer<typeof NormalizedPollResultSchema>;
export type PollOptionResult = z.infer<typeof PollOptionResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp poll duration to 1-168 hours (Discord constraint).
 * Defaults to 24 hours if undefined.
 */
export function normalizePollDurationHours(hours: number | undefined): number {
  if (hours === undefined) return 24;
  return Math.max(1, Math.min(168, hours));
}

/**
 * Parse and validate poll input. Returns Result with additional check
 * that maxSelections does not exceed options.length.
 */
export function validatePollInput(input: unknown): Result<PollInput, Error> {
  const parsed = PollInputSchema.safeParse(input);
  if (!parsed.success) {
    return err(new Error(parsed.error.issues.map((i) => i.message).join("; ")));
  }
  const data = parsed.data;
  if (data.maxSelections > data.options.length) {
    return err(
      new Error(
        `maxSelections (${data.maxSelections}) must not exceed number of options (${data.options.length})`,
      ),
    );
  }
  return ok(data);
}
