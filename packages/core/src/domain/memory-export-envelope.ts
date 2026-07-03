// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * Wire-format schema for a single exported memory entry.
 * Uses snake_case to match MemoryRowSchema column names (portability file convention).
 * trust_level uses z.string() (not enum) so DB values like "system" are preserved in
 * the file — the import handler caps elevation to "learned" at write time.
 */
export const MemoryExportEntrySchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  trust_level: z.string(),
  memory_type: z.string(),
  tags: z.array(z.string()),
  source_who: z.string(),
  source_channel: z.string().nullable(),
  source_session_key: z.string().nullable(),
  created_at: z.number(),
  occurred_at: z.number().nullable(),
  proof_count: z.number().nullable(),
  source_ids: z.array(z.string()).nullable(),
  confidence: z.number().nullable(),
  observation_kind: z.string().nullable(),
  pattern_type: z.string().nullable(),
});

export const MemoryExportEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal("comis-memory-export-v1"),
  exportedAt: z.number(),
  scope: z.strictObject({
    tenantId: z.string(),
    agentId: z.string().nullable(),
  }),
  entryCount: z.number(),
  entries: z.array(MemoryExportEntrySchema).max(10_000),
});

export type MemoryExportEnvelope = z.infer<typeof MemoryExportEnvelopeSchema>;
export type MemoryExportEntry = z.infer<typeof MemoryExportEntrySchema>;

/**
 * Parse an unknown JSON value as a memory export envelope.
 * Fail-closed: any schemaVersion other than "comis-memory-export-v1" returns err().
 * No multi-version reader — z.literal enforces the single accepted version.
 * Cross-validates entryCount against entries.length — a mismatch is a
 * data-integrity signal (crafted envelope) and is rejected rather than silently accepted.
 */
export function parseMemoryExportEnvelope(raw: unknown): Result<MemoryExportEnvelope, z.ZodError | Error> {
  const result = MemoryExportEnvelopeSchema.safeParse(raw);
  if (!result.success) return err(result.error);
  const env = result.data;
  if (env.entryCount !== env.entries.length) {
    return err(
      new Error(
        `Envelope entryCount (${env.entryCount}) does not match entries array length (${env.entries.length})`,
      ),
    );
  }
  return ok(env);
}
