// SPDX-License-Identifier: Apache-2.0
/**
 * Config editor controller (Phase 44 / WEB-DECOMP-01).
 *
 * Thin RPC façade for the schema-driven config editor view: config.read,
 * config.schema, config.apply, config.patch, config.history, config.diff,
 * config.rollback, config.gc. The view still owns @state because most
 * interactions are tightly DOM-coupled (form/YAML mode switching, tree
 * navigation with expanded paths, inline edit + validation, multi-tab
 * gateway/history sub-views).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type {
  ConfigHistoryResponse,
  ConfigDiffResponse,
  ConfigRollbackResponse,
  ConfigGcResponse,
} from "../api/types/config-types.js";

export interface ConfigReadResult {
  config: Record<string, unknown>;
  sections: string[];
}

export interface ConfigSchemaResult {
  schema: Record<string, unknown>;
  sections: string[];
}

// Re-export canonical config response types for view consumers.
export type {
  ConfigHistoryResponse,
  ConfigDiffResponse,
  ConfigRollbackResponse,
  ConfigGcResponse,
};

export interface ConfigEditorController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  readConfig(params?: { section?: string }): Promise<ConfigReadResult>;
  readSection<T = Record<string, unknown>>(section: string): Promise<T>;
  loadSchema(): Promise<ConfigSchemaResult>;
  applyConfig(params: { section?: string; value?: unknown; config?: unknown }): Promise<void>;
  patchConfig(params: { section: string; key: string; value: unknown }): Promise<void>;
  loadHistory(limit: number): Promise<ConfigHistoryResponse>;
  loadDiff(sha: string): Promise<string>;
  rollbackToSha(sha: string): Promise<ConfigRollbackResponse>;
  runGc(): Promise<ConfigGcResponse>;
}

export function createConfigEditorController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): ConfigEditorController {
  const controller: ConfigEditorController = {
    hostConnected(): void { /* no-op */ },
    hostDisconnected(): void { /* no-op */ },

    async readConfig(params?: { section?: string }): Promise<ConfigReadResult> {
      const result = await rpcClient.call<ConfigReadResult>("config.read", params);
      return result;
    },

    async readSection<T = Record<string, unknown>>(section: string): Promise<T> {
      const result = await rpcClient.call<T>("config.read", { section });
      return result;
    },

    async loadSchema(): Promise<ConfigSchemaResult> {
      const result = await rpcClient.call<ConfigSchemaResult>("config.schema");
      return result;
    },

    async applyConfig(params): Promise<void> {
      await rpcClient.call("config.apply", params);
    },

    async patchConfig(params): Promise<void> {
      await rpcClient.call("config.patch", params);
    },

    async loadHistory(limit: number): Promise<ConfigHistoryResponse> {
      return rpcClient.call<ConfigHistoryResponse>("config.history", { limit });
    },

    async loadDiff(sha: string): Promise<string> {
      const result = await rpcClient.call<ConfigDiffResponse>("config.diff", { sha });
      return result.diff;
    },

    async rollbackToSha(sha: string): Promise<ConfigRollbackResponse> {
      return rpcClient.call<ConfigRollbackResponse>("config.rollback", { sha });
    },

    async runGc(): Promise<ConfigGcResponse> {
      return rpcClient.call<ConfigGcResponse>("config.gc");
    },
  };

  host.addController(controller);
  return controller;
}
