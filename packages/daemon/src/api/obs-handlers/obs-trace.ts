// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Trace correlation and export RPC handlers.
 *
 * Implements three admin-scoped RPC handlers:
 *   - obs.trace.search: messageId LRU lookup or session-index scan
 *   - obs.trace.tail:   cursor-based polling for chat activity
 *   - obs.trace.export: delegates to the exportTrajectoryBundle DI seam
 *
 * Data access is bounded to the last 2 days of session-index JSONL files
 * living under `<dataDir>/logs/`. Result rows are capped per request.limit
 * (zod-enforced max 1000 / 100 respectively per ObsTraceSearchContract /
 * ObsTraceTailContract schema). The in-memory LRU is capped at MAX_LRU entries;
 * oldest entry is evicted on overflow.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  ObsTraceSearchContract,
  ObsTraceTailContract,
  ObsTraceExportContract,
  stripInternalFields,
  safePath,
  systemDateFrom,
  systemNowMs,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

// ---------------------------------------------------------------------------
// Module-private LRU: messageId -> { traceId, sessionId }
// Bounded at MAX_LRU entries; Map insertion order is used for LRU semantics.
// ---------------------------------------------------------------------------

const MAX_LRU = 1024;
const lru = new Map<string, { traceId: string; sessionId: string }>();

function lruSet(messageId: string, value: { traceId: string; sessionId: string }): void {
  if (lru.has(messageId)) lru.delete(messageId); // re-insert at tail (mark recently used)
  lru.set(messageId, value);
  while (lru.size > MAX_LRU) {
    // Evict oldest (first) entry.
    const oldestKey = lru.keys().next().value;
    if (oldestKey === undefined) break;
    lru.delete(oldestKey);
  }
}

function lruGet(messageId: string): { traceId: string; sessionId: string } | undefined {
  const v = lru.get(messageId);
  if (v === undefined) return undefined;
  // Re-insert at tail = mark as recently used.
  lru.delete(messageId);
  lru.set(messageId, v);
  return v;
}

/** @internal test-only: reset the module-level LRU Map */
export function __resetLru(): void {
  lru.clear();
}

/** @internal test-only: return the current LRU size */
export function __lruSize(): number {
  return lru.size;
}

// ---------------------------------------------------------------------------
// Default data directory (lazy — resolved at handler-construction time)
// ---------------------------------------------------------------------------

function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

// ---------------------------------------------------------------------------
// Date helpers: produce "YYYY-MM-DD" without new Date()
// ---------------------------------------------------------------------------

function todayKey(): string {
  return systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
}

function yesterdayKey(): string {
  return systemDateFrom(systemNowMs() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Exported seed function: populate LRU from today's + yesterday's index files
// ---------------------------------------------------------------------------

/**
 * Seed the messageId LRU from the last 2 days of session-index JSONL files.
 * Called from daemon startup wiring (or lazily on first handler invocation).
 * Reads `<dataDir>/logs/session-index.YYYY-MM-DD.jsonl` for today and yesterday.
 */
export function seedMessageIdLru(dataDir: string): void {
  for (const dayKey of [yesterdayKey(), todayKey()]) {
    const logsDir = safePath(dataDir, "logs");
    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (
          rec.event === "turn_completed" &&
          typeof rec.messageId === "string" &&
          typeof rec.traceId === "string" &&
          typeof rec.sessionId === "string"
        ) {
          lruSet(rec.messageId, { traceId: rec.traceId, sessionId: rec.sessionId });
        }
      } catch {
        // Skip malformed JSONL lines per standard JSONL convention.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scan helpers: read last 2 days of session-index files
// ---------------------------------------------------------------------------

/** Scan index files for all records matching a traceId. */
async function scanSessionIndexByTrace(
  dataDir: string,
  traceId: string,
  limit: number,
  includeSynthetic = false,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const dayKey of [yesterdayKey(), todayKey()]) {
    if (rows.length >= limit) break;
    const logsDir = safePath(dataDir, "logs");
    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line || rows.length >= limit) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.synthetic === true && !includeSynthetic) continue; // D9 default-exclude
        if (rec.traceId === traceId) rows.push(rec);
      } catch {
        // Skip malformed lines.
      }
    }
  }
  return rows.slice(0, limit);
}

/** Scan index files for records matching optional since/where filters. */
async function scanSessionIndexByFilter(
  dataDir: string,
  since: string | undefined,
  where: string | undefined,
  limit: number,
  includeSynthetic = false,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const sinceMs = since ? parseSinceDuration(since, systemNowMs()) : 0;
  for (const dayKey of [yesterdayKey(), todayKey()]) {
    if (rows.length >= limit) break;
    const logsDir = safePath(dataDir, "logs");
    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line || rows.length >= limit) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.synthetic === true && !includeSynthetic) continue; // D9 default-exclude
        if (sinceMs > 0 && Date.parse(String(rec.ts)) < sinceMs) continue;
        if (where === "error" && rec.lastError == null) continue;
        rows.push(rec);
      } catch {
        // Skip malformed lines.
      }
    }
  }
  return rows.slice(0, limit);
}

