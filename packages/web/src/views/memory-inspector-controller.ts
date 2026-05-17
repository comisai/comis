// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-inspector controller.
 *
 * Thin RPC façade — the memory-inspector view retains @state for its 33
 * fields (search/browse/filter/selection/dialogs/embedding stats) because
 * its existing test suite (41 priv() calls) relies on direct state
 * assertions. Higher-level data access goes through `apiClient` (which
 * itself wraps RPC under the hood, but the boundary regex matches only
 * `rpcClient.call` — apiClient stays on the view). The controller's job
 * is to keep the 3 raw `rpcClient.call(...)` sites out of
 * `memory-inspector.ts`.
 *
 * Each method mirrors a source view RPC invocation 1:1 (same method name,
 * same args, same response shape). Errors propagate verbatim (callers
 * handle).
 *
 * Read-path methods use non-async passthrough (`return rpcClient.call(...)`)
 * to preserve microtask timing expected by existing tests (some views'
 * tests depend on the synchronous-call-issue ordering before
 * `updateComplete` resolves).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface MemoryInspectorController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Fetch embedding-cache stats (memory.embeddingCache). */
  getEmbeddingCache(): Promise<unknown>;
  /** Create a memory entry (memory.store). */
  storeEntry(params: {
    content: string;
    tags?: string[];
    trustLevel: string;
  }): Promise<void>;
  /** Flush memory for an agent (or all if agentId is undefined) (memory.flush). */
  flushMemory(agentId?: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createMemoryInspectorController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): MemoryInspectorController {
  const controller: MemoryInspectorController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    getEmbeddingCache(): Promise<unknown> {
      return rpcClient.call("memory.embeddingCache");
    },

    async storeEntry(params: {
      content: string;
      tags?: string[];
      trustLevel: string;
    }): Promise<void> {
      await rpcClient.call("memory.store", {
        content: params.content,
        tags: params.tags && params.tags.length > 0 ? params.tags : undefined,
        trustLevel: params.trustLevel,
      });
    },

    async flushMemory(agentId?: string): Promise<void> {
      await rpcClient.call("memory.flush", {
        agent_id: agentId || undefined,
      });
    },
  };

  host.addController(controller);
  return controller;
}
