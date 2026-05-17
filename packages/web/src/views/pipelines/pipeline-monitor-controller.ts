// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline monitor controller (Phase 44 / WEB-DECOMP-01 / Wave 6 / Task 4).
 *
 * Thin RPC façade — the pipeline-monitor view retains @state for
 * its snapshot mirror + viewport + cancel-confirm flag + ARIA live
 * announcement string because the existing render flow consumes
 * `createMonitorState` directly + ResizeObserver-driven canvas
 * dimensions + SSE subscription wiring all keep state on the view.
 * The controller's job is to keep `rpcClient.call(...)` out of
 * `pipeline-monitor.ts` so the WEB-DECOMP-03 boundary test passes.
 *
 * Note: the MonitorState primitive (packages/web/src/state/monitor-
 * state.ts) makes its own internal rpcClient.call invocations as
 * part of `startPolling()` — those are NOT direct view → daemon
 * calls and are out of Phase 44 scope (state primitives untouched).
 * The 4 direct call sites this controller wraps are graph.load,
 * graph.status, graph.cancel, and subagent.steer.
 *
 * Controller cap is 500L (TIGHT) per PATTERNS.md §S1 line 107 —
 * pipeline-monitor is the LOWEST-RISK Wave 6 extraction because the
 * pattern was prototyped via createMonitorState (RESEARCH §Source
 * Inventory line 107).
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";
import type { PipelineEdge } from "../../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC response + arg shapes                                          */
/* ------------------------------------------------------------------ */

/** Raw graph.load response — server may emit nodes in execution
 *  format (nodeId, agent, dependsOn) rather than canvas format
 *  (id, agentId, position); the view performs the mapping. */
export interface GraphLoadRaw {
  nodes: Array<Record<string, unknown>>;
  edges?: PipelineEdge[];
  settings?: Record<string, unknown>;
}

/** graph.status response — list of node IDs in execution order. */
export interface GraphStatusResponse {
  executionOrder: string[];
}

export interface SteerArgs {
  target: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface PipelineMonitorController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Load a saved graph definition (graph.load). Returns the raw
   *  payload; the view performs execution-format → canvas-format
   *  node mapping with auto-layout fallback. */
  loadGraph(graphId: string): Promise<GraphLoadRaw>;
  /** Snapshot of a graph's runtime execution order (graph.status). */
  getGraphStatus(graphId: string): Promise<GraphStatusResponse>;
  /** Cancel a running graph (graph.cancel). */
  cancelGraph(graphId: string): Promise<void>;
  /** Steer a running sub-agent (subagent.steer). */
  steerSubagent(args: SteerArgs): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createPipelineMonitorController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): PipelineMonitorController {
  const controller: PipelineMonitorController = {
    hostConnected(): void {
      /* no-op; the view manages createMonitorState lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own subscription teardown */
    },

    loadGraph(graphId: string): Promise<GraphLoadRaw> {
      return rpcClient.call<GraphLoadRaw>("graph.load", { id: graphId });
    },

    getGraphStatus(graphId: string): Promise<GraphStatusResponse> {
      return rpcClient.call<GraphStatusResponse>("graph.status", { graphId });
    },

    async cancelGraph(graphId: string): Promise<void> {
      await rpcClient.call("graph.cancel", { graphId });
    },

    async steerSubagent(args: SteerArgs): Promise<void> {
      await rpcClient.call("subagent.steer", args);
    },
  };

  host.addController(controller);
  return controller;
}
