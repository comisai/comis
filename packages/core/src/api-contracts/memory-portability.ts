// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-portability RPC contracts.
 * Extracted from memory.ts to keep that file within the 800-line cap.
 *
 * Defines two admin-gated methods:
 *   - `memory.portability.export` — versioned, secret-scrubbed envelope export.
 *   - `memory.portability.import` — firewalled import from comis-memory-export-v1.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// memory.portability.export — versioned, secret-scrubbed envelope export
// ---------------------------------------------------------------------------

/**
 * `memory.portability.export` — export all memory entries for a scope as a
 * versioned `comis-memory-export-v1` envelope, with every content field
 * scrubbed through `scrubSecretsFromText` before inclusion.
 *
 * Admin-gated. Daemon returns the scrubbed payload over RPC; the CLI writes
 * the JSON file locally (avoids the `node --permission` fd-fs restriction on
 * the daemon side).
 *
 * Response: `{ schemaVersion, exportedAt, scope, entryCount, entries[] }`.
 */
export const MemoryPortabilityExportContract = defineContract({
  method: "memory.portability.export",
  request: z.object({
    agent_id: z.string().min(1),
    tenant_id: z.string().min(1),
    limit: z.number().int().positive().optional(),
  }),
  response: z.object({
    schemaVersion: z.literal("comis-memory-export-v1"),
    exportedAt: z.number(),
    scope: z.object({
      tenantId: z.string(),
      agentId: z.string(),
    }),
    entryCount: z.number(),
    entries: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.portability.import — firewalled import from comis-memory-export-v1 envelope
// ---------------------------------------------------------------------------

/**
 * `memory.portability.import` — import entries from a `comis-memory-export-v1`
 * envelope into a target agent scope, routing every entry through
 * `validateMemoryWrite` before storage.
 *
 * Security invariants:
 * - CRITICAL entries are blocked (skipped via `continue`) — never persisted.
 * - WARN entries are stored at `external` trust with a `security-tainted` tag.
 * - `tenantId`/`agentId` are always re-stamped from authenticated RPC params —
 *   the envelope's scope field is never trusted.
 * - Trust cap: imported entries can never land at `"system"` trust.
 * - `dry_run: true` runs the full validator but skips all `memoryAdapter.store`
 *   calls, accumulating accurate blocked/downgraded counts.
 *
 * Admin-gated. Entries array capped at 10,000 (DoS guard).
 */
export const MemoryPortabilityImportContract = defineContract({
  method: "memory.portability.import",
  request: z.object({
    entries: z.array(z.record(z.string(), z.unknown())).max(10_000),
    agent_id: z.string().min(1),
    tenant_id: z.string().min(1),
    dry_run: z.boolean().optional(),
  }),
  response: z.object({
    imported: z.number(),
    blocked: z.number(),
    downgraded: z.number(),
    /** Entries skipped because their content already exists in the target scope
     *  (idempotent re-import — re-importing an export does not duplicate; a deleted
     *  memory is still restored since its content is absent). */
    deduped: z.number(),
    total: z.number(),
    dryRun: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

/** Per-domain slice array for the portability contracts. */
export const MEMORY_PORTABILITY_CONTRACTS = [
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
] as const;
