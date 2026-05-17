// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline list controller (Phase 44 / WEB-DECOMP-01 / Wave 5 / Task 4).
 *
 * Thin RPC façade — the pipeline-list view retains @state for its
 * pipeline list, search/sort state, variable-prompt flow, delete
 * confirm-dialog target, and pending-execute payload buffer because
 * the existing render + DOM-coupled flows keep state on the view.
 * The controller's job is to keep `rpcClient.call(...)` out of
 * `pipeline-list.ts` so the WEB-DECOMP-03 boundary test passes.
 *
 * Controller cap is 700L (tighter than the default 900) per
 * PATTERNS.md §S1 line 101 — pipeline-list has lower @state density
 * (10 fields, most state in row components) than the Wave 2-4 views.
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";
import type {
  SavedGraphSummary,
  PipelineNode,
  PipelineEdge,
  GraphSettings,
} from "../../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC response + arg shapes                                          */
/* ------------------------------------------------------------------ */

export interface GraphListResult {
  entries?: SavedGraphSummary[];
  total?: number;
}

export interface GraphStatusEntry {
  graphId: string;
  label?: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
}

export interface GraphStatusResult {
  graphs?: GraphStatusEntry[];
}

/** Generic shape used by both quick-execute load (loose) and duplicate load
 *  (typed PipelineNode/Edge). The view casts to the strict variant when
 *  needed; the controller forwards the raw RPC payload unchanged. */
export interface GraphLoadResult {
  nodes: PipelineNode[];
  edges?: PipelineEdge[];
  settings: GraphSettings;
}

export interface ChannelsAllEntry {
  channelId: string;
  channelType: string;
}

export interface ChannelsAllResult {
  channels: ChannelsAllEntry[];
}

export interface GraphExecuteResult {
  graphId?: string;
}

export interface GraphSavePayload {
  id: string;
  label: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: GraphSettings;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface PipelineListController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** List server-saved named graphs (graph.list). */
  listGraphs(limit: number): Promise<GraphListResult>;
  /** Snapshot of currently-known graph runtime statuses (graph.status). */
  getGraphStatus(): Promise<GraphStatusResult>;
  /** Load a saved graph for execute or duplicate (graph.load). The result
   *  shape is the raw RPC payload — callers narrow it per use site. */
  loadGraph(graphId: string): Promise<GraphLoadResult>;
  /** Get all known channels (obs.channels.all) — used to resolve a default
   *  channel context for approval-gate nodes when executing from the web. */
  getAllChannels(): Promise<ChannelsAllResult | ChannelsAllEntry[]>;
  /** Execute a graph (graph.execute) — payload is opaque per spec. */
  executeGraph(payload: Record<string, unknown>): Promise<GraphExecuteResult>;
  /** Save (or duplicate) a graph (graph.save). */
  saveGraph(payload: GraphSavePayload): Promise<void>;
  /** Delete a saved graph (graph.delete). */
  deleteGraph(graphId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createPipelineListController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): PipelineListController {
  const controller: PipelineListController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view has no controller-owned timers/subs */
    },

    listGraphs(limit: number): Promise<GraphListResult> {
      return rpcClient.call<GraphListResult>("graph.list", { limit });
    },

    getGraphStatus(): Promise<GraphStatusResult> {
      return rpcClient.call<GraphStatusResult>("graph.status", {});
    },

    loadGraph(graphId: string): Promise<GraphLoadResult> {
      return rpcClient.call<GraphLoadResult>("graph.load", { id: graphId });
    },

    getAllChannels(): Promise<ChannelsAllResult | ChannelsAllEntry[]> {
      return rpcClient.call<ChannelsAllResult | ChannelsAllEntry[]>(
        "obs.channels.all",
      );
    },

    executeGraph(payload: Record<string, unknown>): Promise<GraphExecuteResult> {
      return rpcClient.call<GraphExecuteResult>("graph.execute", payload);
    },

    async saveGraph(payload: GraphSavePayload): Promise<void> {
      await rpcClient.call("graph.save", payload);
    },

    async deleteGraph(graphId: string): Promise<void> {
      await rpcClient.call("graph.delete", { id: graphId });
    },
  };

  host.addController(controller);
  return controller;
}
