// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * Trust levels for memory entries.
 *
 * - `system`: Injected by the platform (highest trust, never overwritten by user)
 * - `learned`: Derived from conversation or observation
 * - `external`: Sourced from external tools, APIs, or web content (lowest trust)
 *
 * Trust partitioning prevents memory poisoning via indirect prompt injection.
 */
export const TrustLevelSchema = z.enum(["system", "learned", "external"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

/**
 * Source provenance: who created this entry and through which channel.
 */
export const MemorySourceSchema = z.strictObject({
    who: z.string(),
    channel: z.string().optional(),
    sessionKey: z.string().optional(),
  });

/**
 * MemoryEntry: A single unit of persisted agent memory.
 *
 * Memories are the backbone of Comis's long-term context. Each entry
 * carries trust-level provenance to mitigate memory poisoning attacks.
 */
export const MemoryEntrySchema = z.strictObject({
    id: z.guid(),
    tenantId: z.string().min(1).default("default"),
    /** Agent that created this memory entry (enables per-agent memory isolation) */
    agentId: z.string().min(1).default("default"),
    userId: z.string().min(1),
    content: z.string().min(1),
    embedding: z.array(z.number()).optional(),
    trustLevel: TrustLevelSchema,
    source: MemorySourceSchema,
    tags: z.array(z.string()).default([]),
    createdAt: z.number().int().positive(),
    /** Event time in epoch ms (P81/TEMP-01); distinct from createdAt (record time). Absent when the event time is unknown. */
    occurredAt: z.number().int().positive().optional(),
    /** Evidence count (P84/CONS-01). NULL/absent = raw memory; >=1 = observation. Design §4.3. */
    proofCount: z.number().int().positive().optional(),
    /** Contributing source memory ids (P84/CONS-01). */
    sourceIds: z.array(z.guid()).optional(),
    /** Set when this raw memory was folded into an observation (P84/CONS-04/05 candidate predicate). */
    consolidatedAt: z.number().int().positive().optional(),
    /** Observation confidence 0..1 (P84/CONS-08), decays over time. */
    confidence: z.number().min(0).max(1).optional(),
    /** JSON audit trail of prior contents (P84/CONS-05 non-destructive history). */
    history: z
      .array(z.strictObject({ previousContent: z.string(), changedAt: z.number().int().positive() }))
      .optional(),
    updatedAt: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().optional(),
    /** Taint level indicating content sanitization status */
    taintLevel: z.enum(["clean", "wrapped", "raw"]).optional(),
    /** Type of source that produced this entry */
    sourceType: z.enum(["system", "conversation", "tool", "web", "api", "unknown"]).optional(),
    /**
     * Cognitive memory class (P95/LANES-03), classified by the extractor
     * ({@link StructuredMemorySchema.memoryType}, `.default("semantic")`). Persisted to the
     * `memories.memory_type` column (`NOT NULL DEFAULT 'semantic' CHECK(...)`). Additive
     * `.optional()`: an omitting write still defaults to 'semantic' (the column DEFAULT +
     * the adapter's `?? "semantic"` fallback), so existing rows + callers are unaffected.
     */
    memoryType: z.enum(["working", "episodic", "semantic", "procedural"]).optional(),
  });

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/**
 * Parse unknown input into a MemoryEntry, returning Result<T, ZodError>.
 */
export function parseMemoryEntry(raw: unknown): Result<MemoryEntry, z.ZodError> {
  const result = MemoryEntrySchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

/**
 * Source provenance type (inferred from {@link MemorySourceSchema}).
 *
 * Exported so the structured-extraction job (Phase 82, EXTR-04) can carry the
 * memory's `{ who, channel }` provenance onto each emitted entity mention.
 */
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// ---------------------------------------------------------------------------
// Structured extraction (Phase 82 — EXTR-01/EXTR-04)
//
// The background memory-extraction job (`@comis/agent`) replaces flat preference
// strings with zod-validated structured memories `{ content, entities[], occurredAt }`.
// These schemas are the EXTR-01 validation boundary the job parses LLM output against.
//
// STRICT vs LENIENT (design §6.1 / RESEARCH Pitfall 5):
//   - LLM-OUTPUT schemas (StructuredMemorySchema, MemoryExtractionResultSchema) are
//     LENIENT `z.object` so a benign extra LLM key (e.g. `confidence`) is STRIPPED,
//     not rejected — a valid memory must not be discarded over an unrequested field.
//   - DOMAIN types (ExtractedEntitySchema, MemoryEntitySchema) are STRICT `z.strictObject`
//     (internal contracts — unknown keys are a bug, not benign drift).
// ---------------------------------------------------------------------------

/**
 * One entity mention emitted by extraction. Phase 82 EMITS these (carrying the
 * source memory's inherited trust + source provenance, EXTR-04); Phase 83 persists
 * and resolves them. Minimal shape — just the mention name (design §4.2's entity
 * table is `canonical_name`-only, so there is intentionally no `type` field).
 */
export const ExtractedEntitySchema = z.strictObject({
  name: z.string().min(1),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

/**
 * One structured memory from the extraction LLM call.
 *
 * `occurredAt` is an ISO 8601 STRING as emitted by the LLM (relative dates already
 * converted to absolute in-prompt, EXTR-02); the job resolves it to epoch ms
 * post-parse before storing it on {@link MemoryEntrySchema}'s `occurredAt`.
 *
 * LENIENT (`z.object`): unknown keys are stripped, not rejected (Pitfall 5).
 */
export const StructuredMemorySchema = z.object({
  content: z.string().min(1),
  occurredAt: z.string().optional(),
  entities: z.array(ExtractedEntitySchema).default([]),
  memoryType: z.enum(["working", "episodic", "semantic", "procedural"]).default("semantic"),
  /**
   * Causal cause→effect relations emitted by extraction (P96/EXTRACT-03). The
   * fact stated in `content` is the CAUSE; each entry's `effect` is a consequence
   * stated as a concise fact (A2 — the cause is the memory's own content, so the
   * just-stored memory id is the resolved edge source). ADDITIVE: `.default([])`
   * — an extraction that omits it is unaffected, and the LENIENT `z.object`
   * envelope (above) still STRIPS a benign extra key rather than rejecting it.
   * The per-cause object is `z.strictObject` with a typed `effect: string.min(1)`
   * so garbage is still rejected (an empty/non-string/extra-key entry fails) —
   * injection-safe: untrusted conversation content cannot forge a malformed edge.
   * The edge links MEMORY ids; the `effect` text is resolved to a stored memory
   * id by the @comis/memory adapter (scoped FTS top-1) on the agent-side write.
   */
  causes: z.array(z.strictObject({ effect: z.string().min(1) })).default([]),
});
export type StructuredMemory = z.infer<typeof StructuredMemorySchema>;

/**
 * The full extraction-call payload: `{ memories: [...] }`. LENIENT envelope so a
 * benign extra top-level key from the LLM does not fail the whole batch (EXTR-01/05).
 */
export const MemoryExtractionResultSchema = z.object({
  memories: z.array(StructuredMemorySchema),
});
export type MemoryExtractionResult = z.infer<typeof MemoryExtractionResultSchema>;

/**
 * MemoryEntity (design §4.3) — the resolved entity Phase 83 persists into the
 * `memory_entities` table. Defined now so Phase 83 imports it; Phase 82 does NOT
 * persist it (no entity table exists yet — entities are emit-only this phase).
 *
 * STRICT (`z.strictObject`): the persisted domain contract.
 */
export const MemoryEntitySchema = z.strictObject({
  id: z.guid(),
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  canonicalName: z.string().min(1),
  mentionCount: z.number().int().positive(),
  firstSeen: z.number().int().positive(),
  lastSeen: z.number().int().positive(),
});
export type MemoryEntity = z.infer<typeof MemoryEntitySchema>;
