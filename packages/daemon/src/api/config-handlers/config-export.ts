// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Config export / rollback / gc / restart RPC handlers.
 *
 * Whole-section + git-versioned + lifecycle handlers:
 *   - config.apply: replace an entire section (vs. config.patch's dot-merge)
 *   - config.rollback: roll back to a specific git SHA
 *   - config.gc: run git GC + optional history squash
 *   - gateway.restart: trigger daemon restart (admin-only)
 *
 * Rate limiter: shares the SAME `patchBucket` instance as `config.patch`
 * (constructed in `index.ts`) so the 5-ops-per-60s budget covers patch +
 * apply combined (one shared budget, not one per method).
 *
 * @module
 */

import { AuthorizationError, ValidationError } from "../errors.js";
import {
  isImmutableConfigPath,
  AppConfigSchema,
  warnSuspiciousEnvValues,
  getConfigSections,
  getManagedSectionRedirect,
  formatRedirectHint,
  ConfigApplyContract,
  ConfigGcContract,
  ConfigRollbackContract,
  GatewayRestartContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
  systemSetTimeout,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import { stringify as yamlStringify } from "yaml";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import type { RpcHandler } from "../types.js";
import {
  type ConfigHandlerDeps,
  deliverConfigWebhook,
} from "./config-helpers.js";
import { coerceConfigValue, resolveSchemaForPath } from "./config-validate.js";
import type { PatchBucket } from "./config-write.js";

/**
 * Bind the config.apply + config.rollback + config.gc + gateway.restart
 * handlers. Object-spread compatible with `Record<string, RpcHandler>`.
 *
 * `patchBucket` is the SHARED rate limiter (also consumed by config-write
 * for config.patch); constructed once in `index.ts`.
 */
export function bindConfigExportHandlers(
  deps: ConfigHandlerDeps,
  patchBucket: PatchBucket,
): Record<string, RpcHandler> {
  return {
    [ConfigApplyContract.method]: async (rawParams) => {
      // Admin trust check (same as config.patch)
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config apply");
      }

      // Rate limit check -- reuse the SAME patchBucket so apply+patch share the limit
      const bucket = patchBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          { method: "config.apply", hint: "Config apply rate limit exceeded, retry after cooldown", errorKind: "validation" as const, retryAfterMs: bucket.retryAfterMs },
          "Config apply rate limited",
        );
        throw new Error(
          `Config apply rate limit exceeded: max 5 operations per minute. ` +
          `Try again in ${Math.ceil(bucket.retryAfterMs! / 1000)} seconds.`
        );
      }

      // Strip dispatcher internals + run contract parse (loose record).
      const userParams = stripInternalFields(rawParams);
      const params = ConfigApplyContract.request.parse(userParams);

      const startMs = systemNowMs();
      const section = params.section;
      const value = params.value as Record<string, unknown>;
      // config.apply replaces the entire section, so resolve the schema at
      // the section level (key = undefined) to drive schema-aware coercion.
      const subSchema = resolveSchemaForPath(AppConfigSchema, section, undefined);
      const coercedValue = coerceConfigValue(value, subSchema) as Record<string, unknown>;
      const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;

      try {
        // Validate section name exists
        if (!(section in deps.container.config)) {
          throw new Error(`Unknown config section: "${section}". Valid sections: ${getConfigSections().join(", ")}.`);
        }

        // Check immutable paths -- entire section is being replaced.
        // Backstop for direct-RPC clients; LLM tool calls hit the same redirect
        // earlier via gateway-tool / bridge validator.
        if (isImmutableConfigPath(section)) {
          const redirect = getManagedSectionRedirect(section);
          const suffix = redirect
            ? ` ${formatRedirectHint(redirect)}`
            : " This section requires manual operator intervention via config files.";
          throw new Error(
            `Config section "${section}" is immutable and cannot be replaced at runtime.${suffix}`,
          );
        }

        // Build replacement: replace the section entirely (NOT deep merge)
        const currentConfig = structuredClone(deps.container.config as unknown as Record<string, unknown>);
        currentConfig[section] = coercedValue;

        // Validate entire config
        const validation = AppConfigSchema.safeParse(currentConfig);
        if (!validation.success) {
          const issues = validation.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          throw new Error(`Config validation failed: ${issues}`);
        }

        // Scan for suspicious env values (bare $VAR, [REDACTED], raw keys)
        const envWarnings = warnSuspiciousEnvValues({ [section]: coercedValue }, section);
        if (envWarnings.length > 0) {
          const hints = envWarnings.map((w) => `${w.path}: "${w.value}" — ${w.hint}`).join("; ");
          throw new Error(
            `Suspicious env value(s) in config apply: ${hints}. ` +
            `Use \${VAR_NAME} syntax to reference secrets stored via env_set.`,
          );
        }

        // Read existing local YAML, replace the section
        const localPath = deps.configPaths.length > 0
          ? deps.configPaths[deps.configPaths.length - 1]!
          : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;

        let existingLocal: Record<string, unknown> = {};
        if (existsSync(localPath)) {
          try {
            const raw = readFileSync(localPath, "utf-8");
            const { parse: parseYaml } = await import("yaml");
            const parsed = parseYaml(raw) as Record<string, unknown> | null;
            if (parsed && typeof parsed === "object") {
              existingLocal = parsed;
            }
          } catch {
            // Start fresh if read/parse fails
          }
        }

        // Full replacement: overwrite the section key (not deep merge)
        existingLocal[section] = coercedValue;

        // ${VAR} env var references in string values are preserved
        // through YAML round-trip. yamlStringify writes them literally, parseYaml
        // reads them back, and substituteEnvVars resolves them on next daemon load.
        // Write atomically
        const localDir = dirname(localPath);
        if (!existsSync(localDir)) {
          // fs-safe-allowed: localDir is parent of operator-supplied localPath (config-local YAML); not ~/.comis/ directly
          mkdirSync(localDir, { recursive: true });
        }
        const tmpPath = localPath + ".tmp";
        writeFileSync(tmpPath, yamlStringify(existingLocal), { encoding: "utf-8", mode: 0o600 });
        renameSync(tmpPath, localPath);

        // Best-effort git commit
        if (deps.configGitManager) {
          const gitStart = systemNowMs();
          await deps.configGitManager.commit({
            section,
            agent: ctx?.agentId ?? (rawParams._agentId as string | undefined),
            user: ctx?.userId ?? (rawParams._userId as string | undefined),
            traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
            summary: `Replaced ${section} section`,
          }).then(() => {
            deps.logger.debug({ method: "config.apply", durationMs: systemNowMs() - gitStart, outcome: "success", section }, "Git commit recorded");
          }).catch((gitErr: unknown) => {
            deps.logger.debug({ method: "config.apply", durationMs: systemNowMs() - gitStart, outcome: "failure", err: gitErr, section }, "Git commit failed (best-effort)");
          });
        }

        const durationMs = systemNowMs() - startMs;

        // Audit event
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: ctx?.agentId ?? (rawParams._agentId as string | undefined) ?? "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "config.apply",
          classification: "destructive",
          outcome: "success",
          metadata: { section, durationMs },
        });

        deps.logger.info({ method: "config.apply", section, durationMs, outcome: "success" }, "Config section replaced");

        // Best-effort webhook notification
        if (deps.configWebhook?.url) {
          let webhookDiff: string | undefined;
          if (deps.configGitManager) {
            const diffResult = await deps.configGitManager.diff();
            if (diffResult.ok) webhookDiff = diffResult.value;
          }
          suppressError(
            deliverConfigWebhook({
              webhookConfig: deps.configWebhook as { url: string; timeoutMs?: number; secret?: string },
              method: "config.apply",
              section,
              diff: webhookDiff,
              metadata: { section, summary: `Replaced ${section} section`, agent: ctx?.agentId, user: ctx?.userId, traceId: ctx?.traceId },
              logger: deps.logger,
            }),
            "best-effort config webhook delivery",
          );
        }

        // Schedule restart. `.unref()` so the timer doesn't keep the event
        // loop alive on its own (production gateway/ws server keeps it alive
        // so the timer still fires; tests can exit cleanly).
        systemSetTimeout(() => {
          process.kill(process.pid, "SIGUSR2");
        }, 200).unref();

        const result = { applied: true as const, section, restarting: true as const };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ConfigApplyContract.response.parse(result);
        }
        return result;
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const errMsg = e instanceof Error ? e.message : String(e);

        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: ctx?.agentId ?? (rawParams._agentId as string | undefined) ?? "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "config.apply",
          classification: "destructive",
          outcome: "failure",
          metadata: { section, error: errMsg, durationMs },
        });

        // DEBUG not WARN: validation errors from LLM tool calls are routine,
        // not system failures. Audit event above captures the failure for review.
        deps.logger.debug(
          { method: "config.apply", section, durationMs, outcome: "failure", err: e },
          "Config apply failed",
        );

        throw e;
      }
    },

    [ConfigRollbackContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config rollback");
      }
      if (!deps.configGitManager) {
        throw new Error("Config versioning not available");
      }
      // Bespoke pre-Zod check FIRST: preserves the user-facing error message
      // ("sha parameter is required for config rollback"). The contract's
      // `z.string().min(1)` enforces the same condition but with a
      // Zod-style message.
      const sha = rawParams.sha as string;
      if (!sha) {
        throw new ValidationError("sha parameter is required for config rollback");
      }
      const userParams = stripInternalFields(rawParams);
      const params = ConfigRollbackContract.request.parse(userParams);
      const rollbackResult = await deps.configGitManager.rollback(params.sha);
      if (!rollbackResult.ok) {
        throw new Error(`Config rollback failed: ${rollbackResult.error}`);
      }

      // Trigger daemon restart (same pattern as gateway.restart).
      // `.unref()` so the timer doesn't keep the event loop alive on its own
      // (production gateway/ws server keeps it alive so the timer still fires;
      // tests can exit cleanly).
      systemSetTimeout(() => {
        process.kill(process.pid, "SIGUSR2");
      }, 200).unref();

      deps.logger.info({ method: "config.rollback", durationMs: systemNowMs() - startMs, outcome: "success", sha: params.sha, section: "all" }, "Config rollback applied");

      const result = {
        rolledBack: true as const,
        sha: params.sha,
        newCommitSha: rollbackResult.value,
        restarting: true as const,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ConfigRollbackContract.response.parse(result);
      }
      return result;
    },

    [ConfigGcContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for config garbage collection");
      }
      if (!deps.configGitManager) {
        throw new Error("Config versioning not available");
      }
      const userParams = stripInternalFields(rawParams);
      const params = ConfigGcContract.request.parse(userParams);

      // Run git garbage collection
      const gcResult = await deps.configGitManager.gc();
      if (!gcResult.ok) {
        throw new Error(`Config gc failed: ${gcResult.error}`);
      }

      // Optional history squash
      let squashResult: { squashedCount: number; newRootSha: string } | undefined;
      const olderThan = params.olderThan;
      if (olderThan) {
        const squash = await deps.configGitManager.squash(olderThan);
        if (!squash.ok) {
          throw new Error(`Config history squash failed: ${squash.error}`);
        }
        squashResult = squash.value;
      }

      const durationMs = systemNowMs() - startMs;
      deps.logger.info(
        { method: "config.gc", durationMs, outcome: "success", squashedCount: squashResult?.squashedCount ?? 0 },
        "Config gc complete",
      );

      const result = {
        gc: true as const,
        ...(squashResult ? { squashed: squashResult.squashedCount, newRootSha: squashResult.newRootSha } : {}),
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ConfigGcContract.response.parse(result);
      }
      return result;
    },

    [GatewayRestartContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for gateway restart");
      }
      const userParams = stripInternalFields(rawParams);
      GatewayRestartContract.request.parse(userParams);

      // INVOCATION_ID is present for installer-managed Type=exec services.
      // NOTIFY_SOCKET keeps custom Type=notify units detectable as well.
      const isSystemd = Boolean(
        systemGetEnv("INVOCATION_ID") || systemGetEnv("NOTIFY_SOCKET"),
      );

      // Use setTimeout to allow the rpcCall response to flush over WebSocket before shutdown begins.
      // setImmediate fires too early and can race with the RPC response write.
      // `.unref()` so the timer doesn't keep the event loop alive on its own
      // (production gateway/ws server keeps it alive so the timer still fires;
      // tests can exit cleanly).
      systemSetTimeout(() => {
        process.kill(process.pid, "SIGUSR2");
      }, 200).unref();

      deps.logger.info({ method: "gateway.restart", durationMs: systemNowMs() - startMs, outcome: "success", systemd: isSystemd }, "Gateway restart initiated");

      const result: { restarting: true; systemd: boolean; warning?: string } = {
        restarting: true,
        systemd: isSystemd,
      };
      if (!isSystemd) {
        result.warning =
          "Not running under systemd. Process will exit and require manual restart.";
      }
      if (systemGetEnv("NODE_ENV") !== "production") {
        GatewayRestartContract.response.parse(result);
      }
      return result;
    },
  };
}
