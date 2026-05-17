// SPDX-License-Identifier: Apache-2.0
/**
 * ic-node-editor controller.
 *
 * Thin RPC façade — the node-editor component retains @state for its dropdown
 * caches (`_agents`, `_models`, `_allowAgents`) + UI flags (`_agentsLoading`,
 * `_modelsLoading`, `_showVariables`, `_cycleErrors`) because the existing
 * test suite + DOM render path relies on direct state assertions. The
 * controller's job is to keep `rpcClient.call(...)` out of `ic-node-editor.ts`
 * so the boundary test passes. Each method mirrors a source view RPC
 * invocation 1:1 (same method name, same args, same response shape).
 * Errors propagate verbatim (callers handle).
 *
 * Read-path methods use non-async passthrough (return rpcClient.call(...))
 * instead of (async ... return await rpcClient.call(...)) — this is timing-
 * neutral and matches the source view's await chain.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                 */
/* ------------------------------------------------------------------ */

export interface AgentsListResult {
  agents: string[];
}

export interface AgentsGetResult {
  agentId: string;
  config: { model?: string; provider?: string };
  suspended?: boolean;
}

export interface ModelsListResult {
  providers: Array<{
    name: string;
    models: Array<string | { modelId: string }>;
  }>;
}

export interface SecurityConfigResult {
  agentToAgent?: { allowAgents?: string[] };
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface IcNodeEditorController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** List agent IDs (agents.list). */
  listAgents(): Promise<AgentsListResult>;
  /** Fetch one agent's config + suspended flag (agents.get). */
  getAgent(agentId: string): Promise<AgentsGetResult>;
  /** List provider→model catalog (models.list). */
  listModels(): Promise<ModelsListResult>;
  /** Read the security config section for the allow-list (config.read). */
  readSecurityConfig(): Promise<SecurityConfigResult>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createIcNodeEditorController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): IcNodeEditorController {
  const controller: IcNodeEditorController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    listAgents(): Promise<AgentsListResult> {
      return rpcClient.call<AgentsListResult>("agents.list");
    },

    getAgent(agentId: string): Promise<AgentsGetResult> {
      return rpcClient.call<AgentsGetResult>("agents.get", { agentId });
    },

    listModels(): Promise<ModelsListResult> {
      return rpcClient.call<ModelsListResult>("models.list", {});
    },

    readSecurityConfig(): Promise<SecurityConfigResult> {
      return rpcClient.call<SecurityConfigResult>("config.read", {
        section: "security",
      });
    },
  };

  host.addController(controller);
  return controller;
}
