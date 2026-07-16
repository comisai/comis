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
 * 5-patches-per-60s budget covers patch + apply combined (one shared budget,
 * not one per method).
 *
 * @module
 */

import { AuthorizationError, PreconditionError, ValidationError } from "../errors.js";
import {
  isImmutableConfigPath,
  deepMerge,
  AppConfigSchema,
  warnSuspiciousEnvValues,
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

import { buildConfigAuditBase, appendConfigAuditWithOutcome } from "../../config/audit-hook.js";
import type { RpcHandler } from "../types.js";
import {
  IS_DEV,
  type ConfigHandlerDeps,
  deliverConfigWebhook,
  isAgentProviderOrModelKey,
  rejectDuplicateMcpServerNames,
  restoreMcpServerEnv,
  runAgentCredentialGuard,
  validateMcpEnvRefs, valueChangeIndicator,
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
        throw new AuthorizationError("Admin access required for config modification");
      }

      // Single-writer guard: integrations.mcp.servers is managed
      // by mcp_manage. Precedence: trust → single-writer → rate-limit. MUTABLE_CONFIG_OVERRIDES
      // at immutable-keys.ts:38 stays — only the gateway-patch route is closed.
      // Also catch parent-path shapes whose merged value lands on
      // integrations.mcp.servers, e.g. { section:"integrations", key:"mcp",
      // value:{servers:[]} } and the two `path:` variants.
      {
        const rp = typeof rawParams.path === "string" ? rawParams.path : undefined;
        const sec = (rawParams.section ?? (rp ? rp.split(".")[0] : undefined)) as string | undefined;
        const key = (rawParams.key ?? (rp && rp.includes(".") ? rp.slice(rp.indexOf(".") + 1) : undefined)) as string | undefined;
        const fp = key ? `${sec}.${key}` : sec ?? "";
        const v = rawParams.value as Record<string, unknown> | null | undefined;
        const obj = v !== null && typeof v === "object";
        if (
          fp === "integrations.mcp.servers" || fp.startsWith("integrations.mcp.servers.") ||
          (obj && fp === "integrations.mcp" && "servers" in v!) ||
          (obj && fp === "integrations" && v!.mcp !== null && typeof v!.mcp === "object" &&
           "servers" in (v!.mcp as Record<string, unknown>))
        ) {
          throw new PreconditionError(
            "integrations.mcp.servers is managed by mcp_manage. " +
            "Use mcp_manage(action:'connect'|'disconnect') instead."
          );
        }
      }

      // Rate limit check (BEFORE contract.request.parse for fail-fast).
      const bucket = patchBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          { method: "config.patch", hint: "Config patch rate limit exceeded, retry after cooldown", errorKind: "validation" as const, retryAfterMs: bucket.retryAfterMs },
          "Config patch rate limited",
        );
        throw new PreconditionError(
          `Config patch rate limit exceeded: max 5 patches per minute. ` +
          `Try again in ${Math.ceil(bucket.retryAfterMs! / 1000)} seconds.`
        );
      }

      const startMs = systemNowMs();
      // Bespoke pre-Zod: require `section` BEFORE contract parse so the
      // error message is more actionable than Zod's. A dot-notation
      // `path: "a.b.c"` shape is not accepted; callers must send the
      // canonical {section, key, value} shape.
      const section = rawParams.section as string | undefined;
      if (!section) {
        throw new ValidationError('Missing required parameter "section" for config.patch');
      }
      const key = rawParams.key as string | undefined;
      // Strip dispatcher internals + run contract parse for type narrowing +
      // dev-mode defense-in-depth. The contract accepts loose value
      // shape (union of string|number|boolean|record).
      const userParams = stripInternalFields(rawParams);
      ConfigPatchContract.request.parse(userParams);
      const value = rawParams.value;
      const subSchema = resolveSchemaForPath(AppConfigSchema, section, key);
      const coercedValue = coerceConfigValue(value, subSchema);
      const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;

      // Build the config-audit base BEFORE validate/write so a rejected
      // patch still surfaces in the JSONL log. When
      // deps.auditEnabled === false, skip the build —
      // appendConfigAuditWithOutcome no-ops on base === undefined, so the
      // gate covers both halves of the two-phase pattern. An unset
      // auditEnabled defaults to true (audit on).
      const localPathForAudit = deps.configPaths.length > 0
        ? deps.configPaths[deps.configPaths.length - 1]!
        : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;
      const auditBase: ConfigWriteAuditRecordBase | undefined =
        deps.auditEnabled === false ? undefined : buildConfigAuditBase(localPathForAudit);
      let wroteFile = false;
      let writeError: { code?: string; message?: string } | undefined;
      // Track the validator's rejection message at this scope so the
      // `finally` block can thread it into the audit outcome — a message
      // scoped to the `catch` block would leave the `rejected` audit
      // record with no reason.
      let rejectionMessage: string | undefined;

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
          throw new PreconditionError(
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
          throw new ValidationError(`Config validation failed: ${issues}`);
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
          throw new ValidationError(
            `Suspicious env value(s) in config patch: ${hints}. ` +
            `Use \${VAR_NAME} syntax to reference secrets stored via env_set.`,
          );
        }

        // Reject patches that reference env vars not in the secrets store
        // on enabled MCP servers. Walks `patch` (post-restoreMcpServerEnv)
        // so only what's being written this RPC is validated.
        validateMcpEnvRefs(patch, (key) => deps.container.secretManager.get(key));

        const updatedLocal = deepMerge(existingLocal, patch);

        // ${VAR} env var references in string values are preserved
        // through YAML round-trip. yamlStringify writes them literally, parseYaml
        // reads them back, and substituteEnvVars resolves them on next daemon load.
        // Write atomically: write to temp file, then rename
        const localDir = dirname(localPath);
        if (!existsSync(localDir)) {
          // fs-safe-allowed: localDir is parent of operator-supplied localPath (config-local YAML); not ~/.comis/ directly
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

        // A content-free indicator (sha256 prefix + length), NEVER the raw `value`.
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: ctx?.agentId ?? (rawParams._agentId as string | undefined) ?? "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "config.patch",
          classification: "destructive",
          outcome: "success",
          metadata: { section, key, ...valueChangeIndicator(value), durationMs },
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
        // Surface the rejection reason to the `finally` block so
        // the audit outcome carries it.
        rejectionMessage = errMsg;

        // Same content-free indicator — a rejected patch's value is just as secret-bearing.
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: ctx?.agentId ?? (rawParams._agentId as string | undefined) ?? "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "config.patch",
          classification: "destructive",
          outcome: "failure",
          metadata: { section, key, ...valueChangeIndicator(value), error: errMsg, durationMs },
        });

        // DEBUG not WARN: validation errors from LLM tool calls are routine,
        // not system failures. Audit event above captures the failure for review.
        deps.logger.debug(
          { method: "config.patch", section, key, durationMs, outcome: "failure", err: e },
          "Config patch failed",
        );

        throw e;
      } finally {
        // Emit a JSONL config-audit record alongside the EventBus audit:event.
        // Thread rejectionMessage (set in the catch block) so the
        // persisted `errorMessage` field carries the validator's rejection text.
        const outcome = wroteFile
          ? ({ kind: "rename" } as const)
          : writeError !== undefined
            ? ({ kind: "failed", ...(writeError.code !== undefined && { code: writeError.code }), ...(writeError.message !== undefined && { message: writeError.message }) } as const)
            : ({ kind: "rejected", ...(rejectionMessage !== undefined && { message: rejectionMessage }) } as const);
        appendConfigAuditWithOutcome(auditBase, outcome, deps.logger);
      }
    },
  };
}
