// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Config-audit RPC handlers.
 *
 * Two admin-gated methods read + manage the daemon-wide
 * `~/.comis/logs/config-audit.jsonl` log:
 *
 *   - `config.audit.list` — filter + tail recent records by `since` /
 *     `until` (ISO-8601 or relative `"1h"` / `"24h"` shortcuts),
 *     `suspiciousOnly`, `pid`, and `tail`. Default tail is 1000; the
 *     contract caps it at 1000.
 *
 *   - `config.audit.scrub` — re-run the redactor pipeline over the
 *     historical audit log. `dryRun: true` computes counters without
 *     rewriting; `dryRun: false` (default) atomically rewrites the
 *     log via `scrubConfigAuditLog` from `@comis/observability`.
 *
 * Both follow the established obs-handlers pattern (in-handler
 * `_trustLevel === "admin"` gate + dev-mode `response.parse()`
 * defense in depth; `stripInternalFields` BEFORE contract parse).
 *
 * Lives in `obs-handlers/` (not `config-handlers/`) — obs-handlers is
 * the canonical home for admin-only read-side and forensics RPCs.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import * as fs from "node:fs";

import {
  ConfigAuditListContract,
  ConfigAuditScrubContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import {
  resolveConfigAuditLogPath,
  scrubConfigAuditLog,
  getDefaultConfigAuditConfinedBase,
} from "@comis/observability";

import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

const DEFAULT_TAIL = 1000;
const MAX_TAIL = 1000;

/**
 * Parse a `since` / `until` query into an absolute epoch-ms.
 *
 * Accepted forms:
 *   - Empty / undefined → undefined (no filter).
 *   - Relative shortcut: `"1h"`, `"24h"`, `"30m"`, `"7d"` (computed
 *     relative to `now`).
 *   - ISO-8601 timestamp: parsed via `Date.parse`.
 *
 * Returns `undefined` when the input is empty or unparseable (callers
 * treat that as "no filter").
 */
function parseTimestamp(value: string | undefined, now: number): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const relMatch = value.match(/^(\d+)\s*([smhd])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!;
    const multiplier =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return now - n * multiplier;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Read the audit log into a flat array of parsed records. */
function readAuditLog(filePath: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Malformed line — skip (the scrubber's malformed-line guard
      // preserves these; the list handler skips them).
    }
  }
  return records;
}

/**
 * Bind the config-audit RPC handlers. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 */
export function bindConfigAuditHandlers(
  // The handlers do not currently use ObsHandlerDeps fields beyond
  // the universal trust-level gate (the audit log is on disk; the
  // handlers do not need the obsStore). The arg is accepted for
  // future-proofing — if a downstream plan wires a SQLite-backed
  // audit sink, the obsStore handle is already in-scope.
  _deps: ObsHandlerDeps,
): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // config.audit.list
    // -----------------------------------------------------------------------
    [ConfigAuditListContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      const userParams = stripInternalFields(rawParams);
      const params = ConfigAuditListContract.request.parse(userParams);

      const filePath = resolveConfigAuditLogPath();
      const all = readAuditLog(filePath);

      const now = systemNowMs();
      const sinceMs = parseTimestamp(params.since, now);
      const untilMs = parseTimestamp(params.until, now);

      const filtered = all.filter((record) => {
        // Time-window filter via `ts` (ISO string). `tsMs` was dropped —
        // records now carry only `ts` (config.observe schema shape). Legacy records that
        // still have `tsMs` fall through to `ts` parsing; the parse of a
        // missing field yields NaN which both comparisons reject (treat as
        // out-of-window).
        const tsRaw = record.ts;
        const tsMs =
          typeof tsRaw === "string" ? Date.parse(tsRaw) : Number.NaN;
        if (sinceMs !== undefined) {
          if (!Number.isFinite(tsMs) || tsMs < sinceMs) return false;
        }
        if (untilMs !== undefined) {
          if (!Number.isFinite(tsMs) || tsMs > untilMs) return false;
        }
        if (params.suspiciousOnly === true) {
          const susp = record.suspicious;
          if (!Array.isArray(susp) || susp.length === 0) return false;
        }
        if (params.pid !== undefined && record.pid !== params.pid) {
          return false;
        }
        return true;
      });

      const tailRequested = params.tail ?? DEFAULT_TAIL;
      const tail = Math.min(tailRequested, MAX_TAIL);
      // Tail = last N (most recent are at the bottom of the file).
      const result = {
        records: filtered.slice(-tail),
      };
      if (IS_DEV) ConfigAuditListContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // config.audit.scrub
    // -----------------------------------------------------------------------
    [ConfigAuditScrubContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      const userParams = stripInternalFields(rawParams);
      const params = ConfigAuditScrubContract.request.parse(userParams);

      const filePath = resolveConfigAuditLogPath();
      if (params.dryRun === true) {
        // Read + count without rewriting. Each parsed line is a
        // rewrittenRecord candidate; malformed lines are
        // skippedMalformed candidates.
        let raw: string;
        try {
          raw = fs.readFileSync(filePath, "utf-8");
        } catch {
          const result = { rewrittenRecords: 0, skippedMalformed: 0, aborted: false };
          if (IS_DEV) ConfigAuditScrubContract.response.parse(result);
          return result;
        }
        const lines = raw.split("\n").filter((l) => l.length > 0);
        let rewrittenRecords = 0;
        let skippedMalformed = 0;
        for (const line of lines) {
          try {
            JSON.parse(line);
            rewrittenRecords += 1;
          } catch {
            skippedMalformed += 1;
          }
        }
        const result = { rewrittenRecords, skippedMalformed, aborted: false };
        if (IS_DEV) ConfigAuditScrubContract.response.parse(result);
        return result;
      }

      const scrubConfinedBase = getDefaultConfigAuditConfinedBase(filePath);
      const scrubResult = await scrubConfigAuditLog({
        filePath,
        // Confine the scrub tmp-write to ~/.comis/ when the default
        // log path applies; skip confinement when the operator set
        // COMIS_CONFIG_AUDIT_LOG to a custom location.
        ...(scrubConfinedBase !== undefined && {
          confinedBaseDir: scrubConfinedBase,
        }),
      });
      if (!scrubResult.ok) {
        throw new Error(`Audit scrub failed: ${scrubResult.error.message}`);
      }
      const result = {
        rewrittenRecords: scrubResult.value.rewrittenRecords,
        skippedMalformed: scrubResult.value.skippedMalformed,
        aborted: scrubResult.value.aborted,
      };
      if (IS_DEV) ConfigAuditScrubContract.response.parse(result);
      return result;
    },
  };
}
