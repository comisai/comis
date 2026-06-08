// SPDX-License-Identifier: Apache-2.0
// @allow-throw: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.
/**
 * Observability query tool: multi-action tool for platform diagnostics and metrics.
 *
 * Supports 8 action categories: diagnostics, billing, delivery, channels,
 * explain, trace, session_report, fleet_health.
 * Read-only observability tool -- no approval gate needed.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to obs.* RPC handlers via rpcCall (explain and session_report both
 * dispatch to obs.explain — the IncidentReport IS the session rollup, so
 * session_report needs no new contract).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { tryGetContext } from "@comis/core";
import {
  jsonResult,
  readStringParam,
  readNumberParam,
  readEnumParam,
  throwToolError,
  createTrustGuard,
} from "../tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ObsQueryToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("diagnostics"),
      Type.Literal("billing"),
      Type.Literal("delivery"),
      Type.Literal("channels"),
      Type.Literal("explain"),
      Type.Literal("trace"),
      Type.Literal("session_report"),
      Type.Literal("fleet_health"),
    ],
    { description: "Observability query category. Valid values: diagnostics (platform diagnostic data), billing (cost data by provider/agent/session), delivery (message delivery traces), channels (channel activity and staleness), explain (assembled IncidentReport / root-cause post-mortem for a session), trace (search trace rows), session_report (session rollup — reuses the IncidentReport), fleet_health (cross-session fleet-health triage: degradation rate, recurring WARNs, model/config health over a window)" },
  ),
  sub_action: Type.Optional(
    Type.String({
      description:
        "Sub-action within the category. " +
        "billing: byProvider | byAgent | bySession | total. " +
        "delivery: recent | stats. " +
        "channels: all | stale | get.",
    }),
  ),
  agent_id: Type.Optional(
    Type.String({ description: "Agent identifier (for billing.byAgent)" }),
  ),
  session_key: Type.Optional(
    Type.String({ description: "Session key (for billing.bySession)" }),
  ),
  channel_id: Type.Optional(
    Type.String({ description: "Channel identifier (for channels.get, delivery.recent)" }),
  ),
  since_ms: Type.Optional(
    Type.Integer({ description: "Time filter: only include data since this epoch timestamp (ms)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum number of results to return" }),
  ),
  category: Type.Optional(
    Type.String({ description: "Diagnostic category filter (for diagnostics)" }),
  ),
  threshold_ms: Type.Optional(
    Type.Integer({ description: "Staleness threshold in ms (for channels.stale, default 300000)" }),
  ),
  trace_id: Type.Optional(
    Type.String({ description: "Trace ID (for explain, trace, session_report)" }),
  ),
  depth: Type.Optional(
    Type.String({ description: "Report depth for explain/session_report: summary | full" }),
  ),
  since_hours: Type.Optional(
    Type.Integer({ description: "Window in hours for fleet_health (default 24)" }),
  ),
});

type ObsQueryToolParamsType = Static<typeof ObsQueryToolParams>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an observability query tool with 8 action categories.
 *
 * Actions:
 * - **diagnostics** -- Query platform diagnostic data with optional category/limit filters
 * - **billing** -- Query billing data by provider, agent, session, or total
 * - **delivery** -- Query message delivery traces (recent) or aggregated stats
 * - **channels** -- Query channel activity: all channels, stale channels, or a specific channel
 * - **explain** -- Assemble an IncidentReport (root-cause post-mortem) for a session via obs.explain
 * - **trace** -- Search trace rows via obs.trace.search
 * - **session_report** -- Session rollup; reuses obs.explain (the IncidentReport IS the rollup)
 * - **fleet_health** -- Cross-session fleet-health triage via obs.fleet.health (admin)
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the observability query interface
 */
const VALID_ACTIONS = ["diagnostics", "billing", "delivery", "channels", "explain", "trace", "session_report", "fleet_health"] as const;
const VALID_BILLING_SUB_ACTIONS = ["byProvider", "byAgent", "bySession", "total"] as const;
const VALID_DELIVERY_SUB_ACTIONS = ["recent", "stats"] as const;
const VALID_CHANNELS_SUB_ACTIONS = ["all", "stale", "get"] as const;

