// SPDX-License-Identifier: Apache-2.0
/**
 * Pure row-mapper + column-parse helpers extracted from `lcd-store.ts` to keep
 * the store factory under its architecture line cap. Every export here is a
 * `createRowMapper(z.strictObject)` mapper (degrade-to-[]/undefined, never
 * throws; strictObject rejects extra columns = drift detection) or a small
 * value-preserving column parser. No database handle, no clock, no logger —
 * the same statelessness `createLcdStore` itself assumes.
 *
 * @module
 */

import { partsToMessage, type LcdMessage, type LcdPartMetadata } from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import {
  LcdContextItemRowSchema,
  LcdMessageRowSchema,
  LcdMessagePartRowSchema,
  LcdSummaryRowSchema,
} from "./row-schemas.js";

/**
 * The named pi-ai reconstruction entry point for the LCD store (F2/F3).
 *
 * `getMessages` returns the faithful `LcdMessage` DTO rows; turning one back
 * into a canonical pi-ai `Message` is the consumer's step — Phase-128 assembly
 * calls this. It delegates to the core `partsToMessage` codec (the single
 * pi-ai-typed seam) rather than duplicating the per-block reconstruction in the
 * store; it is exposed here so consumers reconstruct via one named function
 * co-located with the store that produced the rows.
 */
export function reconstructLcdMessage(message: LcdMessage): Message {
  return partsToMessage(message);
}

// Row mappers (createRowMapper(z.strictObject) — degrade to [] on validation
// failure, never throw; strictObject rejects extra columns = drift detection).
export const messageRowMapper = createRowMapper(LcdMessageRowSchema);
export const partRowMapper = createRowMapper(LcdMessagePartRowSchema);
export const ctxItemRowMapper = createRowMapper(LcdContextItemRowSchema);
export const summaryRowMapper = createRowMapper(LcdSummaryRowSchema);

/** Projection for the lazy-seed / range-coverage read: message id + createdAt, seq-ordered. */
const MessageSeedRowSchema = z.strictObject({ id: z.string(), created_at: z.number() });
export const messageSeedRowMapper = createRowMapper(MessageSeedRowSchema);

/** Single-column ordinal projection for the dense-shift pass (no `as` cast — untyped-sqlite rule). */
const CtxOrdinalRowSchema = z.strictObject({ ordinal: z.number() });
export const ctxOrdinalRowMapper = createRowMapper(CtxOrdinalRowSchema);

/**
 * Single-column COUNT projection — the sanctioned createRowMapper read replacing
 * the raw count cast the §6.8 untyped-sqlite rule forbids. Used for the
 * context_items seed gate (the legacy-conversation backfill trigger).
 */
const CtxCountRowSchema = z.strictObject({ c: z.number() });
export const ctxCountRowMapper = createRowMapper(CtxCountRowSchema);

/**
 * `MAX(ordinal)` projection for the per-append dense-view maintenance (CRIT-2).
 * `MAX` over zero rows returns SQL NULL → `maxOrdinal` is nullable; the next
 * ordinal is `(maxOrdinal ?? -1) + 1` (0 for the first row). No `as` cast.
 */
const CtxMaxOrdinalRowSchema = z.strictObject({ maxOrdinal: z.number().nullable() });
export const ctxMaxOrdinalRowMapper = createRowMapper(CtxMaxOrdinalRowSchema);

/** Single-column message-id projection for the E1 leaf→message walk (no `as` cast). */
const SummaryMessageIdRowSchema = z.strictObject({ message_id: z.string() });
export const summaryMessageIdRowMapper = createRowMapper(SummaryMessageIdRowSchema);

/**
 * Single-column rowid projection for the contentless-FTS populate (WR-03 — the
 * sanctioned `createRowMapper(z.strictObject)` read replacing the raw
 * `as { rowid: number } | undefined` cast the §6.8 untyped-sqlite rule forbids).
 */
const MessageRowidRowSchema = z.strictObject({ rowid: z.number() });
export const messageRowidRowMapper = createRowMapper(MessageRowidRowSchema);

/**
 * Phase 164 (RR1): cursor row schema — two projected columns only
 * (`epoch_anchor` + `ingested_live_len`). Uses `z.strictObject` (drift
 * detection) and `createRowMapper` (degrade-to-undefined, never throws) —
 * the same pattern as every other row mapper in this module.
 */
const CursorRowSchema = z.strictObject({ epoch_anchor: z.string(), ingested_live_len: z.number() });
export const cursorRowMapper = createRowMapper(CursorRowSchema);

/** The verbatim canonical block is opaque at the row layer (F1). */
const LcdPartMetadataSchema = z.looseObject({
  raw: z.unknown(),
  rawType: z.string().optional(),
  topLevelReasoningOnly: z.boolean().optional(),
  messageEnvelope: z.unknown().optional(),
  envelopeCarrier: z.boolean().optional(),
});

/**
 * Parse the JSON `metadata` column with graceful degradation (T-127-10 /
 * ASVS V5): a corrupt/poisoned persisted block degrades `raw` to undefined and
 * NEVER throws — a malformed row can not crash reconstruction.
 */
export function parseMetadata(raw: string): LcdPartMetadata {
  try {
    const result = LcdPartMetadataSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as LcdPartMetadata) : { raw: undefined };
  } catch {
    return { raw: undefined };
  }
}

/** Parse a nullable JSON column (tool_input / tool_output) — degrade to undefined. */
export function parseJsonColumn(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** SQLite NULL/0/1 INTEGER -> boolean | undefined (NULL for non-tool_result parts). */
export function intToBool(value: number | null): boolean | undefined {
  return value === null ? undefined : value !== 0;
}

/** boolean | undefined -> SQLite NULL/0/1 INTEGER for the is_error column. */
export function boolToInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/** Parse the JSON `file_ids` column to a string[] — degrade to [] on corruption. */
export function parseFileIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
