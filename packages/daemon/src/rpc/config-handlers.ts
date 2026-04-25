// SPDX-License-Identifier: Apache-2.0
/**
 * Config and gateway infrastructure RPC handler methods.
 * Covers 10 methods:
 *   config.read, config.patch, config.apply, config.schema,
 *   config.history, config.diff, config.rollback, config.gc,
 *   gateway.restart, gateway.status
 * Extracted from daemon.ts rpcCallInner switch block
 * @module
 */

import {
  isImmutableConfigPath,
  getConfigSchema,
  getConfigSections,
  deepMerge,
  AppConfigSchema,
  redactConfigSecrets,
  warnSuspiciousEnvValues,
  getManagedSectionRedirect,
  formatRedirectHint,
  type AppContainer,
  type ConfigGitManager,
  type GitCommitMetadata,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { suppressError } from "@comis/shared";
import { stringify as yamlStringify } from "yaml";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { RpcHandler } from "./types.js";

/**
 * Restore MCP server `env` from existing YAML when the UI patch
 * omits it (because config.read redacted secret values to "[REDACTED]").
 * Since deepMerge replaces arrays entirely, we must restore env from the
 * existing YAML before validation/write so that ${VAR_NAME} refs survive.
 */
function restoreMcpServerEnv(
  patch: Record<string, unknown>,
  existingLocal: Record<string, unknown>,
): void {
  // Navigate to integrations.mcp.servers in both patch and existing
  const patchInteg = patch.integrations as Record<string, unknown> | undefined;
  const patchMcp = patchInteg?.mcp as Record<string, unknown> | undefined;
  const patchServers = patchMcp?.servers;
  if (!Array.isArray(patchServers)) return;

  const existInteg = existingLocal.integrations as Record<string, unknown> | undefined;
  const existMcp = existInteg?.mcp as Record<string, unknown> | undefined;
  const existServers = existMcp?.servers;
  if (!Array.isArray(existServers)) return;

  // Build name→env lookup from existing YAML servers
  const envByName = new Map<string, Record<string, unknown>>();
  for (const s of existServers) {
    if (s && typeof s === "object" && typeof (s as Record<string, unknown>).name === "string" && (s as Record<string, unknown>).env) {
      envByName.set((s as Record<string, unknown>).name as string, (s as Record<string, unknown>).env as Record<string, unknown>);
    }
  }

  // Restore env for patch servers that are missing it but had env in YAML
  for (const s of patchServers) {
    if (s && typeof s === "object") {
      const server = s as Record<string, unknown>;
      if (!server.env && typeof server.name === "string") {
        const existingEnv = envByName.get(server.name);
        if (existingEnv) {
          server.env = existingEnv;
        }
      }
    }
  }
}

/**
 * Reject config patches that contain duplicate MCP server names.
 * Protects against both GUI and agent tool adding servers with the same name.
 */
function rejectDuplicateMcpServerNames(patch: Record<string, unknown>): void {
  const patchInteg = patch.integrations as Record<string, unknown> | undefined;
  const patchMcp = patchInteg?.mcp as Record<string, unknown> | undefined;
  const patchServers = patchMcp?.servers;
  if (!Array.isArray(patchServers)) return;

  const seen = new Set<string>();
  for (const s of patchServers) {
    if (s && typeof s === "object") {
      const name = (s as Record<string, unknown>).name;
      if (typeof name === "string") {
        if (seen.has(name)) {
          throw new Error(`Duplicate MCP server name: "${name}". Each server must have a unique name.`);
        }
        seen.add(name);
      }
    }
  }
}

/**
 * Token bucket rate limiter for config.patch.
 * Allows maxTokens patches per windowMs. Refills continuously.
 */
function createTokenBucket(maxTokens: number, windowMs: number) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryConsume(): { allowed: boolean; retryAfterMs?: number } {
      const now = Date.now();
      const elapsed = now - lastRefill;
      // Refill proportionally: tokens per ms = maxTokens / windowMs
      const refilled = (elapsed / windowMs) * maxTokens;
      tokens = Math.min(maxTokens, tokens + refilled);
      lastRefill = now;

      if (tokens >= 1) {
        tokens -= 1;
        return { allowed: true };
      }
      // Calculate wait time until 1 token is available
      const deficit = 1 - tokens;
      const retryAfterMs = Math.ceil((deficit / maxTokens) * windowMs);
      return { allowed: false, retryAfterMs };
    },
  };
}

