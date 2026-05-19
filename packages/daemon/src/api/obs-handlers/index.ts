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

import type { RpcHandler } from "../types.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";
import { bindObsMetricsHandlers } from "./obs-metrics.js";
import { bindObsDiagnosticsHandlers } from "./obs-diagnostics.js";
import { bindObsExportHandlers } from "./obs-export.js";
import { bindObsSystemPromptReportHandlers } from "./obs-system-prompt-report.js";
import { bindConfigAuditHandlers } from "./config-audit.js";

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
  };
}
