// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Observability data lifecycle (reset) RPC handlers.
 *
 * Admin operations that clear observability data across in-memory collectors
 * AND SQLite persistence layer:
 *   - obs.reset: clear all observability data (token_usage, delivery,
 *     diagnostics, channels)
 *   - obs.reset.table: clear a specific observability table by name
 *
 * Each handler emits an `observability:reset` event on the event bus with the
 * row counts deleted from SQLite. The bus subscribers (UI panels, audit logs)
 * use this to invalidate caches.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import {
  ObsResetContract,
  ObsResetTableContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/**
 * Bind the observability data-lifecycle (reset) handlers. Object-spread
 * compatible with `Record<string, RpcHandler>`.
 */
export function bindObsExportHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  const { obsStore } = deps;

  return {
    // -----------------------------------------------------------------------
    // obs.reset — clear all observability data (both stores)
    // -----------------------------------------------------------------------
    [ObsResetContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      const userParams = stripInternalFields(rawParams);
      ObsResetContract.request.parse(userParams);

      // Reset in-memory collectors
      deps.diagnosticCollector.reset();
      deps.channelActivityTracker.reset();
      deps.deliveryTracer.reset();

      // Reset in-memory billing data
      deps.sharedCostTracker?.reset();

      // Reset context pipeline collector
      deps.contextPipelineCollector?.reset();

      // Reset SQLite if available
      let sqliteResult = { tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 };
      deps.obsPersistence?.discardPending("all");
      if (obsStore) {
        sqliteResult = obsStore.resetAll();
      }

      // Emit event
      deps.eventBus?.emit("observability:reset", {
        admin: "rpc",
        table: "all" as const,
        rowsDeleted: sqliteResult,
        timestamp: systemNowMs(),
      });

      const result = { reset: true as const, rowsDeleted: sqliteResult };
      if (IS_DEV) ObsResetContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.reset.table — clear a specific observability table (both stores)
    // -----------------------------------------------------------------------
    [ObsResetTableContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      // Bespoke pre-Zod guard preserves the legacy error format
      // ("Invalid table: ${table}. Valid: ${list}") which is more
      // operator-friendly than Zod's enum-rejection message.
      const tableRaw = rawParams.table as string | undefined;
      const validTables = ["token_usage", "delivery", "diagnostics", "channels"];
      if (!tableRaw || !validTables.includes(tableRaw)) {
        throw new Error(`Invalid table: ${tableRaw}. Valid: ${validTables.join(", ")}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsResetTableContract.request.parse(userParams);
      const table = params.table;

      // Reset in-memory for matching table
      if (table === "token_usage") deps.sharedCostTracker?.reset();
      if (table === "diagnostics") deps.diagnosticCollector.reset();
      if (table === "channels") deps.channelActivityTracker.reset();
      if (table === "delivery") deps.deliveryTracer.reset();

      // Reset SQLite table
      let rowsDeleted = 0;
      deps.obsPersistence?.discardPending(table);
      if (obsStore) {
        rowsDeleted = obsStore.resetTable(table);
      }

      deps.eventBus?.emit("observability:reset", {
        admin: "rpc",
        table,
        rowsDeleted: {
          tokenUsage: table === "token_usage" ? rowsDeleted : 0,
          delivery: table === "delivery" ? rowsDeleted : 0,
          diagnostics: table === "diagnostics" ? rowsDeleted : 0,
          channels: table === "channels" ? rowsDeleted : 0,
        },
        timestamp: systemNowMs(),
      });

      const result = { reset: true as const, table, rowsDeleted };
      if (IS_DEV) ObsResetTableContract.response.parse(result);
      return result;
    },
  };
}
