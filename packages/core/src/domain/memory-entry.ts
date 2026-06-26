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
    /** Event time in epoch ms; distinct from createdAt (record time). Absent when the event time is unknown. */
    occurredAt: z.number().int().positive().optional(),
    /** Evidence count. NULL/absent = raw memory; >=1 = observation. Design §4.3. */
    proofCount: z.number().int().positive().optional(),
    /** Contributing source memory ids. */
    sourceIds: z.array(z.guid()).optional(),
    /** Set when this raw memory was folded into an observation (the consolidation candidate predicate). */
    consolidatedAt: z.number().int().positive().optional(),
    /** Observation confidence 0..1, decays over time. */
    confidence: z.number().min(0).max(1).optional(),
    /** JSON audit trail of prior contents (non-destructive history). */
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
     * Cognitive memory class, classified by the extractor
     * ({@link StructuredMemorySchema.memoryType}, `.default("semantic")`). Persisted to the
     * `memories.memory_type` column (`NOT NULL DEFAULT 'semantic' CHECK(...)`). Additive
     * `.optional()`: an omitting write still defaults to 'semantic' (the column DEFAULT +
     * the adapter's `?? "semantic"` fallback), so existing rows + callers are unaffected.
     */
    memoryType: z.enum(["working", "episodic", "semantic", "procedural"]).optional(),
    /**
     * Reasoning-observation kind. Absent/NULL = "merge" (the default for all
     * rows predating this field; the @comis/memory adapter applies the
     * `?? "merge"` fallback on read). Additive `.optional()` — an omitting write
     * is unaffected; the enum is enforced HERE + the lenient LLM parser,
     * NOT a SQLite CHECK (the occurred_at/proof_count ALTER-ADD-COLUMN no-CHECK
     * precedent — a post-hoc enum CHECK is unreliable across existing rows).
     * "generalization" is the GENERAL-01 (v2.26 Phase 203) higher-order synthesis
     * kind — a `semantic` memory abstracting a cross-context cluster ("user prefers
     * X in general"), written by `runMemoryConsolidation` (Plan 03) with
     * `proofCount = |cluster|` and `sourceIds` retained. The enum stays CLOSED
     * (widened, not `z.string()`); the SQLite `observation_kind` column remains
     * unchecked nullable TEXT, so this is a pure domain-layer widen with NO migration.
     */
    observationKind: z.enum(["merge", "deductive", "inductive", "generalization"]).optional(),
    /**
     * Inductive pattern class (Honcho-derived). Only set when
     * observationKind="inductive". Additive `.optional()` closed enum.
     */
    patternType: z.enum(["preference", "behavior", "personality", "tendency", "correlation"]).optional(),
    /** Pin marker: true = always-inject in recall regardless of fused score.
     *  Absent/undefined = not pinned. The SQLite adapter maps row.pinned === 1 → entry.pinned: true. */
    pinned: z.boolean().optional(),
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
 * Exported so the structured-extraction job can carry the memory's
 * `{ who, channel }` provenance onto each emitted entity mention.
 */
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// ---------------------------------------------------------------------------
// Structured extraction
//
// The background memory-extraction job (`@comis/agent`) replaces flat preference
// strings with zod-validated structured memories `{ content, entities[], occurredAt }`.
// These schemas are the validation boundary the job parses LLM output against.
//
// STRICT vs LENIENT (design §6.1 / RESEARCH Pitfall 5):
//   - LLM-OUTPUT schemas (StructuredMemorySchema, MemoryExtractionResultSchema) are
//     LENIENT `z.object` so a benign extra LLM key (e.g. `confidence`) is STRIPPED,
//     not rejected — a valid memory must not be discarded over an unrequested field.
//   - DOMAIN types (ExtractedEntitySchema, MemoryEntitySchema) are STRICT `z.strictObject`
//     (internal contracts — unknown keys are a bug, not benign drift).
// ---------------------------------------------------------------------------

/**
 * One entity mention emitted by extraction. The extraction job EMITS these
 * (carrying the source memory's inherited trust + source provenance); a later
 * pass persists and resolves them. Minimal shape — just the mention name
 * (design §4.2's entity table is `canonical_name`-only, so there is
 * intentionally no `type` field).
 */
/** LENIENT (live finding 2026-06-11): the extraction LLM naturally emits
 *  `{ name, type: "person" }`; a strictObject rejected the element, which
 *  failed the memory, which failed the WHOLE extraction envelope — a single
 *  typed entity discarded every fact in the batch. Unknown keys are
 *  stripped; `name` stays required + non-empty (there is still no `type`
 *  field in the domain — design §4.2 canonical_name-only). */
export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

/**
 * One structured memory from the extraction LLM call.
 *
 * `occurredAt` is an ISO 8601 STRING as emitted by the LLM (relative dates already
 * converted to absolute in-prompt); the job resolves it to epoch ms
 * post-parse before storing it on {@link MemoryEntrySchema}'s `occurredAt`.
 *
 * LENIENT (`z.object`): unknown keys are stripped, not rejected (Pitfall 5).
 */
export const StructuredMemorySchema = z.object({
  content: z.string().min(1),
  occurredAt: z.string().optional(),
  // Accept BOTH entity shapes (live finding 2026-06-11): the extraction LLM
  // naturally emits plain strings ("entities": ["user", "Biscuit"]) — the
  // shape the prompt's prose implied — while the domain wants { name }.
  // Strings normalize to { name }; objects pass through the lenient schema.
  // Every memory in every live batch failed on this field before the union.
  entities: z
    .array(
      z.union([
        z.string().min(1).transform((name) => ({ name })),
        ExtractedEntitySchema,
      ]),
    )
    .default([]),
  memoryType: z.enum(["working", "episodic", "semantic", "procedural"]).default("semantic"),
  /**
   * Causal cause→effect relations emitted by extraction. The
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
  // LENIENT per-cause object (live finding 2026-06-11 — same class as the
  // entity fix above): extra keys stripped, `effect` still required +
  // non-empty so garbage is rejected without discarding the batch.
  causes: z.array(z.object({ effect: z.string().min(1) })).default([]),
});
export type StructuredMemory = z.infer<typeof StructuredMemorySchema>;

/**
 * The full extraction-call payload: `{ memories: [...] }`. LENIENT envelope so a
 * benign extra top-level key from the LLM does not fail the whole batch.
 */
export const MemoryExtractionResultSchema = z.object({
  memories: z.array(StructuredMemorySchema),
});
export type MemoryExtractionResult = z.infer<typeof MemoryExtractionResultSchema>;

/**
 * MemoryEntity (design §4.3) — the resolved entity persisted into the
 * `memory_entities` table by the entity-resolution pass. Defined here so that
 * pass can import it; the extraction job does NOT persist it (entities are
 * emit-only at extraction time).
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
