// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.cacheBreaks.byReason` RPC handler — the read surface onto the cache-break
 * rate by reason + the $-lost SUM. The SIBLING of
 * `obs-audit.ts`: a bounded, admin-gated, content-free GROUP BY over the existing
 * `category:'cache_break'` `obs_diagnostics` index. The
 * web UI's Cache Health view consumes it.
 *
 * Dual-layer admin gate (cloned verbatim from `obs-audit.ts`): the contract is
 * `scopes:["admin"]` (gateway-router primary) AND the handler re-checks
 * `_trustLevel === "admin"` (defense-in-depth). `stripInternalFields` runs BEFORE
 * the contract parse so `_trustLevel` can never be smuggled into the parsed params.
 *
 * Content-free: the rows are exactly the GROUP BY projection — a closed
 * cache-break `reason` label + a `count` + the summed `estCostUsd` ($-lost). No
 * message/body/query/secret crosses the boundary — structural, not a runtime filter.
 *
 * Soft-fail: when `obsStore` is absent (in-memory-only builds) the handler returns
 * an empty `{ rows: [] }` rather than throwing — the `obs.audit.query` posture.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import { ObsCacheBreaksByReasonContract, stripInternalFields } from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/**
 * Bind the `obs.cacheBreaks.byReason` handler — the admin gate + strip-before-
 * parse + the `queryCacheBreaksByReason` read. COMPUTED-KEY form
 * (`[ObsCacheBreaksByReasonContract.method]`) is MANDATORY — the parity gates
 * recognize only the computed key (the `obs-audit.ts` precedent).
 *
 * @param deps - the shared obs-handler deps; `deps.obsStore` exposes the
 *   `queryCacheBreaksByReason(params)` read. Absent ⇒ an empty result.
 */
export function bindObsCacheBreaksHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  return {
    [ObsCacheBreaksByReasonContract.method]: async (rawParams) => {
      // Admin check (defense-in-depth; gateway-router is the primary gate).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      // stripInternalFields BEFORE contract parse — `_trustLevel` cannot be
      // smuggled into the parsed params (or the result).
      const params = ObsCacheBreaksByReasonContract.request.parse(stripInternalFields(rawParams));

      // Soft-fail: no store ⇒ an honest empty result (the obs.audit.query posture).
      if (deps.obsStore === undefined) {
        return { rows: [] };
      }

      // Build the optional window filter from the parsed, already-stripped params.
      // Reference each request field (since / until) by literal name so the
      // contract-handler-parity gate sees them (the obs-audit.ts spread mold).
      const queryParams: { since?: number; until?: number } = {
        ...(params.since !== undefined ? { since: params.since } : {}),
        ...(params.until !== undefined ? { until: params.until } : {}),
      };

      // The store returns typed CacheBreakReasonRate[] (content-free: reason + two
      // numbers). The wire contract models `rows` as the loose-record array (the
      // ObsRecordArray convention), so the typed rows ride it directly.
      const result = { rows: deps.obsStore.queryCacheBreaksByReason(queryParams) };

      // Dev-mode response validation (catches field type regressions in dev only).
      if (IS_DEV) ObsCacheBreaksByReasonContract.response.parse(result);
      return result;
    },
  };
}
