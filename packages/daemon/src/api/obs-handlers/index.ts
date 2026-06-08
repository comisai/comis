// SPDX-License-Identifier: Apache-2.0
/**
 * Observability handlers.
 *
 * Barrel re-export of the canonical public API of the former
 * `obs-handlers.ts` monolith (884L). No aliases — every export keeps
 * its canonical name.
 *
 * @module
 */

export type { ObsHandlerDeps } from "./obs-helpers.js";

// The shared obs.explain assembler + its production reader (154-03). Re-exported
// so the daemon composition root can build the trust-flag-FREE
// obsExplainForMcpClient closure over the SAME assembler the admin RPC handler
// delegates to (the obs_explain MCP tool runs it directly under daemon
// authority — no admin RPC, no admin trust).
export {
  assembleIncidentReportFromSources,
  type AssembleIncidentReportParams,
} from "./obs-explain.js";
export { makeRealReader } from "./obs-explain-readers.js";

// A3 (159-03): the multi-day session-index aggregate reader — the activity half
// of the fleet lens. Generalizes the single-traceId resolveTraceToSession into a
// windowed aggregate over <dataDir>/logs/session-index.*.jsonl. Re-exported so
// the Phase-161 obs.fleet.health handler can assemble it alongside A1/A2.
export {
  readSessionIndexWindow,
  type FleetSessionIndexSummary,
} from "./fleet-session-index.js";

// The obs.fleet.health assembler (161-01). Re-exported so the daemon composition
// root (161-02) can build the trust-flag-FREE obsFleetHealthForMcpClient closure
// over the SAME assembler the admin RPC handler delegates to — mirroring the
// assembleIncidentReportFromSources re-export above (the obs_fleet_health MCP tool
// runs it directly under daemon authority; no admin RPC, no admin trust).
export { assembleFleetHealthReport } from "./fleet-health.js";

import type { RpcHandler } from "../types.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";
import { bindObsMetricsHandlers } from "./obs-metrics.js";
import { bindObsDiagnosticsHandlers } from "./obs-diagnostics.js";
import { bindObsExportHandlers } from "./obs-export.js";
import { bindObsSystemPromptReportHandlers } from "./obs-system-prompt-report.js";
import { bindConfigAuditHandlers } from "./config-audit.js";
import { bindObsTraceHandlers } from "./obs-trace.js";
import { bindObsExplainHandlers } from "./obs-explain.js";
import { bindFleetHealthHandlers } from "./fleet-health.js";

/**
 * Create a record of observability RPC handlers bound to the given deps.
 *
 * Handlers merge historical SQLite data with current-session in-memory
 * data when obsStore is available. When obsStore is undefined, behavior is
 * in-memory only.
 */
export function createObsHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  return {
    ...bindObsMetricsHandlers(deps),
    ...bindObsDiagnosticsHandlers(deps),
    ...bindObsExportHandlers(deps),
    ...bindObsSystemPromptReportHandlers(deps),
    ...bindConfigAuditHandlers(deps),
    ...bindObsTraceHandlers(deps),
    ...bindObsExplainHandlers(deps),
    ...bindFleetHealthHandlers(deps),
  };
}
