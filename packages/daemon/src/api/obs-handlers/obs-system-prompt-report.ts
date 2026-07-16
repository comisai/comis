// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * SystemPromptReport RPC handlers.
 *
 * Two admin-gated methods:
 *   - obs.systemPromptReport.latest — latest report for (agentId, sessionId, runId?)
 *   - obs.systemPromptReport.list   — N most-recent reports for a session
 *
 * Both follow the established obs-handlers pattern (in-handler
 * _trustLevel === "admin" gate + dev-mode response.parse() defense in
 * depth; stripInternalFields BEFORE contract parse).
 *
 * The persisted report lives in the `system_prompt_reports` SQLite
 * table; `report_json` is a sanitized SystemPromptReport JSON string
 * (post-sanitizeForPersistence). Handlers parse it back into a plain
 * object before returning.
 *
 * @module
 */

import {
  ObsSystemPromptReportLatestContract,
  ObsSystemPromptReportListContract,
  stripInternalFields,
} from "@comis/core";
import type { SystemPromptReportRow } from "@comis/memory";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";
import { AuthorizationError } from "../errors.js";

/** Default page size for `list`. Matches the contract `.optional()` default. */
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 100;

/**
 * Bind the SystemPromptReport RPC handlers. Object-spread compatible
 * with `Record<string, RpcHandler>`.
 */
export function bindObsSystemPromptReportHandlers(
  deps: ObsHandlerDeps,
): Record<string, RpcHandler> {
  const { obsStore } = deps;

  return {
    // -----------------------------------------------------------------------
    // obs.systemPromptReport.latest — admin-gated single-row read
    // -----------------------------------------------------------------------
    [ObsSystemPromptReportLatestContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsSystemPromptReportLatestContract.request.parse(userParams);

      let result: { report: Record<string, unknown> | null };
      if (!obsStore) {
        result = { report: null };
      } else {
        // Push the optional runId into the SQL WHERE clause instead of
        // post-filtering the latest-by-generatedAt row. Post-filtering
        // would drop older rows that DID match.
        const row: SystemPromptReportRow | undefined = obsStore.latestSystemPromptReport(
          params.agentId,
          params.sessionId,
          params.runId,
        );
        if (!row) {
          result = { report: null };
        } else {
          try {
            const parsed = JSON.parse(row.reportJson) as Record<string, unknown>;
            result = { report: parsed };
          } catch {
            // Corrupt report_json — degrade to null (observability is non-fatal).
            result = { report: null };
          }
        }
      }

      if (IS_DEV) ObsSystemPromptReportLatestContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.systemPromptReport.list — admin-gated bounded-page read
    // -----------------------------------------------------------------------
    [ObsSystemPromptReportListContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsSystemPromptReportListContract.request.parse(userParams);

      // Apply default + max-cap at the handler since the contract uses
      // `.optional()` (the 12-shape allowlist excludes ZodDefault).
      const requested = params.limit ?? DEFAULT_LIST_LIMIT;
      const limit = Math.min(requested, MAX_LIST_LIMIT);

      let result: { reports: Record<string, unknown>[] };
      if (!obsStore) {
        result = { reports: [] };
      } else {
        const rows: SystemPromptReportRow[] = obsStore.listSystemPromptReports(
          params.sessionId,
          limit,
        );
        const reports: Record<string, unknown>[] = [];
        for (const r of rows) {
          try {
            reports.push(JSON.parse(r.reportJson) as Record<string, unknown>);
          } catch {
            // Corrupt rows are silently dropped (observability is
            // non-fatal); the caller sees only well-formed entries.
          }
        }
        result = { reports };
      }

      if (IS_DEV) ObsSystemPromptReportListContract.response.parse(result);
      return result;
    },
  };
}