/** Dependencies required by config/gateway handlers. */
export interface ConfigHandlerDeps {
  container: AppContainer;
  configPaths: string[];
  defaultConfigPaths: string[];
  /** Git-backed config versioning manager (optional: absent if git unavailable). */
  configGitManager?: ConfigGitManager;
  /** Structured Pino logger for config/gateway operations. */
  logger: ComisLogger;
  /** Config change webhook config (from container.config.daemon.configWebhook) */
  configWebhook?: { url?: string; timeoutMs?: number; secret?: string };
}

/**
 * Best-effort config change webhook delivery.
 * Sends an HTTP POST to the configured webhook URL with structured payload.
 * Uses AbortSignal.timeout for timeout enforcement. Errors are logged at
 * DEBUG (never thrown) -- webhook failures must never block config writes.
 */
async function deliverConfigWebhook(opts: {
  webhookConfig: { url: string; timeoutMs?: number; secret?: string };
  method: string;
  section: string;
  key?: string;
  diff?: string;
  commitSha?: string;
  metadata: GitCommitMetadata;
  logger: ComisLogger;
}): Promise<void> {
  const { webhookConfig, method, section, key, diff, commitSha, metadata, logger } = opts;
  const payload = {
    event: "config.changed",
    method,
    section,
    key,
    diff: diff ?? null,
    commitSha: commitSha ?? null,
    metadata: {
      agent: metadata.agent ?? null,
      user: metadata.user ?? null,
      traceId: metadata.traceId ?? null,
      summary: metadata.summary,
    },
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // HMAC-SHA256 signature if secret is configured
  if (webhookConfig.secret) {
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", webhookConfig.secret).update(body).digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${sig}`;
  }

  try {
    // SECURITY: webhookConfig.url is admin-configured via daemon config (not user input).
    // SSRF guard not applied -- only admins can set this URL.
    const resp = await fetch(webhookConfig.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(webhookConfig.timeoutMs ?? 5000),
    });
    logger.debug(
      { method: "webhook.deliver", statusCode: resp.status, webhookUrl: webhookConfig.url },
      "Config webhook delivered",
    );
  } catch (e: unknown) {
    logger.debug(
      { method: "webhook.deliver", err: e, webhookUrl: webhookConfig.url, hint: "Webhook delivery failed (best-effort)", errorKind: "network" as const },
      "Config webhook delivery failed",
    );
  }
}

/**
 * Unwrap Zod schema wrappers (Optional / Nullable / Default / Pipe) to get
 * the core schema type. Uses Zod 4.x API exclusively:
 *   - ZodOptional / ZodNullable / ZodDefault → _def.innerType
 *   - ZodPipe → _def.in (Zod 4 replaced Zod 3's ZodEffects + ZodPipeline with
 *     a unified ZodPipe class, returned from both .transform() and .pipe()).
 *     Unwrap the input side so coercion targets the schema BEFORE any
 *     transform.
 *   - .refine() in Zod 4 is a no-op wrapper (returns the same class) — no
 *     handler needed.
 *
 * DO NOT reference z.ZodEffects or z.ZodPipeline: those classes do not exist
 * in Zod 4.3.6 and `instanceof` against `undefined` throws TypeError at
 * runtime.
 *
 * Capped at 10 iterations to prevent pathological nesting.
 *
 * @internal — exported only for test-only direct invocation.
 */