/** Scan index files for records matching a chatId after sinceMs cursor. */
async function scanSessionIndexByChat(
  dataDir: string,
  chatId: string,
  sinceMs: number,
  limit: number,
  includeSynthetic = false,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const dayKey of [yesterdayKey(), todayKey()]) {
    if (rows.length >= limit) break;
    const logsDir = safePath(dataDir, "logs");
    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line || rows.length >= limit) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.synthetic === true && !includeSynthetic) continue; // D9 default-exclude
        // Session index may use channelId or chatId depending on version.
        if (rec.channelId !== chatId && rec.chatId !== chatId) continue;
        if (Date.parse(String(rec.ts)) <= sinceMs) continue;
        rows.push(rec);
      } catch {
        // Skip malformed lines.
      }
    }
  }
  return rows.slice(0, limit);
}

/** Parse duration strings like "10m" / "1h" / "30s" / "2d" into milliseconds-ago timestamp. */
function parseSinceDuration(input: string, now: number): number {
  const m = input.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return 0;
  const n = parseInt(m[1] as string, 10);
  const unit = m[2] as string;
  const mult =
    unit === "s" ? 1_000 :
    unit === "m" ? 60_000 :
    unit === "h" ? 3_600_000 :
    /* d */        86_400_000;
  return now - n * mult;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Bind the obs.trace.{search, tail, export} RPC handlers.
 * Returns a Record<string, RpcHandler> that is object-spread compatible
 * with createObsHandlers in index.ts.
 *
 * @param deps - ObsHandlerDeps with optional trace-handler fields:
 *   - `dataDir`: data directory containing logs/session-index.*.jsonl files.
 *     Defaults to `~/.comis` at handler-construction time.
 *   - `exportTrajectoryBundle`: DI seam for the bundle pipeline.
 *     Production wires the real function; tests inject a stub.
 */
export function bindObsTraceHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  const dataDir = deps.dataDir ?? defaultDataDir();

  return {
    // -----------------------------------------------------------------------
    // obs.trace.search — messageId LRU lookup or session-index scan
    // -----------------------------------------------------------------------
    // @contract-deferred-fields: chatId
    [ObsTraceSearchContract.method]: async (rawParams) => {
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      const params = ObsTraceSearchContract.request.parse(stripInternalFields(rawParams));
      const limit = params.limit ?? 200;

      let rows: Array<Record<string, unknown>> = [];

      if (params.messageId) {
        // O(1) LRU lookup; fall through to traceId scan if LRU miss.
        const hit = lruGet(params.messageId);
        if (hit) {
          rows = await scanSessionIndexByTrace(dataDir, hit.traceId, limit, params.includeSynthetic);
        }
        // If LRU miss: return empty rows — caller can retry with --trace-id.
      } else if (params.traceId) {
        rows = await scanSessionIndexByTrace(dataDir, params.traceId, limit, params.includeSynthetic);
      } else if (params.since || params.where) {
        rows = await scanSessionIndexByFilter(dataDir, params.since, params.where, limit, params.includeSynthetic);
      }

      const result = { rows };
      if (IS_DEV) ObsTraceSearchContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.trace.tail — cursor-based polling for chat activity
    // -----------------------------------------------------------------------
    [ObsTraceTailContract.method]: async (rawParams) => {
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      const params = ObsTraceTailContract.request.parse(stripInternalFields(rawParams));
      const limit = params.limit ?? 50;
      const sinceMs = params.sinceMs ?? systemNowMs() - 60_000;

      const events = await scanSessionIndexByChat(dataDir, params.chatId, sinceMs, limit);

      // Advance the cursor to the highest timestamp seen (for next poll).
      let nextSinceMs = sinceMs;
      for (const e of events) {
        const ts = Date.parse(String(e.ts));
        if (ts > nextSinceMs) nextSinceMs = ts;
      }

      const result = { events, nextSinceMs };
      if (IS_DEV) ObsTraceTailContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.trace.export — delegates to the exportTrajectoryBundle DI seam
    // -----------------------------------------------------------------------
    [ObsTraceExportContract.method]: async (rawParams) => {
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin access required");

      const params = ObsTraceExportContract.request.parse(stripInternalFields(rawParams));

      if (!deps.exportTrajectoryBundle) {
        throw new Error("exportTrajectoryBundle DI not configured");
      }

      // Derive sessionFile path from dataDir + sessionId.
      // Convention: <dataDir>/sessions/<sessionId>.jsonl.
      const sessionsDir = safePath(dataDir, "sessions");
      const sessionFile = safePath(sessionsDir, `${params.sessionId}.jsonl`);

      // workspaceDir defaults to <dataDir>/workspace; traceId and agentId are
      // best-effort placeholders when not resolvable from the session index at
      // this handler layer (bundle-exporter uses them for naming only).
      const workspaceDir = safePath(dataDir, "workspace");

      const exportResult = await deps.exportTrajectoryBundle({
        sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionId,
        workspaceDir,
        traceId: params.sessionId, // best-effort; bundle exporter uses for naming
        agentId: "unknown", // best-effort; available in session file header
      } as Parameters<typeof deps.exportTrajectoryBundle>[0]);

      if (!exportResult.ok) {
        throw new Error(`Bundle export failed: ${exportResult.error.kind}`);
      }

      const result = { bundlePath: exportResult.value.bundleDir };
      if (IS_DEV) ObsTraceExportContract.response.parse(result);
      return result;
    },
  };
}
