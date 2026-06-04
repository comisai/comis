// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-pinning RPC contracts.
 * Extracted from memory.ts to keep that file within the 800-line cap.
 *
 * Defines two admin-gated methods:
 *   - `memory.pin`   — mark a memory entry as always-injected in recall.
 *   - `memory.unpin` — remove the always-inject mark.
 *
 * Cross-wave seam: these contracts are defined here in Wave 1 (plan 03-02) but
 * their daemon handlers land in Wave 2 (plan 03-03). They carry
 * `@contract-deferred-handler` annotations to exempt them from
 * contract-handler-parity until the seam is closed. The spread into
 * MEMORY_CONTRACTS and the pnpm contracts:generate run happen in plan 03-03 in
 * the SAME diff as the handler — mirroring the memory-diagnostics pattern.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// @contract-deferred-handler: plan 03-03
export const MemoryPinContract = defineContract({
  method: "memory.pin",
  request: z.object({
    id: z.string().min(1),
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
  }),
  response: z.object({
    pinned: z.literal(true),
    id: z.string(),
  }),
  scopes: ["admin"] as const,
});

// @contract-deferred-handler: plan 03-03
export const MemoryUnpinContract = defineContract({
  method: "memory.unpin",
  request: z.object({
    id: z.string().min(1),
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
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
