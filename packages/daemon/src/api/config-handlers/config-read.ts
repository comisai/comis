// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Config read RPC handlers.
 *
 * Read-side handlers that surface config state without mutation:
 *   - config.read: dump current config (or one section) with secret redaction
 *   - config.schema: introspect Zod schema for a section
 *   - config.history: git history of config commits (degraded when no git)
 *   - config.diff: git diff of a single commit (degraded when no git)
 *   - gateway.status: runtime stats (pid, uptime, memory, version)
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import {
  getConfigSchema,
  getConfigSections,
  redactForDisplay,
  ConfigReadContract,
  ConfigSchemaContract,
  ConfigHistoryContract,
  ConfigDiffContract,
  GatewayStatusContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import type { ConfigHandlerDeps } from "./config-helpers.js";

/**
 * Bind the config read + gateway.status handlers. Object-spread compatible
 * with `Record<string, RpcHandler>`.
 */
export function bindConfigReadHandlers(deps: ConfigHandlerDeps): Record<string, RpcHandler> {
  return {
    [ConfigReadContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config read");
      }
      const userParams = stripInternalFields(rawParams);
      const params = ConfigReadContract.request.parse(userParams);
      const startMs = systemNowMs();
      const section = params.section;
      if (section) {
        if (!(section in deps.container.config)) {
          throw new Error(`Unknown config section: "${section}". Valid sections: ${getConfigSections().join(", ")}. Hint: channel settings are under "channels".`);
        }
        const sectionData = deps.container.config[section as keyof typeof deps.container.config];
        deps.logger.debug({ method: "config.read", durationMs: systemNowMs() - startMs, outcome: "success", section }, "Config section read");
        const sectionResult = redactForDisplay(sectionData) as Record<string, unknown>;
        if (systemGetEnv("NODE_ENV") !== "production") {
          // Sub-tree shape is loose (z.record) — primitives wrap as `{ value: ... }` would
          // disturb the wire format; only assert the parse is callable. Skip on primitives.
          if (sectionResult !== null && typeof sectionResult === "object") {
            ConfigReadContract.response.parse(sectionResult);
          }
        }
        return sectionResult;
      }
      const result = {
        config: redactForDisplay(deps.container.config) as Record<string, unknown>,
        sections: getConfigSections(),
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ConfigReadContract.response.parse(result);
      }
      deps.logger.debug({ method: "config.read", durationMs: systemNowMs() - startMs, outcome: "success" }, "Full config read");
      return result;
    },

    [ConfigSchemaContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config schema");
      }
      const userParams = stripInternalFields(rawParams);
      const params = ConfigSchemaContract.request.parse(userParams);
      const startMs = systemNowMs();
      const section = params.section;
      const schema = getConfigSchema(section) as Record<string, unknown>;
      const result = section
        ? { section, schema, sections: getConfigSections() }
        : { schema, sections: getConfigSections() };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ConfigSchemaContract.response.parse(result);
      }
      deps.logger.debug({ method: "config.schema", durationMs: systemNowMs() - startMs, outcome: "success", section }, "Config schema read");
      return result;
    },

    [ConfigHistoryContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config history");
      }
      const userParams = stripInternalFields(rawParams);
      // history accepts section as a contract field plus limit. The contract
      // models `section` AND `limit` as optional; cast through `userParams`
      // before parse to allow the existing handler-internal `section` semantic.
      const params = ConfigHistoryContract.request.parse(userParams);
      const startMs = systemNowMs();
      if (!deps.configGitManager) {
        deps.logger.debug({ method: "config.history", durationMs: systemNowMs() - startMs, outcome: "success" }, "Config history unavailable (no git)");
        const degraded = { entries: [], error: "Config versioning not available" };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ConfigHistoryContract.response.parse(degraded);
        }
        return degraded;
      }
      const limit = params.limit;
      const section = params.section;
      const histResult = await deps.configGitManager.history({ limit, section });
      if (!histResult.ok) {
        deps.logger.debug({ method: "config.history", durationMs: systemNowMs() - startMs, outcome: "failure", section }, "Config history query failed");
        const errResult = { entries: [], error: histResult.error };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ConfigHistoryContract.response.parse(errResult);
        }
        return errResult;
      }
      deps.logger.debug({ method: "config.history", durationMs: systemNowMs() - startMs, outcome: "success", section, entryCount: histResult.value.length }, "Config history read");
      const okResult = { entries: histResult.value };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ConfigHistoryContract.response.parse(okResult);
      }
      return okResult;
    },

    [ConfigDiffContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config diff");
      }
      const userParams = stripInternalFields(rawParams);
      const params = ConfigDiffContract.request.parse(userParams);
      const startMs = systemNowMs();
      if (!deps.configGitManager) {
        deps.logger.debug({ method: "config.diff", durationMs: systemNowMs() - startMs, outcome: "success" }, "Config diff unavailable (no git)");
        const degraded = { diff: "", error: "Config versioning not available" };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ConfigDiffContract.response.parse(degraded);
        }
        return degraded;
      }
      const sha = params.sha;
      const diffResult = await deps.configGitManager.diff(sha);
      if (!diffResult.ok) {
        deps.logger.debug({ method: "config.diff", durationMs: systemNowMs() - startMs, outcome: "failure", sha }, "Config diff query failed");
        const errResult = { diff: "", error: diffResult.error };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ConfigDiffContract.response.parse(errResult);
        }
        return errResult;
      }
      deps.logger.debug({ method: "config.diff", durationMs: systemNowMs() - startMs, outcome: "success", sha }, "Config diff read");
      const okResult = { diff: diffResult.value };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ConfigDiffContract.response.parse(okResult);
      }
      return okResult;
    },

    [GatewayStatusContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for gateway status");
      }
      const userParams = stripInternalFields(rawParams);
      GatewayStatusContract.request.parse(userParams);
      const startMs = systemNowMs();
      // process.uptime() / process.memoryUsage() / process.version are Node
      // runtime introspection — admin-trusted; the contract's all-required
      // 6-field schema captures the wire shape.
      // eslint-disable-next-line no-restricted-syntax -- gateway.status reports runtime metadata; no SecretManager dependency.
      const memoryUsage = process.memoryUsage().rss;
      const result = {
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage,
        nodeVersion: process.version,
        // Daemon build version (packages/daemon/package.json), read once at
        // boot. Surfaced so `comis doctor`'s version-skew check can flag a
        // stale CLI talking to a newer daemon.
        version: deps.daemonVersion,
        configPaths: deps.configPaths,
        sections: getConfigSections(),
        // secretsStoreAvailable means "a *writable* store is wired",
        // not merely "an adapter is present". In env mode the adapter IS defined
        // (it is always present) but is read-only — so env mode returns false.
        // Only "file" and "encrypted" storage modes provide a writable store.
        // This prevents the env_set preflight in gateway-tool.ts from incorrectly
        // allowing env.set calls when the daemon is in read-only env mode.
        secretsStoreAvailable:
          deps.container.config.security.storage === "file" ||
          deps.container.config.security.storage === "encrypted",
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        GatewayStatusContract.response.parse(result);
      }
      deps.logger.debug({ method: "gateway.status", durationMs: systemNowMs() - startMs, outcome: "success" }, "Gateway status read");
      return result;
    },
  };
}
