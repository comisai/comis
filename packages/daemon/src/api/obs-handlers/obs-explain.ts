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
import { ObsExplainContract, stripInternalFields, safePath, type IncidentReport } from "@comis/core";
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
 * Already-validated `obs.explain` params (post `request.parse`). The shared
 * assembler takes this shape DIRECTLY — it performs NO contract parse and NO
 * admin check, so it can be reached under daemon authority by a caller that has
 * its own authorization boundary (the admin RPC handler keeps its admin gate;
 * the operator-allowlisted `obs_explain` MCP tool relies on the per-client
 * allowlist + the digest-only/bounded report instead).
 */
export interface AssembleIncidentReportParams {
  readonly sessionKey?: string;
  readonly traceId?: string;
  readonly depth?: "summary" | "full";
  /**
   * D9 admin opt-in: when `true`, a `traceId` that resolves only through a
   * synthetic (test/harness) session-index row is still canonicalized. Default
   * (absent/`false`) excludes synthetic rows from the by-traceId resolution.
   */
  readonly includeSynthetic?: boolean;
}

/**
 * The FROZEN `obs.explain` assembler pipeline, extracted from the RPC handler
 * so it can be shared by BOTH the admin RPC path (which keeps Step 1's admin
 * gate + Step 2's contract parse, then delegates here) AND the
 * operator-allowlisted `obs_explain` MCP tool (which has NO admin gate — its
 * authorization is the per-client `mcpClient.allowlist`, NOT admin trust).
 *
 * This function contains NEITHER an admin check NOR a `request.parse`: it takes
 * ALREADY-VALIDATED params and runs the deterministic pipeline:
 *
 *   3 (X1). canonicalize a `traceId` to its `sessionKey` FIRST, so by-trace and
 *           by-session collapse to one assembler path.
 *   4.      read the four bounded sources → `toIncidentSignals` → assemble the
 *           §6.3 report → stamp `likelyRootCause` (X3, with the WR-04
 *           `session_not_found` not-found marker) → bound to the depth budget
 *           (X2).
 *   5.      dev-mode `response.parse` (catches field regressions in dev only).
 *
 * The body is byte-identical to the former inline handler body; moving it here
 * changes NO behavior (the obs-explain.test.ts parity case pins this).
 *
 * @param reader - the four-source DI reader (production `makeRealReader` over a
 *   safePath-guarded `dataDir`; tests inject a fixture reader). Read-only.
 * @param dataDir - file-system root for `resolveTraceToSession` (the session
 *   index lookup). Mirrors the reader's root.
 * @param params - already-validated `{ sessionKey?, traceId?, depth? }` (the
 *   contract `.refine` guarantees one of `sessionKey`/`traceId` is present).
 */
