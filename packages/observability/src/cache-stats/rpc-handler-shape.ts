// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Plan 46-02 (CACHE-OBS-02): `buildCacheStatsRpcHandler` shape factory.
 *
 * Returns a `{ [method]: handler }` object that the daemon spreads into
 * its dispatch map. The contract is INJECTED as a dep (rather than
 * imported from `@comis/core` here) so the observability package
 * remains decoupled from contract-domain shape — the daemon binds the
 * concrete `ObsCacheStatsWindowContract` at composition time.
 *
 * Handler responsibilities:
 *   1. Enforce admin trust (mirror `obs-system-prompt-report.ts:50`).
 *   2. `stripInternalFields` then `contract.request.parse` (the same
 *      ordering used across obs-handlers — internal `_X` fields must
 *      be projected away BEFORE the request parse, see
 *      `@comis/core/api-contracts/internals.ts`).
 *   3. Delegate to `aggregateCacheStats(deps, params)`.
 *   4. Dev-mode `contract.response.parse(result)` defense in depth.
 *
 * @module
 */
import type { ZodTypeAny, z } from "zod";
import { stripInternalFields } from "@comis/core";
import { aggregateCacheStats } from "./aggregator.js";
import type { CacheStatsStore } from "./types.js";

/**
 * Minimal contract shape the handler needs. The daemon passes its real
 * `ObsCacheStatsWindowContract` (which conforms to this shape) at
 * registration time.
 */
export interface CacheStatsRpcContract<
  Req extends ZodTypeAny = ZodTypeAny,
  Res extends ZodTypeAny = ZodTypeAny,
> {
  method: string;
  request: Req;
  response: Res;
}

export interface BuildCacheStatsRpcHandlerDeps<
  Req extends ZodTypeAny,
  Res extends ZodTypeAny,
> {
  store: CacheStatsStore;
  isDev: boolean;
  contract: CacheStatsRpcContract<Req, Res>;
}

/**
 * Build the cache-stats RPC handler map for daemon composition.
 *
 * The returned record's only entry is keyed by `contract.method`. The
 * daemon spreads this into its dispatch map alongside the obs / agent /
 * memory handler bundles.
 *
 * @param deps - store port + dev-mode flag + the concrete contract.
 */
export function buildCacheStatsRpcHandler<
  Req extends ZodTypeAny,
  Res extends ZodTypeAny,
>(
  deps: BuildCacheStatsRpcHandlerDeps<Req, Res>,
): Record<string, (rawParams: Record<string, unknown>) => Promise<z.output<Res>>> {
  const handler = async (
    rawParams: Record<string, unknown>,
  ): Promise<z.output<Res>> => {
    const trustLevel = rawParams._trustLevel as string | undefined;
    if (trustLevel !== "admin") {
      throw new Error("Admin trust level required");
    }

    const userParams = stripInternalFields(rawParams);
    const params = deps.contract.request.parse(userParams) as {
      sinceMs: number;
      untilMs?: number;
      agent?: string;
      provider?: string;
    };

    const window = await aggregateCacheStats(
      { store: deps.store },
      {
        sinceMs: params.sinceMs,
        untilMs: params.untilMs,
        agent: params.agent,
        provider: params.provider,
      },
    );

    // The contract response is loose-modeled as `{ window: ObsRecord }`
    // so the breakdowns[] arrays can pass through. Cast to the parse
    // input shape at the boundary.
    const result = { window } as unknown as z.input<Res>;

    if (deps.isDev) {
      deps.contract.response.parse(result);
    }
    return result as z.output<Res>;
  };

  return { [deps.contract.method]: handler };
}
