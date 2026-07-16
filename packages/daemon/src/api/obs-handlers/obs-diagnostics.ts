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
          data: { message: r.message, details: r.details, severity: r.severity },
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
        const activeIds = new Set(inMemoryChannels.map((c) => c.channelId));
        const historicalChannels = sqliteSnapshots
          .filter((s) => !activeIds.has(s.channelId ?? s.channelType))
          .map((s) => ({
            channelId: s.channelId ?? s.channelType,
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

      // Bespoke pre-Zod guard preserves the exact error message
      // ("Invalid request: channelId parameter is required").
      const channelIdRaw = rawParams.channelId as string | undefined;
      if (!channelIdRaw) throw new ValidationError("Invalid request: channelId parameter is required");

      const userParams = stripInternalFields(rawParams);
      const params = ObsChannelsGetContract.request.parse(userParams);
      const channelId = params.channelId;

      const result = { channel: deps.channelActivityTracker.get(channelId) ?? null };
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

      const inMemoryRecords = deps.deliveryTracer.getRecent({ sinceMs, limit, channelId });

      let result: { deliveries: unknown[] };
      if (!obsStore || startupTimestamp == null) {
        result = { deliveries: inMemoryRecords };
      } else {
        // Query SQLite for historical records
        const sqliteRows = obsStore.queryDelivery({
          sinceMs: sinceMs != null ? systemNowMs() - sinceMs : undefined,
          limit: limit ?? 50,
        });

        // Filter SQLite rows to only those before startup (avoid overlap)
        const historicalRows = sqliteRows.filter((r) => r.timestamp < startupTimestamp);

        // Map SQLite DeliveryRow to DeliveryContext-like shape
        const historicalRecords = historicalRows.map((r) => ({
          sourceChannelId: r.channelId,
          sourceChannelType: r.channelType,
          targetChannelId: r.channelId,
          targetChannelType: r.channelType,
          deliveredAt: r.timestamp,
          latencyMs: r.latencyMs,
          success: r.status === "success",
          error: r.errorMessage || undefined,
          agentId: r.agentId,
          sessionKey: r.sessionKey || undefined,
        }));

        // Filter by channelId if specified
        const filteredHistorical = channelId
          ? historicalRecords.filter((r) => r.sourceChannelId === channelId || r.targetChannelId === channelId)
          : historicalRecords;

        // Merge: concat, sort by timestamp desc, apply limit
        const merged = [...inMemoryRecords, ...filteredHistorical]
          .sort((a, b) => b.deliveredAt - a.deliveredAt)
          .slice(0, limit ?? 50);

        result = { deliveries: merged };
      }

      if (IS_DEV) ObsDeliveryRecentContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // obs.delivery.stats — dual-source: sum SQLite + in-memory stats
    // -----------------------------------------------------------------------
    [ObsDeliveryStatsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for delivery data");
      }

      const userParams = stripInternalFields(rawParams);
      ObsDeliveryStatsContract.request.parse(userParams);

      const inMemoryStats = deps.deliveryTracer.getStats();

      let result: { total: number; successes: number; failures: number; avgLatencyMs: number };
      if (!obsStore || startupTimestamp == null) {
        result = inMemoryStats;
      } else {
        const sqliteStats = obsStore.deliveryStats();

        result = {
          total: inMemoryStats.total + sqliteStats.total,
          successes: inMemoryStats.successes + sqliteStats.success,
          failures: inMemoryStats.failures + sqliteStats.error,
          avgLatencyMs: inMemoryStats.total + sqliteStats.total > 0
            ? Math.round(
                (inMemoryStats.avgLatencyMs * inMemoryStats.total +
                  sqliteStats.avgLatencyMs * sqliteStats.total) /
                (inMemoryStats.total + sqliteStats.total),
              )
            : 0,
        };
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