export async function assembleIncidentReportFromSources(
  reader: IncidentSourceReader,
  dataDir: string,
  params: AssembleIncidentReportParams,
): Promise<IncidentReport> {
  // Step 3 (X1): canonicalize a traceId to its sessionKey FIRST, so by-trace
  // and by-session collapse to one assembler path. `sessionKey` is present
  // when traceId is absent (the contract .refine guarantees one of the two).
  const sessionKey = params.traceId
    ? await resolveTraceToSession(dataDir, params.traceId, params.includeSynthetic)
    : params.sessionKey!;

  // WR-04: a traceId that resolves to "" (no row in today/yesterday's session
  // index) is UNRESOLVABLE — distinct from a session that genuinely had zero
  // tool activity. Without a marker both yield the same empty report keyed on
  // "", so an admin can't tell a typo'd/expired traceId from a clean session.
  // We stamp the marker (below, after we know the report is genuinely empty)
  // rather than throw: the no-throw posture is preserved (the empty report is
  // safe — no traversal, no leak). An empty RESOLVED session (a real
  // sessionKey with no telemetry) is NOT flagged. Note the resolution missed
  // the index; whether the report is actually empty is decided post-assembly
  // (an injected reader may still surface telemetry for a "" key — then the
  // session WAS effectively found and must keep its real rootCause).
  const traceResolutionMissed = params.traceId !== undefined && sessionKey === "";

  // Step 4: read the four bounded sources (production reads files; tests
  // inject the fixture reader).
  const records = await reader.readSessionRecords(sessionKey);
  const cache = await reader.readCacheTraceRecords(sessionKey);
  const metadata = await reader.readSessionMetadata(sessionKey);
  const rollup = await reader.readDiagnosticsRollup(sessionKey);

  // Normalize both shapes → uniform signals; assemble the §6.3 report;
  // stamp the deterministic root cause (X3); bound to the depth budget (X2).
  const signals = toIncidentSignals([...records, ...cache]);
  // Pass the trajectory READ count (records.length) so coverage.trajectory
  // reflects what the reader actually READ — the meta-observability point: a
  // d510322f-class "read nothing" bug surfaces as coverage.trajectory.records:0
  // on a report that otherwise looks like a clean zero-activity session.
  const report = assembleIncidentReport(signals, metadata, rollup, sessionKey, records.length);
  // The report is genuinely empty only when NO source surfaced any activity.
  const reportIsEmpty =
    report.failures.length === 0 &&
    report.breakerTimeline.length === 0 &&
    report.offloads.length === 0 &&
    Object.keys(report.toolStats).length === 0;
  if (traceResolutionMissed && reportIsEmpty) {
    // WR-04: an honest not-found verdict + ledger note so the empty report
    // does not masquerade as a healthy zero-activity session. The bound pass
    // preserves both (it seeds truncations[] from the report and never
    // overwrites likelyRootCause).
    report.likelyRootCause = {
      code: "session_not_found",
      detail: `traceId did not resolve to any session in the index (today/yesterday); it may be a typo, expired, or older than the 2-day resolution horizon`,
      suggestedNextSteps: [
        "verify the traceId, or query by sessionKey directly",
        "confirm the session ended within the last two days (the session-index lookup window)",
      ],
    };
    report.truncations.push({
      field: "traceId",
      reason: "traceId not found in session index (today/yesterday) — empty report is unresolved, not a clean session",
    });
  } else {
    // QT2/QT3: thread the mapped terminal endReason (the NAMED degradation cause)
    // onto the signals so the two lowest-priority heuristics (context_exhausted /
    // output_starved) can fire. endReason is metadata-derived — toIncidentSignals
    // reads the trajectory record stream and never sees it — so the assembler's
    // resolved `report.outcome.endReason` is the single source threaded here. A
    // tool-failure cause still out-ranks it (the named-cause rules sit LAST).
    // RECALL-01: also thread the authoritative `degraded` flag so `recall_miss`
    // gates on genuine degradation (a zero-hit recall on a healthy turn is benign).
    report.likelyRootCause = rootCause({
      ...signals,
      endReason: report.outcome.endReason,
      degraded: report.outcome.degraded,
    });
  }
  const bounded = boundIncidentReport(report, params.depth ?? "summary");

  // Step 5: dev-mode response validation (catches field type regressions).
  if (IS_DEV) ObsExplainContract.response.parse(bounded);
  return bounded;
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
      // FROZEN — this gate stays on the RPC path for non-MCP callers. The
      // operator-allowlisted obs_explain MCP tool does NOT come through here;
      // it calls assembleIncidentReportFromSources directly (its boundary is
      // the per-client allowlist, not admin trust). See 154-03 / DESIGN §4.7.
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as
        | string
        | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      // Step 2: stripInternalFields BEFORE contract parse — `_trustLevel`
      // cannot be smuggled into the parsed params.
      const params = ObsExplainContract.request.parse(stripInternalFields(rawParams));

      // Steps 3-5: delegate to the shared assembler (resolve → read → signals →
      // assemble → rootCause/WR-04 → bound → dev-mode parse). The body is
      // identical to the former inline pipeline; the obs_explain MCP path runs
      // the SAME function under daemon authority.
      return assembleIncidentReportFromSources(reader, dataDir, params);
    },
  };
}
