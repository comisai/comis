// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Environment secret management RPC handler.
 * Provides:
 *   - `env.set`  -- write a secret (admin-only, rate-limited, values never logged)
 *   - `env.list` -- enumerate secret NAMES (admin-only, read-only, values never returned)
 *
 * Storage backend: SecretStorePort (encrypted secrets.db via AES-256-GCM).
 * There is no .env-file fallback; env.set rejects with an
 * actionable error when the daemon was booted without
 * SECRETS_MASTER_KEY (same posture as secrets-handlers.ts).
 *
 * Uses the `@comis/core` contract registry. Method keys are computed-
 * property names (`[EnvSetContract.method]:`) so the bidirectional 1:1
 * architecture test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/config.ts` (the
 * env-handlers domain ships in the SAME contract file as the
 * config-handlers domain because both consume the same `ConfigApiDeps`
 * cluster slice).
 *
 * The bespoke pre-Zod validation (admin gate, rate-limit,
 * ENV_KEY_PATTERN regex, MAX_KEY_LENGTH / MAX_VALUE_LENGTH,
 * `[REDACTED]` placeholder rejection) is intentionally retained for
 * user-friendly error UX. The contract parse runs AFTER and serves
 * to (a) narrow params types for the rest of the handler body and
 * (b) provide a defense-in-depth gate against future drift. The
 * dev-mode `Contract.response.parse(...)` gate before each return
 * doubles as a residency canary — the response schema deliberately
 * omits `value`/`plaintext`/`secret` fields, so any future leak
 * surfaces immediately at dev-mode parse time.
 *
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  matchesSecretPattern,
  EnvSetContract,
  EnvListContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Rate limiter (reused pattern from config-handlers.ts)
// ---------------------------------------------------------------------------

/**
 * Token bucket rate limiter for env.set.
 * Allows maxTokens sets per windowMs. Refills continuously.
 */
function createTokenBucket(maxTokens: number, windowMs: number) {
  let tokens = maxTokens;
  let lastRefill = systemNowMs();

  return {
    tryConsume(): { allowed: boolean; retryAfterMs?: number } {
      const now = systemNowMs();
      const elapsed = now - lastRefill;
      const refilled = (elapsed / windowMs) * maxTokens;
      tokens = Math.min(maxTokens, tokens + refilled);
      lastRefill = now;

      if (tokens >= 1) {
        tokens -= 1;
        return { allowed: true };
      }
      const deficit = 1 - tokens;
      const retryAfterMs = Math.ceil((deficit / maxTokens) * windowMs);
      return { allowed: false, retryAfterMs };
    },
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by env handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts. Single source of
 * truth: ConfigApiDeps (shared with config-handlers). The cluster slice
 * covers env-handler fields (secretStore, logger).
 */
import type { ConfigApiDeps as EnvHandlerDeps } from "./types.js";
export type { EnvHandlerDeps };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Valid env var key: starts with uppercase letter, uppercase + digits + underscores only. */
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 8192;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create env RPC handlers.
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createEnvHandlers(deps: EnvHandlerDeps): Record<string, RpcHandler> {
  // Rate limiter: 5 sets per 60s
  const setBucket = createTokenBucket(5, 60_000);
  // Rate limiter: 30 lists per 60s (read-only, more permissive than writes)
  const listBucket = createTokenBucket(30, 60_000);

  return {
    [EnvSetContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for env.set");
      }

      // Rate limit check (BEFORE contract.request.parse for fail-fast).
      const bucket = setBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          { method: "env.set", hint: "Env set rate limit exceeded, retry after cooldown", errorKind: "validation" as const, retryAfterMs: bucket.retryAfterMs },
          "Env set rate limited",
        );
        throw new Error(
          `Env set rate limit exceeded: max 5 sets per minute. ` +
          `Try again in ${Math.ceil(bucket.retryAfterMs! / 1000)} seconds.`,
        );
      }

      // Bespoke pre-Zod reads BEFORE contract parse — the bespoke
      // messages ("Missing required parameter: key", invalid key format,
      // max-length, `[REDACTED]` placeholder rejection) are more
      // actionable than Zod's. The contract's `z.string().min(1)` runs
      // AFTER all bespoke checks for type-narrowing + defense-in-depth.
      const key = rawParams.key as string | undefined;
      const value = rawParams.value as string | undefined;

      // Validate key
      if (!key || typeof key !== "string") {
        throw new Error("Missing required parameter: key");
      }
      if (key.length > MAX_KEY_LENGTH) {
        throw new Error(`Key exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
      }
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error(
          `Invalid key format: "${key}". Keys must start with an uppercase letter ` +
          `and contain only uppercase letters, digits, and underscores (e.g., OPENAI_API_KEY).`,
        );
      }

      // Validate value
      if (value === undefined || value === null || typeof value !== "string") {
        throw new Error("Missing required parameter: value (must be a string)");
      }
      if (value.length === 0) {
        throw new Error("Value must not be empty");
      }
      if (value.length > MAX_VALUE_LENGTH) {
        throw new Error(`Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`);
      }

      // Reject session-redaction placeholders at the RPC boundary. The tool
      // shim rejects the same pattern, and scrubRedactedToolCalls prevents
      // the model from ever seeing "[REDACTED]" in its own replay — but this
      // is the last line of defense. If any of those layers is ever
      // bypassed, regressed, or mis-wired, persisting a literal "[REDACTED]"
      // to ~/.comis/.env corrupts the user's secret store (observed in
      // production for CLOUDFLARE_ACCOUNT_ID).
      // eslint-disable-next-line no-restricted-syntax -- env-handler placeholder-rejection guard (not the Pino censor literal)
      if (value === "[REDACTED]" || /^\[REDACTED[^\]]*\]$/.test(value)) {
        throw new Error(
          `Refusing to persist secret "${key}": value is a session-redaction ` +
          `placeholder, not a real secret. This indicates a replay-poisoning ` +
          `bug upstream. Re-send the actual value.`,
        );
      }

      // Contract parse AFTER bespoke validation — type-narrows + defense-in-depth.
      const userParams = stripInternalFields(rawParams);
      EnvSetContract.request.parse(userParams);

      try {
        // Write to storage backend. SecretStorePort is always wired.
        // Env-mode adapter's set() returns err with an actionable message.
        const setResult = deps.secretStore.set(key, value);
        if (!setResult.ok) {
          throw new Error(`Secret store write failed: ${setResult.error.message}`);
        }

        const durationMs = systemNowMs() - startMs;

        // Audit event (NEVER include value)
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: "system",
          tenantId: deps.container.config.tenantId,
          actionType: "env.set",
          classification: "destructive",
          outcome: "success",
          metadata: { key },
        });

        // Log at INFO (NEVER log value)
        deps.logger.info(
          { method: "env.set", key, durationMs, outcome: "success" },
          "Env secret set",
        );

        // Live-apply for ALL cases (new and rotation): upsert into shared Map so
        // broker/exec observe the new value on the very next request. No restart needed.
        deps.mutableSecretManager.upsert(key, value);

        // Emit secret:changed event — metadata only, never the value (residency).
        deps.container.eventBus.emit("secret:changed", {
          name: key,
          action: "upserted" as const,
          timestamp: systemNowMs(),
        });

        const result = {
          set: true as const,
          key,
          // Reflect the active storage mode. Env mode never reaches
          // here — its set() returns err before this line.
          storage: deps.container.config.security.storage as "encrypted" | "file",
          restarting: false as const,
        };
        if (systemGetEnv("NODE_ENV") !== "production") {
          EnvSetContract.response.parse(result);
        }
        return result;
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const errMsg = e instanceof Error ? e.message : String(e);

        // Audit event on failure (NEVER include value)
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: "system",
          tenantId: deps.container.config.tenantId,
          actionType: "env.set",
          classification: "destructive",
          outcome: "failure",
          metadata: { key, error: errMsg },
        });

        deps.logger.warn(
          { method: "env.set", key, durationMs, outcome: "failure", err: e, hint: "Check active secret storage configuration and file permissions", errorKind: "config" as const },
          "Env set failed",
        );

        throw e;
      }
    },

    /**
     * List configured secret NAMES (admin-only, read-only).
     * Values are NEVER returned. Use before `env.set` to check whether
     * a key is already configured, instead of asking the user to re-send it.
     */
    [EnvListContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for env.list");
      }

      // Rate limit check
      const bucket = listBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          { method: "env.list", hint: "Env list rate limit exceeded, retry after cooldown", errorKind: "validation" as const, retryAfterMs: bucket.retryAfterMs },
          "Env list rate limited",
        );
        throw new Error(
          `Env list rate limit exceeded: max 30 lists per minute. ` +
          `Try again in ${Math.ceil(bucket.retryAfterMs! / 1000)} seconds.`,
        );
      }

      // Strip dispatcher internals + contract parse.
      const userParams = stripInternalFields(rawParams);
      const params = EnvListContract.request.parse(userParams);

      const filter = params.filter;
      const rawLimit = params.limit ?? 100;
      const limit = Math.max(1, Math.min(500, Math.floor(rawLimit)));

      // Source: base SecretManager (same trust model as env.set — admin-only,
      // no per-agent scoping). Names only; the manager's keys() never exposes values.
      let names = deps.container.secretManager.keys();

      if (filter) {
        names = names.filter((n) => matchesSecretPattern(n, filter));
      }

      const total = names.length;
      const truncated = total > limit;
      const selected = names.slice().sort().slice(0, limit);

      // Enrich with SecretStorePort metadata when available.
      // Metadata is name + provider + timestamps — NEVER a value.
      const metaByName = new Map<string, {
        provider?: string;
        description?: string;
        createdAt?: number;
        updatedAt?: number;
        expiresAt?: number;
      }>();
      if (deps.secretStore) {
        const storeResult = deps.secretStore.list();
        if (storeResult.ok) {
          for (const m of storeResult.value) {
            metaByName.set(m.name, {
              provider: m.provider,
              description: m.description,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
              expiresAt: m.expiresAt,
            });
          }
        }
      }

      const secrets = selected.map((name) => {
        const meta = metaByName.get(name);
        if (meta) {
          return { name, source: "secretstore" as const, ...meta };
        }
        return { name, source: "envfile" as const };
      });

      const durationMs = systemNowMs() - startMs;

      // Audit event (names OK — they are identifiers, same policy as env.set.
      // Values are not present in this handler's return path at all.)
      deps.container.eventBus.emit("audit:event", {
        timestamp: systemNowMs(),
        agentId: (rawParams._agentId as string | undefined) ?? "system",
        tenantId: deps.container.config.tenantId,
        actionType: "env.list",
        classification: "read",
        outcome: "success",
        metadata: { count: secrets.length, total, filter: filter ?? null },
      });

      // DEBUG only — never log at INFO. Keeps noisy log pipelines from
      // broadcasting the set of configured secret names.
      deps.logger.debug(
        { method: "env.list", agentId: rawParams._agentId, count: secrets.length, total, filter, durationMs },
        "Env secrets listed",
      );

      const result = { secrets, total, truncated };
      // Dev-mode residency canary: `response.parse(...)` rejects any
      // accidental `value`/`plaintext`/`secret`/`ciphertext` fields on
      // a secret row (they're intentionally absent from
      // `EnvListEntrySchema`). Production skips the parse for
      // cold-start budget compliance.
      if (systemGetEnv("NODE_ENV") !== "production") {
        EnvListContract.response.parse(result);
      }
      return result;
    },
  };
}
