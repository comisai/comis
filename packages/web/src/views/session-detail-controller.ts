// SPDX-License-Identifier: Apache-2.0
/**
 * Session detail controller.
 *
 * Thin RPC façade — the session-detail view retains @state for its
 * session info, messages, tab state, pipeline snapshot selection, and
 * confirmation-dialog flow because the existing render + REST-driven
 * (apiClient) interactions keep state on the view. The controller's
 * job is to keep `rpcClient.call(...)` out of `session-detail.ts`.
 *
 * Note: session reset / compact / delete / export / detail-load all
 * flow through `apiClient` (REST) — orthogonal to the rpcClient.call
 * boundary regex and out of this controller's scope.
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type {
  PipelineSnapshot,
  DagCompactionSnapshot,
} from "../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC response + arg shapes                                          */
/* ------------------------------------------------------------------ */

export interface SessionBillingResult {
  totalTokens: number;
  totalCost: number;
  callCount: number;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface SessionDetailController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Get recent context-pipeline snapshots for an agent (obs.context.pipeline).
   *  Caller filters client-side by sessionKey. */
  getPipelineSnapshots(
    agentId: string,
    limit: number,
  ): Promise<PipelineSnapshot[]>;
  /** Get recent DAG compaction snapshots for an agent (obs.context.dag).
   *  Caller filters client-side by sessionKey. */
  getDagCompactions(
    agentId: string,
    limit: number,
  ): Promise<DagCompactionSnapshot[]>;
  /** Get per-session billing rollup (obs.billing.bySession). */
  getSessionBilling(sessionKey: string): Promise<SessionBillingResult>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createSessionDetailController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): SessionDetailController {
  const controller: SessionDetailController = {
    hostConnected(): void {
      /* no-op; the view drives lazy tab-load via its own _switchTab gate */
    },
    hostDisconnected(): void {
      /* no-op; the view has no controller-owned timers/subs */
    },

    getPipelineSnapshots(
      agentId: string,
      limit: number,
    ): Promise<PipelineSnapshot[]> {
      return rpcClient.call<PipelineSnapshot[]>("obs.context.pipeline", {
        agentId,
        limit,
      });
    },

    getDagCompactions(
      agentId: string,
      limit: number,
    ): Promise<DagCompactionSnapshot[]> {
      return rpcClient.call<DagCompactionSnapshot[]>("obs.context.dag", {
        agentId,
        limit,
      });
    },

    getSessionBilling(sessionKey: string): Promise<SessionBillingResult> {
      return rpcClient.call<SessionBillingResult>("obs.billing.bySession", {
        sessionKey,
      });
    },
  };

  host.addController(controller);
  return controller;
}
