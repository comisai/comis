// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.explain` RPC handler — IncidentReport assembler (Phase 153 centerpiece).
 *
 * STUB (Wave 1 / Plan 01): admin-check + request validation, then throws
 * `not yet implemented`. This keeps the `api-contracts-bidirectional` 1:1
 * gate green (one handler keyed by `ObsExplainContract.method`) while the
 * shared contract shapes land. Plan 05 (Wave 4, `depends_on` 01) REPLACES the
 * body with the full resolver → readers → assembler → heuristics → bounding
 * pipeline; the `index.ts` wiring stays.
 *
 * @module
 */

import { ObsExplainContract, stripInternalFields } from "@comis/core";
import type { RpcHandler } from "../types.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

/**
 * Bind the `obs.explain` handler.
 *
 * STUB: validates admin scope + request shape, then throws. Plan 05 supplies
 * the assembler body. The `deps` are accepted (and unused here) so the
 * signature matches the other `bindObs*Handlers` factories the index spreads.
 */
export function bindObsExplainHandlers(
  _deps: ObsHandlerDeps,
): Record<string, RpcHandler> {
  return {
    [ObsExplainContract.method]: async (rawParams) => {
      // Admin check (defense-in-depth; gateway-router is the primary gate).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as
        | string
        | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      // stripInternalFields BEFORE contract parse — `_trustLevel` cannot be
      // smuggled into the parsed params.
      ObsExplainContract.request.parse(stripInternalFields(rawParams));

      // Plan 05 replaces this body with the assembler pipeline.
      throw new Error("obs.explain not yet implemented");
    },
  };
}