export function unwrapSchema(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
  if (!schema) return schema;
  let cur: z.ZodTypeAny = schema;
  for (let i = 0; i < 10; i++) {
    if (cur instanceof z.ZodOptional) {
      const inner = (cur as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
      if (!inner) break;
      cur = inner;
      continue;
    }
    if (cur instanceof z.ZodNullable) {
      const inner = (cur as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
      if (!inner) break;
      cur = inner;
      continue;
    }
    if (cur instanceof z.ZodDefault) {
      const inner = (cur as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
      if (!inner) break;
      cur = inner;
      continue;
    }
    if (cur instanceof z.ZodPipe) {
      const input = (cur as unknown as { _def?: { in?: z.ZodTypeAny } })._def?.in;
      if (!input) break;
      cur = input;
      continue;
    }
    break;
  }
  return cur;
}

/**
 * Resolve the sub-schema at (section + dot-notation key) from an
 * AppConfigSchema-shaped root. Returns undefined when the path cannot be
 * resolved (unknown section, array-index with non-numeric segment, or a walk
 * that hits a non-navigable schema type). Callers treat undefined as
 * "no coercion target known" and fall back to the legacy heuristic.
 *
 * Supports:
 *   - ZodObject → shape[key]
 *   - ZodArray → element (accepts numeric "N" or bracket-form "[N]" segments)
 *   - ZodRecord → valueType
 *
 * @internal — exported only for test-only direct invocation.
 */
export function resolveSchemaForPath(
  root: z.ZodTypeAny,
  section: string,
  key: string | undefined,
): z.ZodTypeAny | undefined {
  let cur = unwrapSchema(root);
  if (!(cur instanceof z.ZodObject)) return undefined;
  const sectionSchema = (cur.shape as Record<string, z.ZodTypeAny>)[section];
  if (!sectionSchema) return undefined;
  cur = unwrapSchema(sectionSchema);
  if (!key) return cur;
  const parts = key.split(".");
  for (const part of parts) {
    if (!cur) return undefined;
    if (cur instanceof z.ZodObject) {
      cur = unwrapSchema((cur.shape as Record<string, z.ZodTypeAny>)[part]);
    } else if (cur instanceof z.ZodArray) {
      if (/^\d+$/.test(part) || /^\[\d+\]$/.test(part)) {
        // ZodArray.element is typed as $ZodType (Zod 4 base); cast to ZodTypeAny.
        cur = unwrapSchema(cur.element as z.ZodTypeAny);
      } else {
        return undefined;
      }
    } else if (cur instanceof z.ZodRecord) {
      const rec = cur as unknown as { valueType?: z.ZodTypeAny; _def?: { valueType?: z.ZodTypeAny } };
      cur = unwrapSchema(rec.valueType ?? rec._def?.valueType);
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Coerce string representations of booleans and numbers to their native types,
 * guided by the target Zod sub-schema. LLMs often send "true"/"false"/"42" as
 * strings in tool-call parameters, causing Zod validation failures when the
 * schema expects boolean/number. When the target schema is ZodString (e.g.,
 * the value type of z.record(string, string)), strings pass through verbatim
 * — this prevents spurious coercion of env values like MAX_REQUESTS_PER_HOUR
 * = "20" on MCP server entries (z.record(z.string(), z.string())).
 *
 * Scalar coercion ONLY fires for ZodBoolean and ZodNumber targets. ZodLiteral,
 * ZodEnum, ZodNativeEnum, ZodDate, ZodAny, ZodUnknown, etc. pass strings
 * through unchanged (bias toward loud failure at Zod validation time rather
 * than silent coercion).
 *
 * Recursion descends via ZodObject.shape[k], ZodArray.element, and
 * ZodRecord.valueType. When schema is undefined (unresolved path), falls back
 * to the legacy type-agnostic heuristic for back-compat (e.g. scheduler.cron
 * JSON-stringified object case, tenantId ZodString pass-through).
 *
 * @param value - The value to coerce (from config.patch / config.apply params).
 * @param schema - The Zod sub-schema at this path in AppConfigSchema, or
 *   undefined when the path cannot be resolved.
 * @internal — exported only for test-only direct invocation.
 */
export function coerceConfigValue(value: unknown, schema: z.ZodTypeAny | undefined): unknown {
  const s = unwrapSchema(schema);

  if (typeof value === "string") {
    // Schema-guided coercion (preferred path)
    if (s instanceof z.ZodString) return value;
    if (s instanceof z.ZodBoolean) {
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    }
    if (s instanceof z.ZodNumber) {
      if (value !== "" && !isNaN(Number(value)) && isFinite(Number(value))) {
        return Number(value);
      }
      return value;
    }
    if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
      const options: z.ZodTypeAny[] =
        (s as unknown as { options?: z.ZodTypeAny[] }).options ??
        (s as unknown as { _def?: { options?: z.ZodTypeAny[] } })._def?.options ??
        [];
      // If any branch accepts strings, keep as string (bias toward loud failure).
      if (options.some((o) => unwrapSchema(o) instanceof z.ZodString)) return value;
      // Otherwise fall through to JSON-parse / legacy heuristic below.
    }

    // JSON-stringified array/object — parse and recurse with the SAME
    // sub-schema (parsed value sits at the same logical path).
    if (value.startsWith("[") || value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        return coerceConfigValue(parsed, schema);
      } catch {
        // Not valid JSON — fall through.
      }
    }

    // No schema target known → legacy heuristic (back-compat for unresolved paths).
    if (schema === undefined) {
      if (value === "true") return true;
      if (value === "false") return false;
      if (value !== "" && !isNaN(Number(value)) && isFinite(Number(value))) {
        return Number(value);
      }
    }

    return value;
  }

  if (Array.isArray(value)) {
    // ZodArray.element is typed as $ZodType (Zod 4 base); cast to ZodTypeAny.
    const element: z.ZodTypeAny | undefined =
      s instanceof z.ZodArray ? (s.element as z.ZodTypeAny) : undefined;
    return value.map((v) => coerceConfigValue(v, element));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      let child: z.ZodTypeAny | undefined;
      if (s instanceof z.ZodObject) {
        child = (s.shape as Record<string, z.ZodTypeAny>)[k];
      } else if (s instanceof z.ZodRecord) {
        const rec = s as unknown as { valueType?: z.ZodTypeAny; _def?: { valueType?: z.ZodTypeAny } };
        child = rec.valueType ?? rec._def?.valueType;
      }
      result[k] = coerceConfigValue(v, child);
    }
    return result;
  }

  return value;
}

/**
 * Create config and gateway RPC handlers.
 * @param deps - Injected dependencies (container, config paths)
 * @returns Record mapping method names to handler functions
 */
export function createConfigHandlers(deps: ConfigHandlerDeps): Record<string, RpcHandler> {
  // Rate limiter: 5 patches per 60s
  const patchBucket = createTokenBucket(5, 60_000);

  return {
    "config.read": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config read");
      }
      const startMs = Date.now();
      const section = params.section as string | undefined;
      if (section) {
        if (!(section in deps.container.config)) {
          throw new Error(`Unknown config section: "${section}". Valid sections: ${getConfigSections().join(", ")}. Hint: channel settings are under "channels".`);
        }
        const sectionData = deps.container.config[section as keyof typeof deps.container.config];
        deps.logger.debug({ method: "config.read", durationMs: Date.now() - startMs, outcome: "success", section }, "Config section read");
        return redactConfigSecrets(sectionData);
      }
      const result = {
        config: redactConfigSecrets(deps.container.config),
        sections: getConfigSections(),
      };
      deps.logger.debug({ method: "config.read", durationMs: Date.now() - startMs, outcome: "success" }, "Full config read");
      return result;
    },

    "config.patch": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config modification");
      }

      // Rate limit check
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

      const startMs = Date.now();
      // Prefer section/key params; fall back to legacy "path" param (dot-notation) for compat
      const rawPath = typeof params.path === "string" ? params.path : undefined;
      const section = (params.section ?? (rawPath ? rawPath.split(".")[0] : undefined)) as string | undefined;
      if (!section) {
        throw new Error('Missing required parameter "section" for config.patch');
      }
      const key = (params.key ?? (rawPath && rawPath.includes(".") ? rawPath.slice(rawPath.indexOf(".") + 1) : undefined)) as string | undefined;
      const value = params.value;
      const subSchema = resolveSchemaForPath(AppConfigSchema, section, key);
      const coercedValue = coerceConfigValue(value, subSchema);
      const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;

      try {
        // Check immutable paths.
        // Backstop for direct-RPC clients (web UI, CLI). The gateway tool
        // pre-flight and bridge metadata validator catch this earlier for
        // LLM tool calls -- this path is reached when those layers are
        // bypassed. Emit the same redirect hint so all clients see
        // identical, model-agnostic recovery instructions (quick-260425-t40).
        if (isImmutableConfigPath(section, key)) {
          const redirect = getManagedSectionRedirect(section, key);
          const suffix = redirect
            ? ` ${formatRedirectHint(redirect)}`
            : " This setting requires manual operator intervention via config files.";
          throw new Error(
            `Config path "${key ? `${section}.${key}` : section}" is immutable and cannot be modified at runtime.${suffix}`,
          );
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
        writeFileSync(tmpPath, yamlStringify(updatedLocal), { encoding: "utf-8", mode: 0o600 });
        renameSync(tmpPath, localPath);

        // Best-effort git versioning
        if (deps.configGitManager) {
          const gitStart = Date.now();
          await deps.configGitManager.commit({
            section,
            key,
            agent: ctx?.agentId ?? (params._agentId as string | undefined),
            user: ctx?.userId ?? (params._userId as string | undefined),
            traceId: ctx?.traceId ?? (params._traceId as string | undefined),
            summary: key
              ? `Changed ${section}.${key} to ${JSON.stringify(value)}`
              : `Updated ${section} section`,
          }).then(() => {
            deps.logger.debug({ method: "config.patch", durationMs: Date.now() - gitStart, outcome: "success", section }, "Git commit recorded");
          }).catch((gitErr: unknown) => {
            deps.logger.debug({ method: "config.patch", durationMs: Date.now() - gitStart, outcome: "failure", err: gitErr, section }, "Git commit failed (best-effort)");
          });
        }

        const durationMs = Date.now() - startMs;

        // Emit audit event on success
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: ctx?.agentId ?? (params._agentId as string | undefined) ?? "system",
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
        setTimeout(() => {
          process.kill(process.pid, "SIGUSR2");
        }, 200);

        return { patched: true, section, key, value, restarting: true };
      } catch (e: unknown) {
        const durationMs = Date.now() - startMs;
        const errMsg = e instanceof Error ? e.message : String(e);

        // Emit audit event on failure
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: ctx?.agentId ?? (params._agentId as string | undefined) ?? "system",
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
      }
    },

    "config.apply": async (params) => {
      // Admin trust check (same as config.patch)
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config apply");
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

      const startMs = Date.now();
      const section = params.section as string;
      const value = params.value as Record<string, unknown>;
      // config.apply replaces the entire section, so resolve the schema at
      // the section level (key = undefined) to drive schema-aware coercion.
      const subSchema = resolveSchemaForPath(AppConfigSchema, section, undefined);
      const coercedValue = coerceConfigValue(value, subSchema) as Record<string, unknown>;
      const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;

      try {
        // Validate section name exists
        if (!(section in deps.container.config)) {
          throw new Error(`Unknown config section: "${section}". Valid sections: ${getConfigSections().join(", ")}.`);
        }

        // Check immutable paths -- entire section is being replaced.
        // Backstop for direct-RPC clients; LLM tool calls hit the same redirect
        // earlier via gateway-tool / bridge validator (quick-260425-t40).
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
          mkdirSync(localDir, { recursive: true });
        }
        const tmpPath = localPath + ".tmp";
        writeFileSync(tmpPath, yamlStringify(existingLocal), { encoding: "utf-8", mode: 0o600 });
        renameSync(tmpPath, localPath);

        // Best-effort git commit
        if (deps.configGitManager) {
          const gitStart = Date.now();
          await deps.configGitManager.commit({
            section,
            agent: ctx?.agentId ?? (params._agentId as string | undefined),
            user: ctx?.userId ?? (params._userId as string | undefined),
            traceId: ctx?.traceId ?? (params._traceId as string | undefined),
            summary: `Replaced ${section} section`,
          }).then(() => {
            deps.logger.debug({ method: "config.apply", durationMs: Date.now() - gitStart, outcome: "success", section }, "Git commit recorded");
          }).catch((gitErr: unknown) => {
            deps.logger.debug({ method: "config.apply", durationMs: Date.now() - gitStart, outcome: "failure", err: gitErr, section }, "Git commit failed (best-effort)");
          });
        }

        const durationMs = Date.now() - startMs;

        // Audit event
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: ctx?.agentId ?? (params._agentId as string | undefined) ?? "system",
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

        // Schedule restart
        setTimeout(() => {
          process.kill(process.pid, "SIGUSR2");
        }, 200);

        return { applied: true, section, restarting: true };
      } catch (e: unknown) {
        const durationMs = Date.now() - startMs;
        const errMsg = e instanceof Error ? e.message : String(e);

        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: ctx?.agentId ?? (params._agentId as string | undefined) ?? "system",
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

    "config.schema": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config schema");
      }
      const startMs = Date.now();
      const section = params.section as string | undefined;
      const schema = getConfigSchema(section);
      const result = section
        ? { section, schema, sections: getConfigSections() }
        : { schema, sections: getConfigSections() };
      deps.logger.debug({ method: "config.schema", durationMs: Date.now() - startMs, outcome: "success", section }, "Config schema read");
      return result;
    },

    "gateway.restart": async (params) => {
      const startMs = Date.now();
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for gateway restart");
      }

      // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager is available for systemd detection
      const isSystemd = !!process.env["NOTIFY_SOCKET"];

      // Use setTimeout to allow the rpcCall response to flush over WebSocket before shutdown begins.
      // setImmediate fires too early and can race with the RPC response write.
      setTimeout(() => {
        process.kill(process.pid, "SIGUSR2");
      }, 200);

      deps.logger.info({ method: "gateway.restart", durationMs: Date.now() - startMs, outcome: "success", systemd: isSystemd }, "Gateway restart initiated");

      return {
        restarting: true,
        systemd: isSystemd,
        warning: isSystemd
          ? undefined
          : "Not running under systemd. Process will exit and require manual restart.",
      };
    },

    "config.history": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config history");
      }
      const startMs = Date.now();
      if (!deps.configGitManager) {
        deps.logger.debug({ method: "config.history", durationMs: Date.now() - startMs, outcome: "success" }, "Config history unavailable (no git)");
        return { entries: [], error: "Config versioning not available" };
      }
      const limit = params.limit as number | undefined;
      const section = params.section as string | undefined;
      const result = await deps.configGitManager.history({ limit, section });
      if (!result.ok) {
        deps.logger.debug({ method: "config.history", durationMs: Date.now() - startMs, outcome: "failure", section }, "Config history query failed");
        return { entries: [], error: result.error };
      }
      deps.logger.debug({ method: "config.history", durationMs: Date.now() - startMs, outcome: "success", section, entryCount: result.value.length }, "Config history read");
      return { entries: result.value };
    },

    "config.diff": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config diff");
      }
      const startMs = Date.now();
      if (!deps.configGitManager) {
        deps.logger.debug({ method: "config.diff", durationMs: Date.now() - startMs, outcome: "success" }, "Config diff unavailable (no git)");
        return { diff: "", error: "Config versioning not available" };
      }
      const sha = params.sha as string | undefined;
      const result = await deps.configGitManager.diff(sha);
      if (!result.ok) {
        deps.logger.debug({ method: "config.diff", durationMs: Date.now() - startMs, outcome: "failure", sha }, "Config diff query failed");
        return { diff: "", error: result.error };
      }
      deps.logger.debug({ method: "config.diff", durationMs: Date.now() - startMs, outcome: "success", sha }, "Config diff read");
      return { diff: result.value };
    },

    "config.rollback": async (params) => {
      const startMs = Date.now();
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config rollback");
      }
      if (!deps.configGitManager) {
        throw new Error("Config versioning not available");
      }
      const sha = params.sha as string;
      if (!sha) {
        throw new Error("sha parameter is required for config rollback");
      }
      const result = await deps.configGitManager.rollback(sha);
      if (!result.ok) {
        throw new Error(`Config rollback failed: ${result.error}`);
      }

      // Trigger daemon restart (same pattern as gateway.restart) per user decision
      setTimeout(() => {
        process.kill(process.pid, "SIGUSR2");
      }, 200);

      deps.logger.info({ method: "config.rollback", durationMs: Date.now() - startMs, outcome: "success", sha, section: "all" }, "Config rollback applied");

      return { rolledBack: true, sha, newCommitSha: result.value, restarting: true };
    },

    "config.gc": async (params) => {
      const startMs = Date.now();
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for config garbage collection");
      }
      if (!deps.configGitManager) {
        throw new Error("Config versioning not available");
      }

      // Run git garbage collection
      const gcResult = await deps.configGitManager.gc();
      if (!gcResult.ok) {
        throw new Error(`Config gc failed: ${gcResult.error}`);
      }

      // Optional history squash
      let squashResult: { squashedCount: number; newRootSha: string } | undefined;
      const olderThan = params.olderThan as string | undefined;
      if (olderThan) {
        const squash = await deps.configGitManager.squash(olderThan);
        if (!squash.ok) {
          throw new Error(`Config history squash failed: ${squash.error}`);
        }
        squashResult = squash.value;
      }

      const durationMs = Date.now() - startMs;
      deps.logger.info(
        { method: "config.gc", durationMs, outcome: "success", squashedCount: squashResult?.squashedCount ?? 0 },
        "Config gc complete",
      );

      return {
        gc: true,
        ...(squashResult ? { squashed: squashResult.squashedCount, newRootSha: squashResult.newRootSha } : {}),
      };
    },

    "gateway.status": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for gateway status");
      }
      const startMs = Date.now();
      const result = {
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().rss,
        nodeVersion: process.version,
        configPaths: deps.configPaths,
        sections: getConfigSections(),
      };
      deps.logger.debug({ method: "gateway.status", durationMs: Date.now() - startMs, outcome: "success" }, "Gateway status read");
      return result;
    },
  };
}
