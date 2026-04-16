/**
 * Rich messaging domain types: Zod schemas for buttons, cards, and effects
 * that enable cross-platform interactive messaging.
 *
 * RichButton supports action buttons with callback data or URLs.
 * RichCard supports embed-style cards with fields and nested buttons.
 * RichEffect supports delivery effects (spoiler, silent notification).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Rich Button
// ---------------------------------------------------------------------------

export const RichButtonSchema = z.strictObject({
  /** Button label text */
  text: z.string(),
  /** Callback identifier for interactive buttons (64-byte Telegram limit) */
  callback_data: z.string().max(64).optional(),
  /** URL for link buttons (mutually exclusive with callback_data) */
  url: z.string().url().optional(),
  /** Visual style hint for platform rendering */
  style: z.enum(["primary", "secondary", "danger", "link"]).default("primary").optional(),
});

export type RichButton = z.infer<typeof RichButtonSchema>;

// ---------------------------------------------------------------------------
// Rich Card
// ---------------------------------------------------------------------------

export const RichCardFieldSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  inline: z.boolean().optional(),
});

export const RichCardSchema = z.strictObject({
  /** Card title */
  title: z.string().optional(),
  /** Card description/body text */
  description: z.string().optional(),
  /** Image URL for card thumbnail/image */
  image_url: z.string().url().optional(),
  /** Color as integer (e.g. 0x0099FF) for embed accent */
  color: z.number().int().optional(),
  /** Structured key-value fields */
  fields: z.array(RichCardFieldSchema).optional(),
  /** Card-level button rows (for Discord embed + button combos) */
  buttons: z.array(z.array(RichButtonSchema)).optional(),
});

export type RichCard = z.infer<typeof RichCardSchema>;

// ---------------------------------------------------------------------------
// Rich Effect
// ---------------------------------------------------------------------------

export const RichEffectSchema = z.enum(["spoiler", "silent"]);

export type RichEffect = z.infer<typeof RichEffectSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate an array of button rows.
 *
 * @param data - Unknown input to validate as RichButton[][]
 * @returns Result with validated button rows or validation error
 */
export function parseRichButtons(data: unknown): Result<RichButton[][], Error> {
  const schema = z.array(z.array(RichButtonSchema));
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return err(new Error(parsed.error.issues.map((i) => i.message).join("; ")));
  }
  return ok(parsed.data);
}

/**
 * Parse and validate an array of rich cards.
 *
 * @param data - Unknown input to validate as RichCard[]
 * @returns Result with validated cards or validation error
 */
export function parseRichCards(data: unknown): Result<RichCard[], Error> {
  const schema = z.array(RichCardSchema);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return err(new Error(parsed.error.issues.map((i) => i.message).join("; ")));
  }
  return ok(parsed.data);
}
