// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap helpers extracted from `daemon.ts` to keep the composition root
 * under its architecture line cap. These run during `main()`/`bootAgents`;
 * see `daemon.ts` for the boot sequence that consumes them.
 *
 * @module
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { safePath, createApprovalGate, generateStrongToken } from "@comis/core";
import { createChannelHealthMonitor } from "@comis/channels";
import type { LoggingResult } from "./setup-logging.js";
import type { BootContext } from "../daemon-types.js";

/**
 * Restore approval pending requests and cache from disk at startup.
 *
 * Reads `<dataDir>/restart-approvals.json` and
 * `<dataDir>/restart-approval-cache.json` (written by graceful shutdown),
 * restores into the in-memory ApprovalGate, then deletes the files.
 * Best-effort on JSON parse failure: log warn + unlink.
 */
export function restoreApprovalState(deps: {
  approvalGate: ReturnType<typeof createApprovalGate>;
  dataDir: string;
  containerDataDir: string | undefined;
  daemonLogger: LoggingResult["daemonLogger"];
}): void {
  const { approvalGate, dataDir, containerDataDir, daemonLogger } = deps;
  // 6.6.8.6.1. Restore pending approvals from previous restart
  const approvalRestorePath = safePath(containerDataDir || dataDir, "restart-approvals.json");
  if (existsSync(approvalRestorePath)) {
    try {
      const raw = readFileSync(approvalRestorePath, "utf-8");
      const records = JSON.parse(raw);
      unlinkSync(approvalRestorePath);
      const restored = approvalGate.restorePending(records);
      if (restored > 0) {
        daemonLogger.info({ count: restored, total: records.length }, "Pending approvals restored from previous session");
      }
    } catch (restoreErr) {
      daemonLogger.warn(
        { err: restoreErr, hint: "Could not restore pending approvals; operators may need to re-approve", errorKind: "internal" as const },
        "Failed to restore pending approvals",
      );
      try { unlinkSync(approvalRestorePath); } catch { /* ignore */ }
    }
  }

  // 6.6.8.6.2. Restore approval cache from previous session
  const approvalCacheRestorePath = safePath(containerDataDir || dataDir, "restart-approval-cache.json");
  if (existsSync(approvalCacheRestorePath)) {
    try {
      const raw = readFileSync(approvalCacheRestorePath, "utf-8");
      unlinkSync(approvalCacheRestorePath); // Consume immediately
      const entries = JSON.parse(raw);
      const restored = approvalGate.restoreApprovalCache(entries);
      if (restored > 0) {
        daemonLogger.info({ count: restored, total: entries.length }, "Approval cache restored from previous session");
      }
    } catch (restoreErr) {
      daemonLogger.warn(
        { err: restoreErr, hint: "Could not restore approval cache; users may need to re-approve", errorKind: "internal" as const },
        "Failed to restore approval cache",
      );
      try { unlinkSync(approvalCacheRestorePath); } catch { /* ignore */ }
    }
  }
}

/**
 * Set up the channel health monitor. Returns `{ monitor, stop }`; both let
 * slots disappear from bootChannels into this single helper return value.
 *
 * Extracted from `daemon.ts` to keep the composition root under its
 * architecture line cap (runs during `bootChannels`).
 */
export function setupChannelHealthMonitor(deps: {
  adaptersByType: NonNullable<BootContext["adaptersByType"]>;
  daemonLogger: LoggingResult["daemonLogger"];
  container: BootContext["container"];
}): { monitor: ReturnType<typeof createChannelHealthMonitor> | undefined; stop: (() => void) | undefined } {
  const { adaptersByType, daemonLogger, container } = deps;
  const healthCheckConfig = container.config.channels?.healthCheck;
  if (healthCheckConfig?.enabled === false) return { monitor: undefined, stop: undefined };
  const monitor = createChannelHealthMonitor({
    eventBus: container.eventBus,
    pollIntervalMs: healthCheckConfig?.pollIntervalMs,
    staleThresholdMs: healthCheckConfig?.staleThresholdMs,
    idleThresholdMs: healthCheckConfig?.idleThresholdMs,
    errorThreshold: healthCheckConfig?.errorThreshold,
    stuckThresholdMs: healthCheckConfig?.stuckThresholdMs,
    startupGraceMs: healthCheckConfig?.startupGraceMs,
    autoRestartOnStale: healthCheckConfig?.autoRestartOnStale,
    maxRestartsPerHour: healthCheckConfig?.maxRestartsPerHour,
    restartCooldownMs: healthCheckConfig?.restartCooldownMs,
    restartAdapter: async (channelType: string) => {
      const adapter = adaptersByType.get(channelType);
      if (!adapter) return;
      daemonLogger.info({ channelType }, "Health monitor triggering auto-restart for stale adapter");
      await adapter.stop();
      await adapter.start();
    },
  });
  const stop = monitor.start(adaptersByType);
  return { monitor, stop };
}

/**
 * Per-token MCP-client config block. Surface to the gateway TokenStore via
 * `TokenEntry.mcpClient` so the verified TokenClient carries the allowlist +
 * sessionAllowlist + per-tool rate-limit overrides.
 */
export interface ResolvedGatewayToken {
  id: string;
  secret: string;
  scopes: string[];
  mcpClient?: {
    allowlist: string[];
    sessionAllowlist: string[];
    toolRateLimit: Record<string, number>;
  };
}

/**
 * Resolve gateway tokens from config (config -> env -> auto-generated).
 *
 * Extracted from `daemon.ts` to keep the composition root under its
 * architecture line cap (runs during `bootGateway`).
 */
export function resolveGatewayTokens(deps: {
  container: BootContext["container"];
  daemonLogger: BootContext["daemonLogger"];
}): Array<ResolvedGatewayToken> {
  const { container, daemonLogger } = deps;
  const resolved: Array<ResolvedGatewayToken> = [];
  for (const t of container.config.gateway?.tokens ?? []) {
    const tokenId = t.id ?? "unknown";
    const tokenScopes = [...(t.scopes ?? [])];
    // Preserve the per-MCP-client config block so the TokenStore can surface
    // it on verified TokenClient instances. Schema defaults guarantee the
    // fields are populated when the block is present.
    const mcpClient = t.mcpClient
      ? {
          allowlist: [...t.mcpClient.allowlist],
          sessionAllowlist: [...t.mcpClient.sessionAllowlist],
          toolRateLimit: { ...t.mcpClient.toolRateLimit },
        }
      : undefined;

    if (typeof t.secret === "string" && t.secret.length >= 32) {
      // Source: config (explicit secret present and valid)
      resolved.push({
        id: tokenId,
        secret: t.secret,
        scopes: tokenScopes,
        ...(mcpClient && { mcpClient }),
      });
    } else {
      const envKey = `GATEWAY_TOKEN_${tokenId.toUpperCase().replace(/-/g, "_")}`;
      const envSecret = container.secretManager.get(envKey);
      if (envSecret) {
        // Source: env / SecretManager
        resolved.push({
          id: tokenId,
          secret: envSecret,
          scopes: tokenScopes,
          ...(mcpClient && { mcpClient }),
        });
      } else {
        // Source: auto-generated (ephemeral)
        const generated = generateStrongToken();
        resolved.push({
          id: tokenId,
          secret: generated,
          scopes: tokenScopes,
          ...(mcpClient && { mcpClient }),
        });
        daemonLogger.warn(
          { tokenId, envVar: envKey, hint: `Set ${envKey} in environment or secrets store for persistence`, errorKind: "config" as const },
          "Gateway token auto-generated (ephemeral -- will be lost on restart)",
        );
      }
    }
  }
  return resolved;
}
