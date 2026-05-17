// SPDX-License-Identifier: Apache-2.0
/**
 * Agent list controller (Phase 44 / WEB-DECOMP-01 / Wave 5 / Task 3).
 *
 * Thin RPC façade — the agent-list view retains @state for its agent
 * list, search/filter state, action-pending lock, delete-target,
 * model-catalog cache, and 8-field create-agent wizard flow because
 * the existing render + REST-driven (apiClient) interactions keep
 * state on the view. The controller's job is to keep
 * `rpcClient.call(...)` out of `agent-list.ts` so the WEB-DECOMP-03
 * boundary test passes.
 *
 * Note: agent list bootstrap goes through `apiClient.getAgents()` (REST)
 * — orthogonal to the rpcClient.call boundary regex.
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";
import type { AgentBilling } from "../../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC arg shapes                                                     */
/* ------------------------------------------------------------------ */

/** Shape returned by models.list RPC (subset used by agent-list wizard).
 *  Mirrors the view-local CatalogProvider; intentional 1:1. */
export interface CatalogProvider {
  name: string;
  modelCount: number;
  models: Array<{ modelId: string; displayName: string }>;
}

export interface ModelCatalogResult {
  providers?: CatalogProvider[];
  totalModels?: number;
}

export interface AgentCreatePayload {
  agentId: string;
  config: {
    name?: string;
    provider: string;
    model: string;
    skills?: {
      toolPolicy?: { profile?: string };
    };
  };
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface AgentListController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Fetch model + provider catalog (models.list) — wizard population. */
  listModels(): Promise<ModelCatalogResult>;
  /** Per-agent billing rollup (obs.billing.byAgent). */
  getAgentBilling(agentId: string): Promise<AgentBilling>;
  /** Suspend an agent (agents.suspend). */
  suspendAgent(agentId: string): Promise<void>;
  /** Resume a suspended agent (agents.resume). */
  resumeAgent(agentId: string): Promise<void>;
  /** Delete an agent permanently (agents.delete). */
  deleteAgent(agentId: string): Promise<void>;
  /** Create a new agent with the provided config (agents.create). */
  createAgent(payload: AgentCreatePayload): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createAgentListController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): AgentListController {
  const controller: AgentListController = {
    hostConnected(): void {
      /* no-op; the view drives loading + SSE-debounced reload via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own debounce timer */
    },

    listModels(): Promise<ModelCatalogResult> {
      return rpcClient.call<ModelCatalogResult>("models.list");
    },

    getAgentBilling(agentId: string): Promise<AgentBilling> {
      return rpcClient.call<AgentBilling>("obs.billing.byAgent", { agentId });
    },

    async suspendAgent(agentId: string): Promise<void> {
      await rpcClient.call("agents.suspend", { agentId });
    },

    async resumeAgent(agentId: string): Promise<void> {
      await rpcClient.call("agents.resume", { agentId });
    },

    async deleteAgent(agentId: string): Promise<void> {
      await rpcClient.call("agents.delete", { agentId });
    },

    async createAgent(payload: AgentCreatePayload): Promise<void> {
      await rpcClient.call("agents.create", payload);
    },
  };

  host.addController(controller);
  return controller;
}
