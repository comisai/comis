// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-pinning RPC contracts.
 * Extracted from memory.ts to keep that file within the 800-line cap.
 *
 * Defines two admin-gated methods:
 *   - `memory.pin`   — mark a memory entry as always-injected in recall.
 *   - `memory.unpin` — remove the always-inject mark.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

export const MemoryPinContract = defineContract({
  method: "memory.pin",
  request: z.object({
    id: z.string().min(1),
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  response: z.object({
    pinned: z.literal(true),
    // `found` surfaces whether the memory row existed in the caller's scope.
    // found=true: row found and pinned. found=false: id not found (pin was a no-op).
    // Callers that only inspect `pinned` are unaffected (additive field).
    found: z.boolean(),
    id: z.string(),
  }),
  scopes: ["admin"] as const,
});

export const MemoryUnpinContract = defineContract({
  method: "memory.unpin",
  request: z.object({
    id: z.string().min(1),
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  response: z.object({
    unpinned: z.literal(true),
    id: z.string(),
  }),
  scopes: ["admin"] as const,
});

/** Per-domain slice array for the pinning contracts. */
export const MEMORY_PINNING_CONTRACTS = [
  MemoryPinContract,
  MemoryUnpinContract,
] as const;
