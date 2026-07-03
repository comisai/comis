// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Memory-pinning RPC handler module.
 * Handles memory.pin and memory.unpin methods.
 * Extracted from memory-handlers.ts to keep both files within the 800-line cap.
 * Composed back into createMemoryHandlers via object spread.
 *
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  MemoryPinContract,
  MemoryUnpinContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";

import type { RpcHandler } from "./types.js";
import type { MemoryApiDeps as MemoryHandlerDeps } from "./types.js";

/**
 * Returns a partial handler record containing only the two pinning methods.
 * Composed into createMemoryHandlers via spread.
 */
export function createMemoryPinningHandlers(
  deps: MemoryHandlerDeps,
): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // memory.pin — mark a memory entry as always-injected in recall.
    // Admin-gated. Idempotent: ok(false) if the id does not exist.
    // -----------------------------------------------------------------------

    [MemoryPinContract.method]: async (rawParams) => {
      // Admin gate FIRST — before stripInternalFields (which strips _trustLevel).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required for memory pin");

      const start = systemNowMs();
      const p = MemoryPinContract.request.parse(stripInternalFields(rawParams));
      const tenantId = p.tenant_id ?? deps.tenantId;
      // Forward agent_id from the request so the UPDATE is scoped
      // to (id, tenant_id, agent_id) — cross-agent pinning within a tenant is impossible.
      const agentId = p.agent_id;

      const r = await deps.memoryApi.pin(p.id, tenantId, agentId);
      if (!r.ok) {
        deps.logger?.warn(
          {
            err: r.error,
            hint: "Memory pin failed; check database integrity",
            errorKind: "internal" as const,
            step: "memory-pin",
            durationMs: systemNowMs() - start,
          },
          "Memory pin failed",
        );
        throw r.error;
      }

      deps.logger?.info(
        {
          id: p.id,
          tenantId,
          agentId,
          found: r.value,
          durationMs: systemNowMs() - start,
          step: "memory-pin",
        },
        "Memory pin complete",
      );

      // Surface `found` in the wire response so callers can distinguish
      // "pinned" from "id not found". found=true: row existed; found=false: not found.
      return { pinned: true as const, found: r.value, id: p.id };
    },

    // -----------------------------------------------------------------------
    // memory.unpin — remove the always-inject mark from a memory entry.
    // Admin-gated. Idempotent: ok(false) if the id does not exist.
    // -----------------------------------------------------------------------

    [MemoryUnpinContract.method]: async (rawParams) => {
      // Admin gate FIRST — before stripInternalFields (which strips _trustLevel).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required for memory unpin");

      const start = systemNowMs();
      const p = MemoryUnpinContract.request.parse(stripInternalFields(rawParams));
      const tenantId = p.tenant_id ?? deps.tenantId;
      // Forward agent_id from the request so the UPDATE stays agent-scoped.
      const agentId = p.agent_id;

      const r = await deps.memoryApi.unpin(p.id, tenantId, agentId);
      if (!r.ok) {
        deps.logger?.warn(
          {
            err: r.error,
            hint: "Memory unpin failed; check database integrity",
            errorKind: "internal" as const,
            step: "memory-unpin",
            durationMs: systemNowMs() - start,
          },
          "Memory unpin failed",
        );
        throw r.error;
      }

      deps.logger?.info(
        {
          id: p.id,
          tenantId,
          agentId,
          found: r.value,
          durationMs: systemNowMs() - start,
          step: "memory-unpin",
        },
        "Memory unpin complete",
      );

      return { unpinned: true as const, id: p.id };
    },
  };
}
