// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Shared config-handler helpers.
 *
 * Private helpers + shared types used by the write-side bundles. No
 * closures, no factory: every export is a pure function, type alias, or
 * compile-time flag so the dependency graph stays one-directional
 * (read / write / validate / export → config-helpers).
 *
 *   - ConfigHandlerDeps type re-export (ConfigApiDeps from api/types.ts)
 *   - IS_DEV (NODE_ENV !== "production" dev-mode flag)
 *   - isAgentProviderOrModelKey (provider/model leaf-key check)
 *   - extractTargetProvider (patch → target-provider resolution)
 *   - restoreMcpServerEnv (preserve secret env across UI patches)
 *   - rejectDuplicateMcpServerNames (duplicate-name guard)
 *   - createTokenBucket (rate-limit primitive)
 *   - deliverConfigWebhook (best-effort webhook POST)
 *
 * @module
 */

import {
  type GitCommitMetadata,
  findUnresolvedEnvRefs,
  formatMissingEnvRefError,
  systemGetEnv,
  systemNowMs,
  systemNowDate,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createHash } from "node:crypto";
import { PreconditionError } from "../errors.js";
import { resolveProviderCredentialWithStore } from "../shared/credential-resolver.js";

// Single source of truth: ConfigApiDeps (shared with env-handlers).
// ConfigHandlerDeps is a local alias of that cluster slice.
import type { ConfigApiDeps as ConfigHandlerDeps } from "../types.js";
export type { ConfigHandlerDeps };

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
export const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/**
 * Content-free change-indicator for the config.patch audit:event metadata.
 *
 * The raw config `value` MUST NOT land in the durable security-audit: a
 * no-prefix secret value (a 32-hex key, a DB password, an internal hostname) is
 * invisible to the credential-keyed-field drop AND to the prefixed/keyworded
 * pattern redactor, so it would persist UNREDACTED in the obs_audit_events row +
 * security-audit.jsonl. The value already lives in the 0600
 * config YAML + git + the config-audit log — the audit only needs a
 * change-indicator, never the value. Emit a non-reversible `valueSha256` (first
 * 12 hex of the SHA-256 of the JSON-stringified value) + `valueLength`.
 */
export function valueChangeIndicator(
  value: unknown,
): { valueSha256: string; valueLength: number } {
  // JSON.stringify(undefined) === undefined; treat absent/undefined as empty.
  const str = value === undefined ? "" : JSON.stringify(value) ?? "";
  return {
    valueSha256: createHash("sha256").update(str).digest("hex").slice(0, 12),
    valueLength: str.length,
  };
}

/**
 * True when the patch key writes a provider/model field.
 * Matches `<id>.provider` or `<id>.model` (leaf only — does not match
 * nested paths like modelFailover.fallbackModels.0.provider, which is
 * deliberately out-of-scope for the credential guard).
 */
export function isAgentProviderOrModelKey(key: string | undefined): boolean {
  if (!key) return false;
  return /(^|\.)(provider|model)$/.test(key);
}

/**
 * Resolve the provider value the patch is establishing.
 * - For `.provider` patches, the new value IS the provider.
 * - For `.model`-only patches, look up the agent's CURRENT provider
 *   (validates that the agent's existing auth chain still resolves —
 *   surfaces stale broken configs at patch time rather than at next chat).
 * Returns undefined for paths the guard doesn't validate.
 */
export function extractTargetProvider(
  key: string,
  newValue: unknown,
  currentConfig: { agents?: Record<string, { provider?: string }> },
): string | undefined {
  if (key.endsWith(".provider")) {
    return typeof newValue === "string" ? newValue : undefined;
  }
  if (key.endsWith(".model")) {
    const agentId = key.split(".")[0];
    if (!agentId) return undefined;
    // eslint-disable-next-line security/detect-object-injection -- agents map is typed Record; agentId from validated key
    return currentConfig.agents?.[agentId]?.provider;
  }
  return undefined;
}

/**
 * Run the agent provider/model credential guard for a config.patch.
 *
 * When the patch targets an agent's `.provider` or `.model` leaf, verify
 * the resulting provider's API key is resolvable from at least one source
 * pi-coding-agent will consult at runtime. Throws when the credential is
 * unresolvable (the caller surfaces this through the standard fail-loud
 * config.patch error path).
 *
 * Model-only patches with unchanged provider introduce no new credential
 * surface — the guard short-circuits via the `isModelOnlyPatch +
 * providerUnchanged` predicate. Provider-changing patches always run the
 * resolver.
 *
 * Hexagonal discipline: the daemon-edge resolver adapter performs any OAuth
 * store lookup and feeds a snapshot to the synchronous validator.
 */
