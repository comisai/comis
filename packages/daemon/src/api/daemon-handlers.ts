// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon infrastructure RPC handler methods.
 * Covers:
 *   system.ping      -- Health check / liveness probe
 *   daemon.setLogLevel -- Runtime log level changes (in-memory only, resets on restart)
 *
 * Phase 35 Wave C (Plan 35-06): refactored to use the `@comis/core`
 * contract registry. Method keys are computed-property names
 * (`[DaemonSetLogLevelContract.method]:`) so the bidirectional 1:1
 * architecture test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/daemon.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (D-04 pitfall
 * 6 — never model internals in the contract schema).
 *
 * The bespoke pre-Zod validation (admin gate, level whitelist, missing-
 * level guard) is intentionally retained. The contract parse runs AFTER
 * the bespoke checks and serves to (a) narrow params types for the rest
 * of the handler body and (b) provide a defense-in-depth gate against
 * future drift between the contract schema and the bespoke checks. If
 * the bespoke checks pass, the contract parse is a sanity check that
 * cannot fail by construction.
 *
 * @module
 */
import {
  DaemonSetLogLevelContract,
  SystemPingContract,
  stripInternalFields,
} from "@comis/core";
import type { RpcHandler } from "./types.js";

/** Dependencies required by daemon handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts (Plan 34-08a; alias retarget
 * in Plan 34-08c). Single source of truth: DaemonApiDeps (smallest slice in the
 * 11-slice partition — log-level control only). DAEMON-API-03 Option A retarget —
 * handler body unchanged.
 */
import type { DaemonApiDeps as DaemonHandlerDeps } from "./types.js";
export type { DaemonHandlerDeps };

/**
 * Create daemon infrastructure RPC handlers.
 * @param deps - Injected dependencies (logLevelManager)
 * @returns Record mapping method names to handler functions
 */
export function createDaemonHandlers(deps: DaemonHandlerDeps): Record<string, RpcHandler> {
  return {
    [SystemPingContract.method]: async (rawParams) => {
      // SystemPing has no params (empty object request); strip internals
      // anyway for consistency, then contract-parse for type narrowing.
      const userParams = stripInternalFields(rawParams);
      SystemPingContract.request.parse(userParams); // sanity-narrow {}
      const result = {
        pong: true as const,
        ts: Date.now(),
      };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        SystemPingContract.response.parse(result);
      }
      return result;
    },

    [DaemonSetLogLevelContract.method]: async (rawParams) => {
      // Admin trust check uses the dispatcher-injected `_trustLevel` —
      // intentionally NOT modeled in the contract schema (D-04). Read
      // from rawParams BEFORE the strip-and-parse step.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for log level changes");
      }

      // Bespoke pre-Zod validation retained for user-friendly error
      // messages (the operational UX is exposed through the gateway error
      // path; Zod's default messages are noisier JSON). The contract
      // parse runs AFTER and serves as a type-narrowing pass + defense-
      // in-depth gate against future bespoke-vs-contract drift.
      const level = rawParams.level as string | undefined;
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

      // Strip dispatcher-injected _X internals BEFORE contract parse
      // (D-04 + 35-RESEARCH.md Pitfall 6).
      const userParams = stripInternalFields(rawParams);
      // Contract parse narrows types for the rest of the body. By
      // construction, this cannot fail when the bespoke checks above
      // already passed — the bespoke `validLevels` array is identical to
      // the contract enum values.
      const params = DaemonSetLogLevelContract.request.parse(userParams);
      // params.level is now narrowed to "fatal"|"error"|"warn"|"info"|"debug"|"trace".

      if (params.module) {
        // Per-module level change
        deps.logLevelManager.setLevel(params.module, params.level);
        const result = {
          updated: true as const,
          module: params.module,
          level: params.level,
          scope: "module" as const,
          persistent: false as const,
        };
        // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
        if (process.env.NODE_ENV !== "production") {
          DaemonSetLogLevelContract.response.parse(result);
        }
        return result;
      } else {
        // Global level change
        deps.logLevelManager.setGlobalLevel(params.level);
        const result = {
          updated: true as const,
          level: params.level,
          scope: "global" as const,
          persistent: false as const,
        };
        // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
        if (process.env.NODE_ENV !== "production") {
          DaemonSetLogLevelContract.response.parse(result);
        }
        return result;
      }
    },
  };
}