export function createObsQueryTool(rpcCall: RpcCall): AgentTool<typeof ObsQueryToolParams> {
  const trustGuard = createTrustGuard("obs_query");

  return {
    name: "obs_query",
    label: "Observability Query",
    description:
      "Query platform diagnostics, billing, delivery traces, channel activity.",
    parameters: ObsQueryToolParams,

    async execute(
      _toolCallId: string,
      params: ObsQueryToolParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // Trust guard: enforce admin trust level (throws if insufficient)
        trustGuard();

        const p = params as unknown as Record<string, unknown>;
        const action = readEnumParam(p, "action", VALID_ACTIONS);

        if (action === "diagnostics") {
          const category = readStringParam(p, "category", false);
          const limit = readNumberParam(p, "limit", false);
          const sinceMs = readNumberParam(p, "since_ms", false);
          const ctx = tryGetContext();
          const result = await rpcCall("obs.diagnostics", {
            category,
            limit,
            sinceMs,
            _trustLevel: ctx?.trustLevel ?? "guest",
          });
          return jsonResult(result);
        }

        if (action === "billing") {
          const rawSubAction = readStringParam(p, "sub_action", false) ?? "total";
          // Validate sub_action against known billing sub-actions
          if (!VALID_BILLING_SUB_ACTIONS.includes(rawSubAction as typeof VALID_BILLING_SUB_ACTIONS[number])) {
            throwToolError("invalid_value", `Unknown billing sub_action: "${rawSubAction}".`, {
              validValues: [...VALID_BILLING_SUB_ACTIONS],
              param: "sub_action",
              hint: "Use one of the listed values for sub_action.",
            });
          }
          const subAction = rawSubAction as typeof VALID_BILLING_SUB_ACTIONS[number];
          const ctx = tryGetContext();
          const tl = ctx?.trustLevel ?? "guest";

          if (subAction === "byProvider") {
            const sinceMs = readNumberParam(p, "since_ms", false);
            const result = await rpcCall("obs.billing.byProvider", { sinceMs, _trustLevel: tl });
            return jsonResult(result);
          }
          if (subAction === "byAgent") {
            const agentId = readStringParam(p, "agent_id");
            const sinceMs = readNumberParam(p, "since_ms", false);
            const result = await rpcCall("obs.billing.byAgent", { agentId, sinceMs, _trustLevel: tl });
            return jsonResult(result);
          }
          if (subAction === "bySession") {
            const sessionKey = readStringParam(p, "session_key");
            const sinceMs = readNumberParam(p, "since_ms", false);
            const result = await rpcCall("obs.billing.bySession", { sessionKey, sinceMs, _trustLevel: tl });
            return jsonResult(result);
          }
          // subAction === "total"
          const sinceMs = readNumberParam(p, "since_ms", false);
          const result = await rpcCall("obs.billing.total", { sinceMs, _trustLevel: tl });
          return jsonResult(result);
        }

        if (action === "delivery") {
          const rawSubAction = readStringParam(p, "sub_action", false) ?? "recent";
          if (!VALID_DELIVERY_SUB_ACTIONS.includes(rawSubAction as typeof VALID_DELIVERY_SUB_ACTIONS[number])) {
            throwToolError("invalid_value", `Unknown delivery sub_action: "${rawSubAction}".`, {
              validValues: [...VALID_DELIVERY_SUB_ACTIONS],
              param: "sub_action",
              hint: "Use one of the listed values for sub_action.",
            });
          }
          const subAction = rawSubAction as typeof VALID_DELIVERY_SUB_ACTIONS[number];
          const ctx = tryGetContext();
          const tl = ctx?.trustLevel ?? "guest";

          if (subAction === "recent") {
            const sinceMs = readNumberParam(p, "since_ms", false);
            const limit = readNumberParam(p, "limit", false);
            const channelId = readStringParam(p, "channel_id", false);
            const result = await rpcCall("obs.delivery.recent", { sinceMs, limit, channelId, _trustLevel: tl });
            return jsonResult(result);
          }
          // subAction === "stats"
          const result = await rpcCall("obs.delivery.stats", { _trustLevel: tl });
          return jsonResult(result);
        }

        if (action === "channels") {
          const rawSubAction = readStringParam(p, "sub_action", false) ?? "all";
          if (!VALID_CHANNELS_SUB_ACTIONS.includes(rawSubAction as typeof VALID_CHANNELS_SUB_ACTIONS[number])) {
            throwToolError("invalid_value", `Unknown channels sub_action: "${rawSubAction}".`, {
              validValues: [...VALID_CHANNELS_SUB_ACTIONS],
              param: "sub_action",
              hint: "Use one of the listed values for sub_action.",
            });
          }
          const subAction = rawSubAction as typeof VALID_CHANNELS_SUB_ACTIONS[number];
          const ctx = tryGetContext();
          const tl = ctx?.trustLevel ?? "guest";

          if (subAction === "all") {
            const result = await rpcCall("obs.channels.all", { _trustLevel: tl });
            return jsonResult(result);
          }
          if (subAction === "stale") {
            const thresholdMs = readNumberParam(p, "threshold_ms", false);
            const result = await rpcCall("obs.channels.stale", {
              thresholdMs: thresholdMs ?? 300_000,
              _trustLevel: tl,
            });
            return jsonResult(result);
          }
          // subAction === "get"
          const channelId = readStringParam(p, "channel_id");
          const result = await rpcCall("obs.channels.get", { channelId, _trustLevel: tl });
          return jsonResult(result);
        }

        if (action === "explain") {
          const sessionKey = readStringParam(p, "session_key", false);
          const traceId = readStringParam(p, "trace_id", false);
          const depth = readStringParam(p, "depth", false);
          const ctx = tryGetContext();
          const result = await rpcCall("obs.explain", {
            sessionKey,
            traceId,
            depth,
            _trustLevel: ctx?.trustLevel ?? "guest",
          });
          return jsonResult(result);
        }

        if (action === "fleet_health") {
          const sinceHours = readNumberParam(p, "since_hours", false);
          const ctx = tryGetContext();
          const result = await rpcCall("obs.fleet.health", {
            sinceHours,
            _trustLevel: ctx?.trustLevel ?? "guest",
          });
          return jsonResult(result);
        }

        if (action === "trace") {
          const traceId = readStringParam(p, "trace_id", false);
          const sinceMs = readNumberParam(p, "since_ms", false);
          const limit = readNumberParam(p, "limit", false);
          const ctx = tryGetContext();
          const result = await rpcCall("obs.trace.search", {
            traceId,
            sinceMs,
            limit,
            _trustLevel: ctx?.trustLevel ?? "guest",
          });
          return jsonResult(result);
        }

        // action === "session_report"
        // session_report reuses obs.explain -- the IncidentReport IS the session
        // rollup (cost/toolStats/outcome/timing/degraded). No new contract.
        const sessionKey = readStringParam(p, "session_key", false);
        const traceId = readStringParam(p, "trace_id", false);
        const depth = readStringParam(p, "depth", false) ?? "summary";
        const ctx = tryGetContext();
        const result = await rpcCall("obs.explain", {
          sessionKey,
          traceId,
          depth,
          _trustLevel: ctx?.trustLevel ?? "guest",
        });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
