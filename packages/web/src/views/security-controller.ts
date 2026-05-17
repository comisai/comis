// SPDX-License-Identifier: Apache-2.0
/**
 * Security view controller (Phase 44 / WEB-DECOMP-01 / Wave 7 / Task 2).
 *
 * Thin RPC façade — the security view retains @state for the security
 * config + provider health + failover log + auth cooldowns + active tab
 * because the existing render delegates to 3 sub-components
 * (token-manager, approval-queue, event-feed) via @property bindings,
 * the SSE event wiring keeps state on the view (debounce timer for
 * provider-health reload), and the existing security.test.ts suite
 * uses `priv()` to access @state fields directly. The controller's job
 * is to keep `rpcClient.call(...)` out of `security.ts` so the
 * WEB-DECOMP-03 boundary test drains its security.ts entry from
 * PRE_EXTRACTION_ALLOWLIST.
 *
 * Wraps 3 RPC methods (verified live grep at Wave-1 HEAD):
 *   - agent.cacheStats → getProviderCacheStats() — provider health probe.
 *   - config.read → readConfig() — initial config + security section load.
 *   - config.patch → patchConfig() — write back individual config fields.
 *
 * Controller cap is 500L (TIGHT) per PATTERNS.md §S1 line 105 / Plan 44-07
 * acceptance_criteria.
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  RPC response + arg shapes                                          */
/* ------------------------------------------------------------------ */

/** Security config section shape (matches SecurityConfigSchema). */
export interface SecurityConfig {
  logRedaction?: boolean;
  auditLog?: boolean;
  permission?: {
    enableNodePermissions?: boolean;
    allowedFsPaths?: string[];
    allowedNetHosts?: string[];
  };
  actionConfirmation?: {
    requireForDestructive?: boolean;
    requireForSensitive?: boolean;
    autoApprove?: string[];
  };
  agentToAgent?: {
    enabled?: boolean;
    maxPingPongTurns?: number;
    allowAgents?: string[];
    subAgentRetentionMs?: number;
    waitTimeoutMs?: number;
    subAgentMaxSteps?: number;
    subAgentToolGroups?: string[];
    subAgentMcpTools?: string;
  };
  secrets?: {
    enabled?: boolean;
    dbPath?: string;
  };
  approvalRules?: {
    defaultMode: string;
    timeoutMs: number;
  };
}

/** config.read response shape (narrowed to security section). */
export interface ConfigReadResponse {
  config: { security?: SecurityConfig };
  sections: string[];
}

/** agent.cacheStats response shape. */
export interface ProviderCacheStats {
  providers: Array<{
    provider: string;
    model: string;
    callCount: number;
    totalCost: number;
    totalCacheSaved: number;
    cacheHitRate: number;
  }>;
  totalCacheSaved: number;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface SecurityController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Read full daemon config and return the security section + other
   *  sections list. Fail-closed: any RPC error surfaces verbatim to the
   *  caller, who maps it to view's `_loadState = "error"`. */
  readConfig(): Promise<ConfigReadResponse>;
  /** Patch one config key. Returns success/error string for IcToast surface.
   *  Fail-closed: caller sees a boolean false on RPC failure (matches
   *  pre-extraction surface in security.ts:586-598). */
  patchConfig(section: string, key: string | undefined, value: unknown): Promise<void>;
  /** Snapshot provider cache stats (used to compute ProviderHealthCard
   *  status + cacheHitRate). Failures are silently absorbed by the view
   *  (provider-health data is supplementary per security.ts:559). */
  getProviderCacheStats(): Promise<ProviderCacheStats>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createSecurityController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): SecurityController {
  const controller: SecurityController = {
    hostConnected(): void {
      /* no-op; the view manages its own load + SSE lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own debounce + SSE teardown */
    },

    readConfig(): Promise<ConfigReadResponse> {
      return rpcClient.call<ConfigReadResponse>("config.read");
    },

    async patchConfig(section: string, key: string | undefined, value: unknown): Promise<void> {
      await rpcClient.call("config.patch", { section, key, value });
    },

    getProviderCacheStats(): Promise<ProviderCacheStats> {
      return rpcClient.call<ProviderCacheStats>("agent.cacheStats");
    },
  };

  host.addController(controller);
  return controller;
}
