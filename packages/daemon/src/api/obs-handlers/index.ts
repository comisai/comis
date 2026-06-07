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

import type { RpcHandler } from "../types.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";
import { bindObsMetricsHandlers } from "./obs-metrics.js";
import { bindObsDiagnosticsHandlers } from "./obs-diagnostics.js";
import { bindObsExportHandlers } from "./obs-export.js";
import { bindObsSystemPromptReportHandlers } from "./obs-system-prompt-report.js";
import { bindConfigAuditHandlers } from "./config-audit.js";
import { bindObsTraceHandlers } from "./obs-trace.js";
import { bindObsExplainHandlers } from "./obs-explain.js";

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
  };
}
