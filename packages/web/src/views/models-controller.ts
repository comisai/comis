// SPDX-License-Identifier: Apache-2.0
/**
 * Models controller (Phase 44 / WEB-DECOMP-01).
 *
 * Thin RPC façade — the models view retains @state for provider/alias/
 * model-catalog state because its existing test suite (37 priv() calls)
 * relies on direct state assertions and form mutations. The controller's
 * job is to keep `rpcClient.call(...)` out of `models.ts` so the
 * WEB-DECOMP-03 boundary test passes.
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
/*  RPC response shapes                                                */
/* ------------------------------------------------------------------ */

export interface ConfigReadResult {
  config: Record<string, unknown>;
  sections: string[];
}

export interface ModelsListResult {
  providers?: Array<{
    name: string;
    models?: Array<string | { modelId: string; contextWindow: number; maxTokens: number }>;
    modelCount?: number;
  }>;
  models?: unknown[];
  totalModels?: number;
}

export interface AgentsListResult {
  agents?: string[];
}

export interface AgentGetResult {
  agentId: string;
  config: { provider?: string; model?: string } & Record<string, unknown>;
}

export interface ModelsTestResult {
  status: string;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface ModelsController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Read complete config (config.read with no section). */
  readConfig(): Promise<ConfigReadResult>;
  /** List all available models from the provider catalog (models.list). */
  listModels(): Promise<ModelsListResult>;
  /** List all configured agent IDs (agents.list). */
  listAgents(): Promise<AgentsListResult>;
  /** Fetch an agent's full config (agents.get). */
  getAgent(agentId: string): Promise<AgentGetResult>;
  /** Patch a single key inside a config section (config.patch). */
  patchConfig(section: string, key: string | undefined, value: unknown): Promise<void>;
  /** Test connectivity to a provider (models.test). */
  testProvider(name: string): Promise<ModelsTestResult>;
  /** Update an agent's config (agents.update). */
  updateAgent(agentId: string, config: Record<string, unknown>): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createModelsController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): ModelsController {
  const controller: ModelsController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    readConfig(): Promise<ConfigReadResult> {
      return rpcClient.call<ConfigReadResult>("config.read");
    },

    listModels(): Promise<ModelsListResult> {
      return rpcClient.call<ModelsListResult>("models.list");
    },

    listAgents(): Promise<AgentsListResult> {
      return rpcClient.call<AgentsListResult>("agents.list");
    },

    getAgent(agentId: string): Promise<AgentGetResult> {
      return rpcClient.call<AgentGetResult>("agents.get", { agentId });
    },

    async patchConfig(section: string, key: string | undefined, value: unknown): Promise<void> {
      await rpcClient.call("config.patch", { section, key, value });
    },

    testProvider(name: string): Promise<ModelsTestResult> {
      return rpcClient.call<ModelsTestResult>("models.test", { provider: name });
    },

    async updateAgent(agentId: string, config: Record<string, unknown>): Promise<void> {
      await rpcClient.call("agents.update", { agentId, config });
    },
  };

  host.addController(controller);
  return controller;
}
