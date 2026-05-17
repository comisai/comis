// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline builder controller.
 *
 * Thin RPC façade — the pipeline-builder view retains @state for its
 * viewport + nodes/edges mirrors (the `createGraphBuilderState`
 * subscription target), interaction-mode flags, validation result,
 * settings, draft ID, dirty tracking, template-picker overlay, and
 * variable-prompt overlay because the existing
 * `createGraphBuilderState` consumer pattern + the 11 `@property()`
 * bindings to ic-graph-canvas + the DOM-direct pointer hot path all
 * keep state on the view. The controller's job is to keep
 * `rpcClient.call(...)` out of `pipeline-builder.ts` so the
 * view ↔ controller boundary test passes; ic-graph-canvas integration
 * is preserved verbatim.
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";
import type {
  PipelineNode,
  PipelineEdge,
  GraphSettings,
} from "../../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC response + arg shapes                                          */
/* ------------------------------------------------------------------ */

/** Raw graph.load response — server may emit nodes in execution
 *  format (nodeId, agent, dependsOn) rather than canvas format
 *  (id, agentId, position); the view performs the mapping. The
 *  controller forwards the raw payload. */
export interface GraphLoadRaw {
  label?: string;
  nodes: Array<Record<string, unknown>>;
  edges: PipelineEdge[];
  settings: GraphSettings;
}

/** graph.define response — used to populate the validate-result toast. */
export interface GraphDefineResult {
  nodeCount?: number;
  executionOrder?: string[];
  // The full response shape is opaque; callers cast as needed.
  [key: string]: unknown;
}

export interface GraphExecuteResult {
  graphId: string;
}

export interface GraphSavePayload {
  id: string;
  label?: string;
  nodes: ReadonlyArray<PipelineNode>;
  edges: ReadonlyArray<PipelineEdge>;
  settings: GraphSettings;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface PipelineBuilderController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Validate / define a graph definition (graph.define). */
  defineGraph(payload: Record<string, unknown>): Promise<GraphDefineResult>;
  /** Load a saved graph definition (graph.load). */
  loadGraph(graphId: string): Promise<GraphLoadRaw>;
  /** Save (or upsert) a draft graph (graph.save). */
  saveGraph(payload: GraphSavePayload): Promise<void>;
  /** Execute a graph (graph.execute) — payload is the full execution
   *  spec including substituted variables. */
  executeGraph(payload: Record<string, unknown>): Promise<GraphExecuteResult>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createPipelineBuilderController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): PipelineBuilderController {
  const controller: PipelineBuilderController = {
    hostConnected(): void {
      /* no-op; the view manages createGraphBuilderState lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own subscription teardown */
    },

    defineGraph(payload: Record<string, unknown>): Promise<GraphDefineResult> {
      return rpcClient.call<GraphDefineResult>("graph.define", payload);
    },

    loadGraph(graphId: string): Promise<GraphLoadRaw> {
      return rpcClient.call<GraphLoadRaw>("graph.load", { id: graphId });
    },

    async saveGraph(payload: GraphSavePayload): Promise<void> {
      await rpcClient.call("graph.save", payload);
    },

    executeGraph(payload: Record<string, unknown>): Promise<GraphExecuteResult> {
      return rpcClient.call<GraphExecuteResult>("graph.execute", payload);
    },
  };

  host.addController(controller);
  return controller;
}
