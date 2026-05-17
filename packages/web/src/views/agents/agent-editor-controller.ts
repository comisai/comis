// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-editor controller (Phase 44 / WEB-DECOMP-01).
 *
 * Thin RPC façade — the agent-editor view retains @state for its form
 * because 41 existing behavioural tests use `priv()._form = …`,
 * `priv()._updateField(…)`, and `priv()._handleSave()` directly. Migrating
 * to a snapshot-source controller would require a 96-call test rewrite.
 *
 * The controller's job is to keep `rpcClient.call(...)` out of
 * `agent-editor.ts` so the WEB-DECOMP-03 boundary test passes. Each method
 * mirrors a source view RPC invocation 1:1 (same method name, same args,
 * same response shape). Errors propagate verbatim (callers handle).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";
import type { CatalogProvider } from "./editors/editor-types.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                */
/* ------------------------------------------------------------------ */

export interface ModelCatalogResult {
  providers?: CatalogProvider[];
  totalModels?: number;
}

export interface TopLevelConfigResult {
  config: Record<string, unknown>;
  sections: string[];
}

export interface AgentGetResult {
  agentId: string;
  config: Record<string, unknown>;
}

export interface AgentCreateResult {
  agentId: string;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface AgentEditorController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Fetch the provider/model catalog (models.list). */
  loadModelCatalog(): Promise<ModelCatalogResult>;
  /** Read top-level config sections (streaming, delivery, queue, etc.) (config.read). */
  loadTopLevelConfig(): Promise<TopLevelConfigResult>;
  /** Patch a single key inside a top-level config section (config.patch). */
  patchConfig(section: string, key: string, value: unknown): Promise<void>;
  /** Apply a runtime log level (daemon.setLogLevel). */
  setLogLevel(level: string, moduleName?: string): Promise<void>;
  /** Fetch existing agent config (agents.get). */
  loadAgent(agentId: string): Promise<AgentGetResult>;
  /** Dry-run agent update for server-side validation (agents.update with dryRun=true). */
  validateAgent(agentId: string, config: Record<string, unknown>): Promise<void>;
  /** Create a new agent (agents.create). */
  createAgent(agentId: string, config: Record<string, unknown>): Promise<AgentCreateResult>;
  /** Update an existing agent (agents.update). */
  updateAgent(agentId: string, config: Record<string, unknown>): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createAgentEditorController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): AgentEditorController {
  const controller: AgentEditorController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    async loadModelCatalog(): Promise<ModelCatalogResult> {
      return await rpcClient.call<ModelCatalogResult>("models.list");
    },

    async loadTopLevelConfig(): Promise<TopLevelConfigResult> {
      return await rpcClient.call<TopLevelConfigResult>("config.read");
    },

    async patchConfig(section: string, key: string, value: unknown): Promise<void> {
      await rpcClient.call("config.patch", { section, key, value });
    },

    async setLogLevel(level: string, moduleName?: string): Promise<void> {
      const params: Record<string, string> = { level };
      if (moduleName) params.module = moduleName;
      await rpcClient.call("daemon.setLogLevel", params);
    },

    async loadAgent(agentId: string): Promise<AgentGetResult> {
      return await rpcClient.call<AgentGetResult>("agents.get", { agentId });
    },

    async validateAgent(agentId: string, config: Record<string, unknown>): Promise<void> {
      await rpcClient.call("agents.update", { agentId, config, dryRun: true });
    },

    async createAgent(
      agentId: string,
      config: Record<string, unknown>,
    ): Promise<AgentCreateResult> {
      return await rpcClient.call<AgentCreateResult>("agents.create", { agentId, config });
    },

    async updateAgent(agentId: string, config: Record<string, unknown>): Promise<void> {
      await rpcClient.call("agents.update", { agentId, config });
    },
  };

  host.addController(controller);
  return controller;
}
