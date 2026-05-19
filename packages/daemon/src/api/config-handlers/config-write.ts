// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Config write (patch) RPC handler.
 *
 * Carries the heaviest config-mutation logic:
 *   - config.patch: dot-notation patch into AppConfig with credential guard,
 *     MCP env restore + duplicate-name check, env-ref resolution gate,
 *     atomic YAML write, best-effort git commit, audit event, and webhook.
 *
 * The `config.apply` handler (replace-section) lives in `config-export.ts`
 * because it shares the same admin-trust + rate-limit envelope but writes a
 * full section replacement rather than a dot-notation merge.
 *
 * Rate limiter: the `patchBucket` is constructed in `index.ts` (the composition
 * root) and passed to both `config-write` and `config-export` bundles so the
 * 5-patches-per-60s budget covers patch + apply combined (the merged limit
 * pre-split).
 *
 * @module
 */

import {
  isImmutableConfigPath,
  deepMerge,
  AppConfigSchema,
  warnSuspiciousEnvValues,
  findUnresolvedEnvRefs,
  formatMissingEnvRefError,
  getManagedSectionRedirect,
  formatRedirectHint,
  ConfigPatchContract,
  stripInternalFields,
  systemNowMs,
  systemSetTimeout,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import type { ConfigWriteAuditRecordBase } from "@comis/observability";
import { stringify as yamlStringify } from "yaml";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { buildConfigAuditBase, appendConfigAuditWithOutcome } from "./config-audit-hook.js";

import type { RpcHandler } from "../types.js";
import {
  IS_DEV,
  type ConfigHandlerDeps,
  deliverConfigWebhook,
  isAgentProviderOrModelKey,
  rejectDuplicateMcpServerNames,
  restoreMcpServerEnv,
  runAgentCredentialGuard,
} from "./config-helpers.js";
import { coerceConfigValue, resolveSchemaForPath } from "./config-validate.js";

/** Rate-limit bucket shape exposed by `createTokenBucket` in config-helpers.ts. */
export interface PatchBucket {
  tryConsume(): { allowed: boolean; retryAfterMs?: number };
}

/**
 * Bind the config.patch handler. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 *
 * `patchBucket` is the SHARED rate limiter used by both config.patch (here)
 * and config.apply (in `config-export.ts`). Constructed once in `index.ts`.
 */
export function bindConfigWriteHandlers(
  deps: ConfigHandlerDeps,
  patchBucket: PatchBucket,
): Record<string, RpcHandler> {
  return {
    [ConfigPatchContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config modification");
      }

      // Rate limit check (BEFORE contract.request.parse for fail-fast).
      const bucket = patchBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          { method: "config.patch", hint: "Config patch rate limit exceeded, retry after cooldown", errorKind: "validation" as const, retryAfterMs: bucket.retryAfterMs },
          "Config patch rate limited",
        );
        throw new Error(
          `Config patch rate limit exceeded: max 5 patches per minute. ` +
          `Try again in ${Math.ceil(bucket.retryAfterMs! / 1000)} seconds.`
        );
      }

      const startMs = systemNowMs();
      // Bespoke pre-Zod: extract section from path fallback BEFORE contract parse,
      // because the contract's `section` is optional + the bespoke message is
      // friendlier than Zod's. The legacy `path: "a.b.c"` shape resolves to
      // section + key here; the contract parse below accepts either canonical
      // or legacy shapes.
      const rawPath = typeof rawParams.path === "string" ? rawParams.path : undefined;
      const section = (rawParams.section ?? (rawPath ? rawPath.split(".")[0] : undefined)) as string | undefined;
      if (!section) {
        throw new Error('Missing required parameter "section" for config.patch');
      }
      const key = (rawParams.key ?? (rawPath && rawPath.includes(".") ? rawPath.slice(rawPath.indexOf(".") + 1) : undefined)) as string | undefined;
      // Strip dispatcher internals + run contract parse for type narrowing +
      // dev-mode defense-in-depth. The contract accepts loose value
      // shape (union of string|number|boolean|record).
      const userParams = stripInternalFields(rawParams);
      // Inject the resolved section/key BEFORE the parse so the wire-format
      // (section, key, value) and the legacy (path, value) forms both parse
      // through the same shape.
      const parseInput = { ...userParams, section, ...(key ? { key } : {}) };
      ConfigPatchContract.request.parse(parseInput);
      const value = rawParams.value;
      const subSchema = resolveSchemaForPath(AppConfigSchema, section, key);
      const coercedValue = coerceConfigValue(value, subSchema);
      const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;

      // Plan 45-05 task 8 + 45.1-04 (TRAJ-FIX-06): build the config-audit
      // base BEFORE validate/write so a rejected patch still surfaces in the
      // JSONL log. When deps.auditEnabled === false, skip the build —
      // appendConfigAuditWithOutcome no-ops on base === undefined, so the
      // gate covers both halves of the two-phase pattern. Default-true
      // semantics preserve pre-fix behavior.
      const localPathForAudit = deps.configPaths.length > 0
        ? deps.configPaths[deps.configPaths.length - 1]!
        : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;
      const auditBase: ConfigWriteAuditRecordBase | undefined =
        deps.auditEnabled === false ? undefined : buildConfigAuditBase(localPathForAudit);
      let wroteFile = false;
      let writeError: { code?: string; message?: string } | undefined;

      try {
        // Check immutable paths.
        // Backstop for direct-RPC clients (web UI, CLI). The gateway tool
        // pre-flight and bridge metadata validator catch this earlier for
        // LLM tool calls -- this path is reached when those layers are
        // bypassed. Emit the same redirect hint so all clients see
        // identical, model-agnostic recovery instructions.
        if (isImmutableConfigPath(section, key)) {
          const redirect = getManagedSectionRedirect(section, key);
          const suffix = redirect
            ? ` ${formatRedirectHint(redirect)}`
            : " This setting requires manual operator intervention via config files.";
          throw new Error(
            `Config path "${key ? `${section}.${key}` : section}" is immutable and cannot be modified at runtime.${suffix}`,
          );
        }

        // Credential guard: when a patch targets an agent's provider/model
        // field, verify the resulting provider's API key is resolvable from
        // at least one source pi-coding-agent will consult at runtime.
        // Fail-loud here rather than letting an unauthorized provider
        // config persist and explode at the next chat turn.
        //
        // Model-only patches with unchanged provider introduce no new
        // credential surface — short-circuit the guard entirely. The
        // runtime auth chain that just authenticated the LLM call making
        // this patch will keep working. Stale-broken-config detection
        // moves back to the next chat turn (fail-loud at the request
        // boundary), where the message is correctly shaped for the actual
        // failure mode (not a pre-emptive API-key prompt that is wrong for
        // OAuth providers like openai-codex).
        if (section === "agents" && isAgentProviderOrModelKey(key)) {
          await runAgentCredentialGuard(deps, section, key!, coercedValue);
        }

        // Build patch object (use coerced value for the actual data, keep original for audit)
        let patch: Record<string, unknown>;
        if (key) {
          // Support dot-notation keys: "budget.maxTokens" -> { section: { budget: { maxTokens: value } } }
          const keyParts = key.split(".");
          const nested: Record<string, unknown> = {};
          let current = nested;
          for (let i = 0; i < keyParts.length - 1; i++) {
            const child: Record<string, unknown> = {};
            current[keyParts[i]!] = child;
            current = child;
          }
          current[keyParts[keyParts.length - 1]!] = coercedValue;
          patch = { [section]: nested };
        } else {
          patch = { [section]: coercedValue };
        }

        // Deep merge and validate
        const merged = deepMerge(
          structuredClone(deps.container.config as unknown as Record<string, unknown>),
          patch,
        );
        const validation = AppConfigSchema.safeParse(merged);
        if (!validation.success) {
          const issues = validation.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          throw new Error(`Config validation failed: ${issues}`);
        }

        // Determine config.local.yaml path (last entry from configPaths or default)
        const localPath = deps.configPaths.length > 0
          ? deps.configPaths[deps.configPaths.length - 1]!
          : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;

        // Read existing local config (if exists), merge patch into it
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
            // If read/parse fails, start fresh
          }
        }

        // Restore MCP server env from existing YAML when UI sends
        // servers without env (stripped because config.read redacts secrets).
        // Arrays replace entirely in deepMerge, so we must restore env here.
        restoreMcpServerEnv(patch, existingLocal);

        // Reject duplicate MCP server names in patch
        rejectDuplicateMcpServerNames(patch);

        // Scan for suspicious env values (bare $VAR, [REDACTED], raw keys)
        const envWarnings = warnSuspiciousEnvValues(patch, section);
        if (envWarnings.length > 0) {
          const hints = envWarnings.map((w) => `${w.path}: "${w.value}" — ${w.hint}`).join("; ");
          throw new Error(
            `Suspicious env value(s) in config patch: ${hints}. ` +
            `Use \${VAR_NAME} syntax to reference secrets stored via env_set.`,
          );
        }

        // Reject patches that reference env vars not in the secrets store, on
        // enabled MCP servers only. The env-substitution skip on disabled
        // servers makes `enabled:false + ${VAR}` harmless at bootstrap; this
        // gate forbids the partially-valid `enabled:true + missing ${VAR}`
        // shape.
        //
        // We walk `patch` (not the deep-merged config) because we only
        // validate what's being WRITTEN this RPC. `restoreMcpServerEnv` above
        // already restored env from existing YAML for partial-update-without-
        // env patches, so `patch.integrations.mcp.servers[].env` is the
        // post-restore truth. Full-config validation would re-flag pre-
        // existing valid-at-write-time refs whose secrets were later removed
        // (out of scope, separate problem).
        const patchInteg = (patch as Record<string, unknown>).integrations as
          | Record<string, unknown>
          | undefined;
        const patchMcp = patchInteg?.mcp as Record<string, unknown> | undefined;
        const patchServers = patchMcp?.servers;
        if (Array.isArray(patchServers)) {
          for (const s of patchServers) {
            if (!s || typeof s !== "object") continue;
            const server = s as Record<string, unknown>;
            // McpServerEntrySchema.enabled defaults to true → absent = enabled.
            // Only explicit `enabled: false` skips the check (preserves the
            // placeholder-for-later pattern).
            if (server.enabled === false) continue;
            if (!server.env) continue;
            const serverName = typeof server.name === "string" ? server.name : "<unnamed>";
            const unresolved = findUnresolvedEnvRefs(
              server.env,
              (key) => deps.container.secretManager.get(key),
            );
            if (unresolved.length > 0) {
              const missingNames = unresolved.map((u) => u.varName);
              throw new Error(formatMissingEnvRefError(serverName, missingNames));
            }
          }
        }

        const updatedLocal = deepMerge(existingLocal, patch);

        // ${VAR} env var references in string values are preserved
        // through YAML round-trip. yamlStringify writes them literally, parseYaml
        // reads them back, and substituteEnvVars resolves them on next daemon load.
        // Write atomically: write to temp file, then rename
        const localDir = dirname(localPath);
        if (!existsSync(localDir)) {
          mkdirSync(localDir, { recursive: true });
        }
        const tmpPath = localPath + ".tmp";
        try {
          writeFileSync(tmpPath, yamlStringify(updatedLocal), { encoding: "utf-8", mode: 0o600 });
          renameSync(tmpPath, localPath);
          wroteFile = true;
        } catch (writeErr) {
          writeError = {
            code: (writeErr as NodeJS.ErrnoException).code,
            message: (writeErr as Error).message,
          };
          throw writeErr;
        }

        // Best-effort git versioning
        if (deps.configGitManager) {
          const gitStart = systemNowMs();
          await deps.configGitManager.commit({
            section,
            key,
            agent: ctx?.agentId ?? (rawParams._agentId as string | undefined),
            user: ctx?.userId ?? (rawParams._userId as string | undefined),
            traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
            summary: key
              ? `Changed ${section}.${key} to ${JSON.stringify(value)}`
              : `Updated ${section} section`,
          }).then(() => {
            deps.logger.debug({ method: "config.patch", durationMs: systemNowMs() - gitStart, outcome: "success", section }, "Git commit recorded");
          }).catch((gitErr: unknown) => {
            deps.logger.debug({ method: "config.patch", durationMs: systemNowMs() - gitStart, outcome: "failure", err: gitErr, section }, "Git commit failed (best-effort)");
          });
        }

        const durationMs = systemNowMs() - startMs;

        // Emit audit event on success
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: ctx?.agentId ?? (rawParams._agentId as string | undefined) ?? "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "config.patch",
          classification: "destructive",
          outcome: "success",
          metadata: { section, key, value, durationMs },
        });

        deps.logger.info({ method: "config.patch", section, key, durationMs, outcome: "success" }, "Config patch applied");

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
              method: "config.patch",
              section,
              key,
              diff: webhookDiff,
              metadata: { section, key, summary: key ? `Changed ${section}.${key}` : `Updated ${section} section`, agent: ctx?.agentId, user: ctx?.userId, traceId: ctx?.traceId },
              logger: deps.logger,
            }),
            "best-effort config webhook delivery",
          );
        }

        // Schedule daemon restart so all subsystems pick up new config atomically.
        // 200ms delay allows the RPC response to flush over WebSocket before shutdown begins.
        // `.unref()` so the timer doesn't keep the event loop alive on its own — in
        // production the gateway/websocket server keeps the loop alive so the timer
        // still fires; in tests using `vi.useRealTimers()` the worker can exit
        // cleanly without waiting for or firing the SIGUSR2.
        systemSetTimeout(() => {
          process.kill(process.pid, "SIGUSR2");
        }, 200).unref();

        const result = { patched: true as const, section, ...(key ? { key } : {}), value, restarting: true as const };
        if (IS_DEV) {
          ConfigPatchContract.response.parse(result);
        }
        return result;
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const errMsg = e instanceof Error ? e.message : String(e);

        // Emit audit event on failure
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: ctx?.agentId ?? (rawParams._agentId as string | undefined) ?? "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "config.patch",
          classification: "destructive",
          outcome: "failure",
          metadata: { section, key, value, error: errMsg, durationMs },
        });

        // DEBUG not WARN: validation errors from LLM tool calls are routine,
        // not system failures. Audit event above captures the failure for review.
        deps.logger.debug(
          { method: "config.patch", section, key, durationMs, outcome: "failure", err: e },
          "Config patch failed",
        );

        throw e;
      } finally {
        // Plan 45-05 task 8: emit a JSONL config-audit record alongside the EventBus audit:event.
        const outcome = wroteFile
          ? ({ kind: "rename" } as const)
          : writeError !== undefined
            ? ({ kind: "failed", ...(writeError.code !== undefined && { code: writeError.code }), ...(writeError.message !== undefined && { message: writeError.message }) } as const)
            : ({ kind: "rejected" } as const);
        appendConfigAuditWithOutcome(auditBase, outcome, deps.logger);
      }
    },
  };
}
