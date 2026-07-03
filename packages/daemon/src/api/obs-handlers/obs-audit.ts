// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.audit.query` RPC handler — the read surface onto the durable
 * `obs_audit_events` table. The SIBLING of
 * `obs-explain.ts` / `fleet-health.ts`: a bounded, admin-gated, content-free
 * query over the persisted security-decision audit (the audit sink + the
 * store's `queryAuditEvents` read).
 *
 * Dual-layer admin gate (cloned verbatim from `fleet-health.ts` /
 * `obs-explain.ts`): the contract is `scopes:["admin"]` (gateway-router primary)
 * AND the handler re-checks `_trustLevel === "admin"` (defense-in-depth).
 * `stripInternalFields` runs BEFORE the contract parse so `_trustLevel` can never
 * be smuggled into the parsed params.
 *
 * Content-free: the rows are exactly the `obs_audit_events` columns
 * scrubbed at write (id / scope ids / closed-enum kind+classification+
 * outcome+severity / a sanitized `refs` JSON blob). There is NO secret `value`
 * field on the row — structural, not a runtime filter.
 *
 * Soft-fail: when `obsStore` is absent (in-memory-only builds) the handler
 * returns an empty `{ rows: [] }` rather than throwing — the `obs.fleet.health`
 * empty-store posture.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import { ObsAuditQueryContract, stripInternalFields } from "@comis/core";
import type { AuditQueryParams } from "@comis/memory";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/**
 * Bind the `obs.audit.query` handler — the admin gate + strip-before-parse +
 * the `queryAuditEvents` read. COMPUTED-KEY form (`[ObsAuditQueryContract.method]`)
 * is MANDATORY — `api-contracts-bidirectional.test.ts` + `contract-handler-parity`
 * only recognize the computed key, not a `"obs.audit.query":` string literal
 * (the `fleet-health.ts` precedent).
 *
 * @param deps - the shared obs-handler deps; `deps.obsStore` exposes the
 *   `queryAuditEvents(params)` read. Absent ⇒ an empty result.
 */
export function bindObsAuditHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  return {
    [ObsAuditQueryContract.method]: async (rawParams) => {
      // Admin check (defense-in-depth; gateway-router is the primary gate).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      // stripInternalFields BEFORE contract parse — `_trustLevel` cannot be
      // smuggled into the parsed params (or the result).
      const params = ObsAuditQueryContract.request.parse(stripInternalFields(rawParams));

      // Soft-fail: no store ⇒ an honest empty result (the fleet-health posture).
      if (deps.obsStore === undefined) {
        return { rows: [] };
      }

      // The store's queryAuditEvents takes the AuditQueryParams filter shape (every
      // field optional; absent widens the scan). Build it only from the parsed,
      // already-stripped params — the limit is clamped store-side
      // (default 200, hard ceiling 1000). The rows are content-free by construction.
      const queryParams: AuditQueryParams = {
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.classification !== undefined ? { classification: params.classification } : {}),
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.tenant !== undefined ? { tenant: params.tenant } : {}),
        ...(params.outcome !== undefined ? { outcome: params.outcome } : {}),
        ...(params.since !== undefined ? { since: params.since } : {}),
        ...(params.until !== undefined ? { until: params.until } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      };

      // The store returns typed AuditEventRow[] (content-free). The wire contract
      // models `rows` as the loose-record array (the ObsRecordArray convention),
      // so the typed rows ride it directly — the row TYPE is the authoritative
      // shape (mirrored by AuditEventRowWire); this is the wire-boundary narrowing.
      const result = { rows: deps.obsStore.queryAuditEvents(queryParams) };

      // Dev-mode response validation (catches field type regressions in dev only).
      if (IS_DEV) ObsAuditQueryContract.response.parse(result);
      return result;
    },
  };
}
