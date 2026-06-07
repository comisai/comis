// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.explain` RPC handler — the IncidentReport assembler (Phase 153
 * centerpiece, D6).
 *
 * Wires the full pipeline the Wave-1..4 plans built, in five linear steps:
 *
 *   1. admin check (defense-in-depth; gateway-router is the primary gate)
 *   2. `stripInternalFields` THEN `ObsExplainContract.request.parse`
 *      (so `_trustLevel` can never be smuggled into the parsed params)
 *   3. resolve — a `traceId` is canonicalized to its `sessionKey` FIRST
 *      ({@link resolveTraceToSession}), so by-trace and by-session share ONE
 *      assembler path (X1 structural identity)
 *   4. read → normalize → assemble → heuristics → bound:
 *        - {@link IncidentSourceReader} reads the four bounded sources
 *        - {@link toIncidentSignals} collapses log + event shapes
 *        - {@link assembleIncidentReport} merges signals + rollup → §6.3 report
 *        - {@link rootCause} stamps the deterministic `likelyRootCause` (X3)
 *        - {@link boundIncidentReport} enforces the depth budget (X2)
 *   5. dev-mode `response.parse` (catches field regressions in dev only)
 *
 * The `incidentReader` dep is an OPTIONAL test seam: production builds
 * {@link makeRealReader} over the real (safePath-guarded) data dir; tests inject
 * a fixture reader. It does NOT enable arbitrary-file reads in production
 * (T-153-17) — the dataDir override convention only, like obs-trace.
 *
 * @module
 */

import * as os from "node:os";
import { ObsExplainContract, stripInternalFields, safePath } from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";
import { resolveTraceToSession } from "./obs-explain-resolve.js";
import { makeRealReader, type IncidentSourceReader } from "./obs-explain-readers.js";
import { toIncidentSignals } from "./obs-explain-signals.js";
import { assembleIncidentReport } from "./obs-explain-assemble.js";
import { rootCause } from "./obs-explain-heuristics.js";
import { boundIncidentReport } from "./obs-explain-bound.js";

/** Default data directory (lazy). Mirrors obs-trace.ts / obs-explain-readers.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

/**
 * Bind the `obs.explain` handler — the wired resolver → readers → normalize →
 * assemble → heuristics → bound pipeline.
 *
 * @param deps - the shared obs-handler deps, plus an optional `incidentReader`
 *   test seam. When absent, the production {@link makeRealReader} is built over
 *   `deps.dataDir` (defaulting to `~/.comis`) backed by `deps.obsStore`.
 */
export function bindObsExplainHandlers(
  deps: ObsHandlerDeps & { incidentReader?: IncidentSourceReader },
): Record<string, RpcHandler> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const reader = deps.incidentReader ?? makeRealReader(dataDir, deps.obsStore);

  return {
    [ObsExplainContract.method]: async (rawParams) => {
      // Step 1: admin check (defense-in-depth; gateway-router is the primary gate).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as
        | string
        | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      // Step 2: stripInternalFields BEFORE contract parse — `_trustLevel`
      // cannot be smuggled into the parsed params.
      const params = ObsExplainContract.request.parse(stripInternalFields(rawParams));

      // Step 3 (X1): canonicalize a traceId to its sessionKey FIRST, so by-trace
      // and by-session collapse to one assembler path. `sessionKey` is present
      // when traceId is absent (the contract .refine guarantees one of the two).
      const sessionKey = params.traceId
        ? await resolveTraceToSession(dataDir, params.traceId)
        : params.sessionKey!;

      // Step 4: read the four bounded sources (production reads files; tests
      // inject the fixture reader).
      const records = await reader.readSessionRecords(sessionKey);
      const cache = await reader.readCacheTraceRecords(sessionKey);
      const metadata = await reader.readSessionMetadata(sessionKey);
      const rollup = await reader.readDiagnosticsRollup(sessionKey);

      // Normalize both shapes → uniform signals; assemble the §6.3 report;
      // stamp the deterministic root cause (X3); bound to the depth budget (X2).
      const signals = toIncidentSignals([...records, ...cache]);
      const report = assembleIncidentReport(signals, metadata, rollup, sessionKey);
      report.likelyRootCause = rootCause(signals);
      const bounded = boundIncidentReport(report, params.depth ?? "summary");

      // Step 5: dev-mode response validation (catches field type regressions).
      if (IS_DEV) ObsExplainContract.response.parse(bounded);
      return bounded;
    },
  };
}
