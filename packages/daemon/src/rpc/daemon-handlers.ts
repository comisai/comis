/**
 * Daemon infrastructure RPC handler methods.
 * Covers:
 *   system.ping      -- Health check / liveness probe
 *   daemon.setLogLevel -- Runtime log level changes (in-memory only, resets on restart)
 * @module
 */

import type { LogLevelManager } from "../observability/log-infra.js";
import type { RpcHandler } from "./types.js";

/** Dependencies required by daemon handlers. */
export interface DaemonHandlerDeps {
  logLevelManager: LogLevelManager;
}

/**
 * Create daemon infrastructure RPC handlers.
 * @param deps - Injected dependencies (logLevelManager)
 * @returns Record mapping method names to handler functions
 */
export function createDaemonHandlers(deps: DaemonHandlerDeps): Record<string, RpcHandler> {
  return {
    "system.ping": async () => ({
      pong: true,
      ts: Date.now(),
    }),

    "daemon.setLogLevel": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for log level changes");
      }

      const level = params.level as string;
      if (!level) {
        throw new Error("level parameter is required");
      }

      // Validate level is a known Pino level.
      // "silent" is intentionally excluded -- it suppresses all logging
      // including security events. Operators who need it can set it in YAML config.
      const validLevels = ["fatal", "error", "warn", "info", "debug", "trace"];
      if (!validLevels.includes(level)) {
        throw new Error(
          `Invalid log level: "${level}". Valid levels: ${validLevels.join(", ")}`,
        );
      }

      const module = params.module as string | undefined;

      if (module) {
        // Per-module level change
        deps.logLevelManager.setLevel(module, level);
        return { updated: true, module, level, scope: "module", persistent: false };
      } else {
        // Global level change
        deps.logLevelManager.setGlobalLevel(level);
        return { updated: true, level, scope: "global", persistent: false };
      }
    },
  };
}