export async function runAgentCredentialGuard(
  deps: ConfigHandlerDeps,
  section: string,
  key: string,
  coercedValue: unknown,
): Promise<void> {
  const targetProvider = extractTargetProvider(
    key,
    coercedValue,
    deps.container.config as { agents?: Record<string, { provider?: string }> },
  );
  if (targetProvider === undefined) return;

  // For `.model` keys, extractTargetProvider returns the agent's CURRENT
  // provider — so the resolved targetProvider always equals the current
  // provider. The model-only short-circuit therefore always fires for
  // `.model` keys; we still compute the equality explicitly so the intent
  // is readable and the check survives any future change to
  // extractTargetProvider's contract.
  const isModelOnlyPatch = key.endsWith(".model");
  const agentId = key.split(".")[0];
  const currentProvider = agentId
    // eslint-disable-next-line security/detect-object-injection -- agentId from validated key; agents map is typed Record
    ? deps.container.config.agents?.[agentId]?.provider
    : undefined;
  const providerUnchanged = currentProvider === targetProvider;

  if (isModelOnlyPatch && providerUnchanged) return;

  // Provider is changing (or this is a `.provider` patch where
  // targetProvider is the new value) — run the credential guard.
  const agentOauthProfiles = (agentId
    // eslint-disable-next-line security/detect-object-injection -- agentId from validated key; agents map is typed Record
    ? deps.container.config.agents?.[agentId]?.oauthProfiles
    : undefined) as Record<string, string> | undefined;
  const resolutionResult = await resolveProviderCredentialWithStore(
    targetProvider,
    {
      providerEntries: deps.container.config.providers?.entries ?? {},
      secretManager: deps.container.secretManager,
      modelsConfig: deps.container.config.models,
      oauthProfiles: agentOauthProfiles,
    },
    deps.oauthCredentialStore,
  );
  if (!resolutionResult.ok) throw resolutionResult.error;
  const resolution = resolutionResult.value;
  if (!resolution.ok) {
    deps.logger.warn(
      {
        method: "config.patch",
        section,
        key,
        targetProvider,
        hint: "Authenticate the provider or configure its credential before retrying the agent provider change",
        errorKind: "precondition" as const,
      },
      "Config patch rejected: missing provider credential",
    );
    throw new PreconditionError(resolution.reason!);
  }
}

/**
 * Restore MCP server `env` from existing YAML when the UI patch
 * omits it (because config.read redacted secret values to "[REDACTED]").
 * Since deepMerge replaces arrays entirely, we must restore env from the
 * existing YAML before validation/write so that ${VAR_NAME} refs survive.
 */
export function restoreMcpServerEnv(
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
export function rejectDuplicateMcpServerNames(patch: Record<string, unknown>): void {
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
 * Reject patches that reference env vars not in the secrets store, on
 * enabled MCP servers only. Walks `patch` (not the deep-merged config) so
 * only what's being written this RPC is validated. Skips servers with an
 * explicit `enabled: false` (preserves the placeholder-for-later pattern).
 */
export function validateMcpEnvRefs(
  patch: Record<string, unknown>,
  getSecret: (key: string) => string | undefined,
): void {
  const patchInteg = patch.integrations as Record<string, unknown> | undefined;
  const patchMcp = patchInteg?.mcp as Record<string, unknown> | undefined;
  const patchServers = patchMcp?.servers;
  if (!Array.isArray(patchServers)) return;

  for (const s of patchServers) {
    if (!s || typeof s !== "object") continue;
    const server = s as Record<string, unknown>;
    if (server.enabled === false) continue;
    if (!server.env) continue;
    const serverName = typeof server.name === "string" ? server.name : "<unnamed>";
    const unresolved = findUnresolvedEnvRefs(server.env, getSecret);
    if (unresolved.length > 0) {
      throw new Error(formatMissingEnvRefError(serverName, unresolved.map((u) => u.varName)));
    }
  }
}

/**
 * Token bucket rate limiter for config.patch.
 * Allows maxTokens patches per windowMs. Refills continuously.
 */
export function createTokenBucket(maxTokens: number, windowMs: number) {
  let tokens = maxTokens;
  let lastRefill = systemNowMs();

  return {
    tryConsume(): { allowed: boolean; retryAfterMs?: number } {
      const now = systemNowMs();
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

/**
 * Best-effort config change webhook delivery.
 * Sends an HTTP POST to the configured webhook URL with structured payload.
 * Uses AbortSignal.timeout for timeout enforcement. Errors are logged at
 * DEBUG (never thrown) -- webhook failures must never block config writes.
 */
export async function deliverConfigWebhook(opts: {
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
    timestamp: systemNowDate().toISOString(),
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
