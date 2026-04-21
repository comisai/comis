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
    updatedAt: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().optional(),
    /** Taint level indicating content sanitization status */
    taintLevel: z.enum(["clean", "wrapped", "raw"]).optional(),
    /** Type of source that produced this entry */
    sourceType: z.enum(["system", "conversation", "tool", "web", "api", "unknown"]).optional(),
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
