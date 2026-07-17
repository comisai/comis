// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Observability diagnostics RPC handlers.
 *
 * Handlers covering live observability streams:
 *   - obs.diagnostics: query diagnostic events by category/time/limit
 *   - obs.channels.all: all tracked channel activity (dual-source)
 *   - obs.channels.stale: channels inactive beyond threshold (in-memory only)
 *   - obs.channels.get: single channel activity lookup (in-memory only)
 *   - obs.delivery.recent: recent delivery records with filtering (dual-source)
 *   - obs.delivery.stats: delivery statistics summary (dual-source)
 *   - obs.context.pipeline: context engine pipeline snapshots (no admin gate)
 *   - obs.context.dag: context engine DAG compaction snapshots (no admin gate)
 *
 * @module
 */

import { AuthorizationError, ValidationError } from "../errors.js";
import {
  ObsChannelsAllContract,
  ObsChannelsGetContract,
  ObsChannelsStaleContract,
  ObsContextDagContract,
  ObsContextPipelineContract,
  ObsDeliveryRecentContract,
  ObsDeliveryStatsContract,
  ObsDiagnosticsContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import type { DiagnosticCategory } from "../../observability/diagnostic-collector.js";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";

/**
 * Bind the observability diagnostics RPC handlers. Object-spread compatible
 * with `Record<string, RpcHandler>`.
 */
export function bindObsDiagnosticsHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  const { obsStore, startupTimestamp } = deps;

  return {
    // -----------------------------------------------------------------------
    // obs.diagnostics — dual-source: historical SQLite + in-memory
    // -----------------------------------------------------------------------
    [ObsDiagnosticsContract.method]: async (rawParams) => {
      // No admin gate: obs.diagnostics is intentionally rpc-scoped
      // so an agent's obs_query can self-diagnose its OWN sessions
      // (an admin gate would defeat that — the caller is in-process, not admin-trust).
      // Read-only, scrubbed digests on a single-tenant daemon; any authenticated
      // (rpc-or-higher) caller may read. Authn/scope is enforced at the gateway token
      // layer, and deny-by-origin is intentionally NOT applied (see
      // test/architecture/agent-obs-tools-deny-by-origin.test.ts).

      // Strip dispatcher-injected internals BEFORE contract parse.
      const userParams = stripInternalFields(rawParams);
      const params = ObsDiagnosticsContract.request.parse(userParams);
      const category = params.category as DiagnosticCategory | undefined;
      const limit = params.limit;
      const sinceMs = params.sinceMs;

      // In-memory current-session events
      const inMemoryEvents = deps.diagnosticCollector.getRecent({ category, limit, sinceMs });
      const counts = deps.diagnosticCollector.getCounts();

      let result: { events: unknown[]; counts: unknown };
      if (!obsStore || startupTimestamp == null) {
        result = { events: inMemoryEvents, counts };
      } else {
        // SQLite historical events (pre-current-session)
        const sqliteRows = obsStore.queryDiagnostics({
          category: category ?? undefined,
          sinceMs: sinceMs != null ? systemNowMs() - sinceMs : undefined,
          limit: limit ?? 50,
        });

        // Filter SQLite rows to only those before startup (avoid overlap with in-memory)
        const historicalRows = sqliteRows.filter((r) => r.timestamp < startupTimestamp);

        // Map SQLite DiagnosticRow to DiagnosticEvent-like shape for uniform return
        const historicalEvents = historicalRows.map((r) => ({
          id: `sqlite-${r.id ?? r.timestamp}`,
          category: r.category as DiagnosticCategory,
          eventType: `sqlite:${r.category}`,
          timestamp: r.timestamp,
          agentId: r.agentId || undefined,
          channelId: undefined as string | undefined,
          sessionKey: r.sessionKey || undefined,
          traceId: r.traceId || undefined,
          data: {
            severity: r.severity,
            hasDetails: (r.details?.length ?? 0) > 0,
          },
        }));

        // Merge: concat, sort by timestamp desc, apply limit
        const merged = [...inMemoryEvents, ...historicalEvents]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit ?? 50);

        result = { events: merged, counts };
      }

      if (IS_DEV) ObsDiagnosticsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.channels.all — dual-source: in-memory authoritative + SQLite historical
    // -----------------------------------------------------------------------
    [ObsChannelsAllContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for channel activity");
      }

      const userParams = stripInternalFields(rawParams);
      ObsChannelsAllContract.request.parse(userParams);

      const inMemoryChannels = deps.channelActivityTracker.getAll();

      let result: { channels: unknown[] };
      if (!obsStore || startupTimestamp == null) {
        result = { channels: inMemoryChannels };
      } else {
        const sqliteSnapshots = obsStore.latestChannelSnapshots();

        // In-memory is authoritative for currently-active channels.
        // SQLite provides snapshots for channels not in current session.
        const activeIdentities = new Set(inMemoryChannels.map(
          (channel) => JSON.stringify([channel.channelType, channel.channelId]),
        ));
        const historicalChannels = sqliteSnapshots
          .filter((snapshot) => !activeIdentities.has(JSON.stringify([
            snapshot.channelType,
            snapshot.channelId,
          ])))
          .map((s) => ({
            channelId: s.channelId,
            channelType: s.channelType,
            lastActiveAt: s.timestamp,
            messagesSent: s.messagesSent ?? 0,
            messagesReceived: s.messagesReceived ?? 0,
          }));

        result = { channels: [...inMemoryChannels, ...historicalChannels] };
      }

      if (IS_DEV) ObsChannelsAllContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.channels.stale — in-memory only (needs real-time lastActiveAt)
    // -----------------------------------------------------------------------
    [ObsChannelsStaleContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for channel activity");
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsChannelsStaleContract.request.parse(userParams);
      const thresholdMs = params.thresholdMs ?? 300_000; // Default 5 minutes

      const result = { stale: deps.channelActivityTracker.getStale(thresholdMs) };
      if (IS_DEV) ObsChannelsStaleContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.channels.get — in-memory only (current session state)
    // -----------------------------------------------------------------------
    [ObsChannelsGetContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for channel activity");
      }

      // Bespoke pre-Zod guards keep missing identity errors concise at the RPC boundary.
      const channelIdRaw = rawParams.channelId as string | undefined;
      if (!channelIdRaw) throw new ValidationError("Invalid request: channelId parameter is required");
      const channelTypeRaw = rawParams.channelType as string | undefined;
      if (!channelTypeRaw) throw new ValidationError("Invalid request: channelType parameter is required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsChannelsGetContract.request.parse(userParams);
      const channelType = params.channelType;
      const channelId = params.channelId;

      const result = { channel: deps.channelActivityTracker.get(channelType, channelId) ?? null };
      if (IS_DEV) ObsChannelsGetContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.delivery.recent — dual-source: historical SQLite + in-memory
    // -----------------------------------------------------------------------
    [ObsDeliveryRecentContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for delivery data");
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsDeliveryRecentContract.request.parse(userParams);
      const sinceMs = params.sinceMs;
      const limit = params.limit;
      const channelId = params.channelId;
      const channelType = params.channelType;
      const requestedLimit = limit ?? 50;

      const inMemoryRecords = deps.deliveryTracer.getRecent({ sinceMs, limit, channelId, channelType });

      let result: { deliveries: unknown[] };
      if (!obsStore) {
        result = { deliveries: inMemoryRecords };
      } else {
        // SQLite is canonical for every flushed diagnostic, including rows from
        // this process that have already left the bounded live ring. Fetch enough
        // rows to backfill any live/durable overlap removed below.
        const sqliteRows = obsStore.queryDelivery({
          sinceMs: sinceMs != null ? systemNowMs() - sinceMs : undefined,
          channelId,
          channelType,
          limit: requestedLimit + inMemoryRecords.length,
        });

        // Map SQLite DeliveryRow to DeliveryContext-like shape
        type DeliveryRecord = ReturnType<typeof deps.deliveryTracer.getRecent>[number];
        const historicalRecords: DeliveryRecord[] = sqliteRows.map((r) => ({
          sourceChannelId: r.channelId,
          sourceChannelType: r.channelType,
          targetChannelId: r.channelId,
          targetChannelType: r.channelType,
          deliveredAt: r.timestamp,
          latencyMs: r.latencyMs,
          status: r.status,
          error: r.errorMessage || null,
          agentId: r.agentId || null,
          sessionKey: r.sessionKey || null,
          traceId: r.traceId || null,
          toolCalls: r.toolCalls ?? null,
          llmCalls: r.llmCalls ?? null,
          tokensTotal: r.tokensTotal ?? null,
          costTotal: r.costTotal ?? null,
          failureStage: r.failureStage ?? null,
          errorKind: r.errorKind ?? null,
          steps: null,
          evidence: "diagnostic" as const,
        }));

        const identity = (record: DeliveryRecord): string =>
          record.traceId !== null && record.traceId.length > 0
            ? JSON.stringify([
                "trace",
                record.sourceChannelType,
                record.sourceChannelId,
                record.targetChannelType,
                record.targetChannelId,
                record.traceId,
              ])
            : JSON.stringify([
                "row",
                record.sourceChannelType,
                record.sourceChannelId,
                record.targetChannelType,
                record.targetChannelId,
                record.deliveredAt,
                record.sessionKey ?? "",
                record.agentId ?? "",
                record.status,
                record.latencyMs,
                record.toolCalls ?? "",
                record.llmCalls ?? "",
              ]);
        const merged = [...historicalRecords];
        const historicalIndices = new Map<string, number[]>();
        for (const [index, record] of historicalRecords.entries()) {
          const key = identity(record);
          const indices = historicalIndices.get(key) ?? [];
          indices.push(index);
          historicalIndices.set(key, indices);
        }
        for (const record of inMemoryRecords) {
          const key = identity(record);
          const durableIndex = historicalIndices.get(key)?.shift();
          if (durableIndex === undefined) {
            merged.push(record);
          } else if (record.evidence === "diagnostic") {
            // Pair live and durable evidence one-to-one. A trace can contain
            // repeated delivery attempts, so identity must not collapse every
            // durable row into a single map entry.
            merged.splice(durableIndex, 1, record);
          }
        }

        const recent = merged
          .sort((a, b) => b.deliveredAt - a.deliveredAt)
          .slice(0, requestedLimit);

        result = { deliveries: recent };
      }

      if (IS_DEV) ObsDeliveryRecentContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.delivery.stats — canonical durable read with an in-memory fallback
    // -----------------------------------------------------------------------
    [ObsDeliveryStatsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for delivery data");
      }

      const userParams = stripInternalFields(rawParams);
      const params = ObsDeliveryStatsContract.request.parse(userParams);

      let result: {
        total: number;
        attempted: number;
        success: number;
        error: number;
        timeout: number;
        filtered: number;
        aborted: number;
        avgLatencyMs: number;
      };
      const flushResult = obsStore && deps.obsPersistence
        ? deps.obsPersistence.flushPending("delivery")
        : undefined;
      if (obsStore && flushResult?.ok === true) {
        // Make SQLite canonical for the read. Flushing first includes every
        // current-process diagnostic exactly once and avoids timestamp-based
        // live/durable overlap heuristics when the wall clock moves backward.
        const sqliteStats = obsStore.deliveryStats(
          params.sinceMs === undefined
            ? undefined
            : { sinceMs: systemNowMs() - params.sinceMs },
        );
        const liveOnly = {
          total: 0,
          attempted: 0,
          success: 0,
          error: 0,
          timeout: 0,
          filtered: 0,
          aborted: 0,
          attemptedLatencyMs: 0,
        };
        for (const record of deps.deliveryTracer.getRecent({
          ...(params.sinceMs === undefined ? {} : { sinceMs: params.sinceMs }),
          limit: 10_000,
        })) {
          if (record.evidence === "diagnostic") continue;
          liveOnly.total++;
          switch (record.status) {
            case "success":
              liveOnly.attempted++;
              liveOnly.success++;
              liveOnly.attemptedLatencyMs += record.latencyMs;
              break;
            case "error":
              liveOnly.attempted++;
              liveOnly.error++;
              liveOnly.attemptedLatencyMs += record.latencyMs;
              break;
            case "timeout":
              liveOnly.attempted++;
              liveOnly.timeout++;
              liveOnly.attemptedLatencyMs += record.latencyMs;
              break;
            case "filtered":
              liveOnly.filtered++;
              break;
            case "aborted":
              liveOnly.aborted++;
              break;
            default: {
              const _exhaustive: never = record.status;
              void _exhaustive;
            }
          }
        }
        const attempted = sqliteStats.attempted + liveOnly.attempted;
        result = {
          total: sqliteStats.total + liveOnly.total,
          attempted,
          success: sqliteStats.success + liveOnly.success,
          error: sqliteStats.error + liveOnly.error,
          timeout: sqliteStats.timeout + liveOnly.timeout,
          filtered: sqliteStats.filtered + liveOnly.filtered,
          aborted: sqliteStats.aborted + liveOnly.aborted,
          avgLatencyMs: attempted > 0
            ? Math.round(
                (sqliteStats.attemptedLatencyMs + liveOnly.attemptedLatencyMs) /
                attempted,
              )
            : 0,
        };
      } else {
        const inMemoryStats = deps.deliveryTracer.getStats(
          params.sinceMs === undefined ? undefined : { sinceMs: params.sinceMs },
        );
        if (!obsStore || startupTimestamp == null) {
          result = {
            total: inMemoryStats.total,
            attempted: inMemoryStats.attempted,
            success: inMemoryStats.successes,
            error: inMemoryStats.failures,
            timeout: inMemoryStats.timeouts,
            filtered: inMemoryStats.filtered,
            aborted: inMemoryStats.aborted,
            avgLatencyMs: inMemoryStats.avgLatencyMs,
          };
        } else {
          const sqliteStats = obsStore.deliveryStats({
            ...(params.sinceMs === undefined
              ? {}
              : { sinceMs: systemNowMs() - params.sinceMs }),
            beforeMs: startupTimestamp,
          });
          const attempted = inMemoryStats.attempted + sqliteStats.attempted;

          result = {
            total: inMemoryStats.total + sqliteStats.total,
            attempted,
            success: inMemoryStats.successes + sqliteStats.success,
            error: inMemoryStats.failures + sqliteStats.error,
            timeout: inMemoryStats.timeouts + sqliteStats.timeout,
            filtered: inMemoryStats.filtered + sqliteStats.filtered,
            aborted: inMemoryStats.aborted + sqliteStats.aborted,
            avgLatencyMs: attempted > 0
              ? Math.round(
                  (inMemoryStats.attemptedLatencyMs +
                    sqliteStats.attemptedLatencyMs) /
                  attempted,
                )
              : 0,
          };
        }
      }

      if (IS_DEV) ObsDeliveryStatsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.context.pipeline — context engine pipeline snapshots.
    //
    // NOTE: NO in-handler `_trustLevel === "admin"` gate. The gateway
    // router's `registerRpcPassthrough(..., "admin")` registration is
    // the sole trust gate (setup-gateway-api.ts:121-122). Existing
    // tests at obs-handlers.test.ts:643-694 call this handler without
    // `_trustLevel` and expect success — preserve that behavior.
    // -----------------------------------------------------------------------
    [ObsContextPipelineContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = ObsContextPipelineContract.request.parse(userParams);
      const agentId = params.agentId;
      const limit = params.limit;
      const result = deps.contextPipelineCollector?.getRecentPipelines({ agentId, limit }) ?? [];
      if (IS_DEV) ObsContextPipelineContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.context.dag — context engine DAG compaction snapshots.
    //
    // NOTE: NO in-handler admin gate — same as obs.context.pipeline.
    // -----------------------------------------------------------------------
    [ObsContextDagContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = ObsContextDagContract.request.parse(userParams);
      const agentId = params.agentId;
      const limit = params.limit;
      const result = deps.contextPipelineCollector?.getRecentDagCompactions({ agentId, limit }) ?? [];
      if (IS_DEV) ObsContextDagContract.response.parse(result);
      return result;
    },
  };
}
