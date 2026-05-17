// SPDX-License-Identifier: Apache-2.0
/**
 * Dashboard controller.
 *
 * Thin RPC façade — the dashboard view retains @state for its KPI grid,
 * sparkline data, per-agent billing map, and connection status because
 * the existing test suite + SSE-driven UI flow (billing_snapshot,
 * token_usage events triggering sparkline reloads, parallel REST fan-
 * out via apiClient) keeps state on the view. The controller's job is
 * to keep `rpcClient.call(...)` out of `dashboard.ts` so the boundary
 * test passes. Each method mirrors a source view RPC invocation 1:1
 * (same method name, same args, same response shape). Errors propagate
 * verbatim (callers handle Promise.allSettled).
 *
 * Higher-level data flows through apiClient (`getAgents`, `getChannels`,
 * `getActivity`) — orthogonal to this controller (boundary regex
 * matches only `rpcClient!?.call`). SseController + EventDispatcher
 * preserved verbatim on the view.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                 */
/* ------------------------------------------------------------------ */

export interface BillingTotalResult {
  totalCost?: number;
  totalTokens?: number;
}

export interface BillingHourlyEntry {
  hour: number;
  tokens: number;
}

export interface BillingByAgentResult {
  totalCost: number;
  totalTokens: number;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface DashboardController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Get the total billing rollup over a window (obs.billing.total). */
  getBillingTotal(sinceMs: number): Promise<BillingTotalResult>;
  /** Get the past-24h hourly token-usage histogram (obs.billing.usage24h). */
  getUsage24h(): Promise<BillingHourlyEntry[]>;
  /** Get per-agent billing rollup (obs.billing.byAgent). */
  getBillingByAgent(agentId: string): Promise<BillingByAgentResult>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createDashboardController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): DashboardController {
  const controller: DashboardController = {
    hostConnected(): void {
      /* no-op; the view drives loading + SSE via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    getBillingTotal(sinceMs: number): Promise<BillingTotalResult> {
      return rpcClient.call<BillingTotalResult>("obs.billing.total", {
        sinceMs,
      });
    },

    getUsage24h(): Promise<BillingHourlyEntry[]> {
      return rpcClient.call<BillingHourlyEntry[]>("obs.billing.usage24h");
    },

    getBillingByAgent(agentId: string): Promise<BillingByAgentResult> {
      return rpcClient.call<BillingByAgentResult>("obs.billing.byAgent", {
        agentId,
      });
    },
  };

  host.addController(controller);
  return controller;
}
