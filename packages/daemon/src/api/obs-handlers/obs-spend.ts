// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.spend.snapshot` RPC handler — the read surface onto the LIVE spend the
 * dollars kill-switch enforces. The SIBLING of
 * `obs-audit.ts`: a bounded, admin-gated, content-free read.
 *
 * Reads the LIVE `spendAccumulator.getSnapshot()` threaded
 * into `ObservabilityApiDeps.spendSnapshot` (the kill-switch value), NOT the
 * lagging SQL `getRollingSpendUsd` — the Spend & Governance view must agree with
 * `comis fleet` / the kill-switch. The configured ceilings ride alongside so the
 * handler computes per-scope `headroomUsd = capUsd − spentUsd` (null when that
 * ceiling dimension is off). The three-state pricing-coverage count (priced / free
 * / unknown) comes from `obsStore.pricingCoverage()` so a finance review sees how
 * trustworthy the dollars are.
 *
 * Dual-layer admin gate (same pattern as `obs-audit.ts`): the contract is
 * `scopes:["admin"]` AND the handler re-checks `_trustLevel === "admin"`.
 * `stripInternalFields` runs BEFORE the contract parse.
 *
 * Content-free: scope KEYS (the `${tenantId} ${agentId}` / tenant
 * counter keys — config ids, never user content) + dollar/count NUMBERS + pricing
 * enums ONLY. No message/body/query/secret crosses the boundary.
 *
 * Honest-degradation: when NEITHER the live snapshot NOR the store is present the
 * handler returns `{ snapshot: { enabled: false } }` — never a misleading $0
 * success (the honest-degradation invariant).
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import { ObsSpendSnapshotContract, stripInternalFields } from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/** Headroom = ceiling − spent; null when that ceiling dimension is off (null). */
function headroom(spentUsd: number, capUsd: number | null): number | null {
  return capUsd === null ? null : capUsd - spentUsd;
}

/**
 * One content-free per-scope spend row: the scope key + the spent total + its
 * ceiling (null = off) + the derived headroom (null when the ceiling is off).
 */
function scopeRows(
  totals: ReadonlyMap<string, number>,
  capUsd: number | null,
): Array<{ scope: string; spentUsd: number; capUsd: number | null; headroomUsd: number | null }> {
  return [...totals.entries()].map(([scope, spentUsd]) => ({
    scope,
    spentUsd,
    capUsd,
    headroomUsd: headroom(spentUsd, capUsd),
  }));
}

/**
 * Bind the `obs.spend.snapshot` handler — the admin gate + strip-before-parse +
 * the LIVE-snapshot read. COMPUTED-KEY form (`[ObsSpendSnapshotContract.method]`)
 * is MANDATORY (the `obs-audit.ts` precedent). The request is empty, so there are
 * no per-field literals to reference for the parity gate.
 *
 * @param deps - the shared obs-handler deps; `deps.spendSnapshot` is the threaded
 *   live reader, `deps.obsStore` exposes `pricingCoverage`. Both absent
 *   ⇒ an honest `enabled:false` snapshot.
 */
export function bindObsSpendHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  return {
    [ObsSpendSnapshotContract.method]: async (rawParams) => {
      // Admin check (defense-in-depth; gateway-router is the primary gate).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      // stripInternalFields BEFORE contract parse — `_trustLevel` (and any smuggled
      // field) cannot reach the parsed params or the result.
      ObsSpendSnapshotContract.request.parse(stripInternalFields(rawParams));

      const live = deps.spendSnapshot?.();

      // Honest-degradation: neither the live snapshot NOR the store ⇒ disabled.
      if (live === undefined && deps.obsStore === undefined) {
        const result = { snapshot: { enabled: false } };
        if (IS_DEV) ObsSpendSnapshotContract.response.parse(result);
        return result;
      }

      // Pricing-coverage (priced/free/unknown) — content-free counts. Honest zeroes
      // when the store is absent (the live snapshot can still carry spend).
      const pricingCoverage = deps.obsStore?.pricingCoverage() ?? { priced: 0, free: 0, unknown: 0 };

      const snapshot = {
        enabled: true,
        // The daemon-wide global spend + its ceiling/headroom.
        global: live?.global ?? 0,
        globalCapUsd: live?.ceilings.daemonGlobalUsd ?? null,
        globalHeadroomUsd: live ? headroom(live.global, live.ceilings.daemonGlobalUsd) : null,
        // Per-(tenant,agent) + per-tenant spend with each dimension's ceiling/headroom.
        perAgent: live ? scopeRows(live.perAgent, live.ceilings.perAgentUsd) : [],
        perTenant: live ? scopeRows(live.perTenant, live.ceilings.perTenantUsd) : [],
        pricingCoverage,
      };

      const result = { snapshot };
      if (IS_DEV) ObsSpendSnapshotContract.response.parse(result);
      return result;
    },
  };
}
