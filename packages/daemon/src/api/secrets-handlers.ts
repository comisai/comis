// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Encrypted secret management RPC handlers.
 *
 * Provides:
 *   - `secrets.set <name> <value>`    -- store a secret (admin-only, rate-limited, values never logged)
 *   - `secrets.get <name>`            -- retrieve a secret (admin-only; plaintext returned to the authenticated caller only)
 *   - `secrets.list`                  -- list secret NAMES + metadata (admin-only, values NEVER returned)
 *   - `secrets.delete <name>`         -- remove a secret (admin-only, audited)
 *
 * (`secrets.import` is composed at the CLI side as N x `secrets.set` --
 * no dedicated RPC method.)
 *
 * Reviewers: see core/src/security/SECRET-RPC-CHECKLIST.md before merging
 * any change. The secret-residency invariant hinges on this file passing
 * both the source-rule AST walker and the
 * test/integration/secret-rpc-residency.test.ts behavioral test.
 *
 * Storage: SecretStorePort (encrypted secrets.db via AES-256-GCM). Plaintext
 * never leaves the handler closure; the return-path is the SOLE output.
 *
 * Handlers use the `@comis/core` contract registry. Method keys are
 * computed-property names (`[SecretsGetContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/secrets.ts`. The dispatcher-injected
 * `_X` internal fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)` (never model internals in the contract
 * schema). The admin trust check reads `rawParams._trustLevel` BEFORE
 * the strip step (the gate stays separate from the contract schema).
 *
 * The bespoke pre-Zod validation (admin gate, name pattern guard, length
 * caps, redaction-placeholder guard) is intentionally retained for
 * user-friendly error UX and security defense-in-depth. The contract
 * parse runs AFTER the bespoke guards and serves to (a) narrow params
 * types for the rest of the handler body and (b) provide a
 * defense-in-depth gate against future drift between the contract schema
 * and the bespoke checks. The dev-mode `Contract.response.parse(...)`
 * gate before each return doubles as a residency canary — for the
 * value-free response shapes (e.g. `secrets.list`'s SecretMetadata rows),
 * default Zod STRIPS unknown keys, so a future change that accidentally
 * adds a `value` field on a row has the value REMOVED from the parsed
 * output before it crosses the daemon → CLI boundary. (`secrets.get`'s
 * response intentionally DOES model `value` as `z.string().optional()` —
 * the canary there is a shape check, not a value-stripping projection.)
 *
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  SecretsSetContract,
  SecretsGetContract,
  SecretsListContract,
  SecretsDeleteContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Rate limiter (per-handler scope; mirrors env-handlers.ts pattern verbatim).
// Per-handler scope is deliberate (KISS / YAGNI) — do NOT extract to a
// shared module.
// ---------------------------------------------------------------------------

/**
 * Token bucket rate limiter.
 * Allows maxTokens operations per windowMs. Refills continuously.
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

/** Dependencies required by secrets handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts. Single source of
 * truth: AuthApiDeps (shared with auth-handlers + token-handlers). The
 * cluster slice covers secrets-handler fields (container, logger);
 * handler body unchanged.
 */
import type { AuthApiDeps as SecretsHandlerDeps } from "./types.js";
export type { SecretsHandlerDeps };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_NAME_LENGTH = 256;
const MAX_VALUE_LENGTH = 8192;
const REDACTION_PLACEHOLDER_PATTERN = /^\[REDACTED[^\]]*\]$/;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the 4 admin-scoped encrypted-secrets RPC handlers.
 *
 * @param deps Injected dependencies (SecretStorePort, AppContainer, ComisLogger)
 * @returns Handler map: `secrets.get`, `secrets.set`, `secrets.list`, `secrets.delete`
 */
export function createSecretsHandlers(
  deps: SecretsHandlerDeps,
): Record<string, RpcHandler> {
  // Token buckets: read-heavy / writes + deletes more conservative.
  const setBucket = createTokenBucket(5, 60_000); // 5 writes / minute
  const readBucket = createTokenBucket(60, 60_000); // 60 reads / minute
  const deleteBucket = createTokenBucket(5, 60_000); // 5 deletes / minute

  return {
    /**
     * secrets.get -- retrieve plaintext for a single secret by name.
     * Admin only. Rate-limited at 60 reads/minute.
     * Audit event records name + outcome (never value).
     */
    [SecretsGetContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for secrets.get");
      }

      const bucket = readBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          {
            method: "secrets.get",
            hint: "Secrets get rate limit exceeded, retry after cooldown",
            errorKind: "validation" as const,
            retryAfterMs: bucket.retryAfterMs,
          },
          "Secrets get rate limited",
        );
        throw new Error(
          `Secrets get rate limit exceeded: max 60 reads per minute. ` +
            `Try again in ${Math.ceil((bucket.retryAfterMs ?? 0) / 1000)} seconds.`,
        );
      }

      // Bespoke name guard FIRST so the user-facing message stays
      // `"Missing required parameter: name"` (legacy UX) — the contract's
      // `z.string().min(1)` would otherwise raise a noisier Zod message.
      const nameRaw = rawParams.name as string | undefined;
      if (!nameRaw || typeof nameRaw !== "string") {
        throw new Error("Missing required parameter: name");
      }
      if (nameRaw.length > MAX_NAME_LENGTH) {
        throw new Error(
          `Name exceeds maximum length of ${MAX_NAME_LENGTH} characters`,
        );
      }
      if (!SECRET_NAME_PATTERN.test(nameRaw)) {
        throw new Error(
          `Invalid name format: "${nameRaw}". Names must start with an uppercase letter ` +
            `and contain only uppercase letters, digits, and underscores (e.g., OPENAI_API_KEY).`,
        );
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      // Then type-narrow via the contract — defense-in-depth; the bespoke
      // guard above already ensures `name` is a valid non-empty
      // pattern-matching string.
      const userParams = stripInternalFields(rawParams);
      const params = SecretsGetContract.request.parse(userParams);
      const name = params.name;

      const decryptResult = deps.secretStore.getDecrypted(name);
      if (!decryptResult.ok) {
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "secrets.get",
          kind: "secret_access",
          outcome: "failure",
          metadata: { name, error: "decryption_failed" },
        });
        deps.logger.warn(
          {
            method: "secrets.get",
            name,
            durationMs: systemNowMs() - startMs,
            outcome: "failure",
            err: decryptResult.error,
            hint: "Verify master key matches the secrets.db",
            errorKind: "auth" as const,
          },
          "Secret decryption failed",
        );
        throw new Error(`Decryption failed for "${name}"`);
      }

      deps.container.eventBus.emit("audit:event", {
        timestamp: systemNowMs(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "secrets.get",
        kind: "secret_access",
        outcome: "success",
        metadata: { name, exists: decryptResult.value !== undefined },
      });
      deps.logger.info(
        {
          method: "secrets.get",
          name,
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "Secret retrieved",
      );

      // RETURN -- the SOLE place plaintext appears in this handler.
      const result = {
        name,
        value: decryptResult.value,
        exists: decryptResult.value !== undefined,
      };
      // Dev-mode response validation gate. The `value` field IS modelled
      // in `SecretsGetContract.response` (as `z.string().optional()`) —
      // unlike `secrets.list` where any leak fails-closed. Here the parse
      // serves as a defense-in-depth shape check (e.g., `exists` must be
      // a boolean). Production skips for cold-start budget.
      if (systemGetEnv("NODE_ENV") !== "production") {
        SecretsGetContract.response.parse(result);
      }
      return result;
    },

    /**
     * secrets.set -- store or update an encrypted secret.
     * Admin only. Rate-limited at 5 writes/minute.
     * Value parameter is passed through to SecretStorePort.set() and NEVER
     * appears in any log call or audit event.
     */
    [SecretsSetContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for secrets.set");
      }

      const bucket = setBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          {
            method: "secrets.set",
            hint: "Secrets set rate limit exceeded, retry after cooldown",
            errorKind: "validation" as const,
            retryAfterMs: bucket.retryAfterMs,
          },
          "Secrets set rate limited",
        );
        throw new Error(
          `Secrets set rate limit exceeded: max 5 writes per minute. ` +
            `Try again in ${Math.ceil((bucket.retryAfterMs ?? 0) / 1000)} seconds.`,
        );
      }

      const nameRaw = rawParams.name as string | undefined;
      const valueRaw = rawParams.value as string | undefined;

      // Bespoke validation FIRST (preserves user-friendly error messages +
      // ordering). The contract `.parse(...)` runs AFTER for type narrowing.
      if (!nameRaw || typeof nameRaw !== "string") {
        throw new Error("Missing required parameter: name");
      }
      if (nameRaw.length > MAX_NAME_LENGTH) {
        throw new Error(
          `Name exceeds maximum length of ${MAX_NAME_LENGTH} characters`,
        );
      }
      if (!SECRET_NAME_PATTERN.test(nameRaw)) {
        throw new Error(
          `Invalid name format: "${nameRaw}". Names must start with an uppercase letter ` +
            `and contain only uppercase letters, digits, and underscores.`,
        );
      }
      if (typeof valueRaw !== "string") {
        throw new Error("Missing required parameter: value");
      }
      if (valueRaw.length === 0) {
        throw new Error("Value cannot be empty");
      }
      if (valueRaw.length > MAX_VALUE_LENGTH) {
        throw new Error(
          `Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`,
        );
      }

      // Redaction-placeholder guard -- mirror env-handlers.ts verbatim.
      // Refuse to store a literal "[REDACTED]" -- this indicates a
      // replay-poisoning bug upstream and would corrupt the secret store.
      if (
        // eslint-disable-next-line no-restricted-syntax -- secrets-handler placeholder-rejection guard (not the Pino censor literal)
        valueRaw === "[REDACTED]" ||
        REDACTION_PLACEHOLDER_PATTERN.test(valueRaw)
      ) {
        throw new Error(
          `Refusing to persist secret "${nameRaw}": value appears to be a ` +
            `redaction placeholder, not a real secret. Provide the actual value.`,
        );
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      // The contract parse runs AFTER the bespoke guards and serves as
      // type-narrowing + defense-in-depth.
      const userParams = stripInternalFields(rawParams);
      const params = SecretsSetContract.request.parse(userParams);
      const name = params.name;
      const value = params.value;
      const provider = params.provider;
      const description = params.description;
      const expiresAt = params.expiresAt;

      // SecretStorePort is always wired; env-mode set() returns err.
      // The value parameter is the plaintext. It flows directly into the
      // store's set() call below and is NEVER assigned to any other binding,
      // logged, or included in an audit event.
      const setResult = deps.secretStore.set(
        name,
        value,
        provider !== undefined || description !== undefined || expiresAt !== undefined
          ? { provider, description, expiresAt }
          : undefined,
      );
      if (!setResult.ok) {
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "secrets.set",
          // AUDIT-04 / M1: a secret MUTATION is a security signal — set `kind`
          // explicitly (mirror secrets.get) so it persists as a security-signal
          // kind, not the generic `audit`/info family.
          kind: "secret_access",
          classification: "destructive",
          outcome: "failure",
          metadata: { name, error: "store_failed" },
        });
        deps.logger.error(
          {
            method: "secrets.set",
            name,
            durationMs: systemNowMs() - startMs,
            outcome: "failure",
            err: setResult.error,
            hint: "Check secrets store backend and master key configuration",
            errorKind: "config" as const,
          },
          "Secret store failed",
        );
        throw new Error(`Failed to store secret "${name}": ${setResult.error.message}`);
      }

      deps.container.eventBus.emit("audit:event", {
        timestamp: systemNowMs(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "secrets.set",
        // AUDIT-04 / M1: security-signal kind for the secret mutation.
        kind: "secret_access",
        classification: "destructive",
        outcome: "success",
        metadata: { name, provider: provider ?? null },
      });
      deps.logger.info(
        {
          method: "secrets.set",
          name,
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "Secret stored",
      );

      // Live-apply for ALL cases (new and rotation): upsert into shared Map so
      // broker/exec observe the new value on the very next request. No restart needed.
      deps.mutableSecretManager.upsert(name, value);

      // Emit secret:changed event — metadata only, never the value (residency).
      deps.container.eventBus.emit("secret:changed", {
        name,
        action: "upserted" as const,
        timestamp: systemNowMs(),
      });

      const result = { name, stored: true, restarting: false as const };
      if (systemGetEnv("NODE_ENV") !== "production") {
        SecretsSetContract.response.parse(result);
      }
      return result;
    },

    /**
     * secrets.list -- enumerate secret metadata (name + provider + timestamps).
     * Admin only. Plaintext values are NEVER part of SecretMetadata.
     */
    [SecretsListContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for secrets.list");
      }

      // Strip + contract-parse for type narrowing (request has no fields;
      // parse is defense-in-depth + future-proofs against new fields).
      const userParams = stripInternalFields(rawParams);
      SecretsListContract.request.parse(userParams);

      // SecretStorePort is always wired; env-mode list() returns the
      // name-scoped snapshot (empty in typical env mode with no sensitive vars set).
      const listResult = deps.secretStore.list();
      if (!listResult.ok) {
        deps.logger.error(
          {
            method: "secrets.list",
            durationMs: systemNowMs() - startMs,
            outcome: "failure",
            err: listResult.error,
            hint: "Check secrets.db file integrity and permissions",
            errorKind: "config" as const,
          },
          "Secrets list failed",
        );
        throw new Error("Failed to list secrets");
      }

      deps.logger.info(
        {
          method: "secrets.list",
          count: listResult.value.length,
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "Secrets listed",
      );

      // SecretMetadata never contains the secret value -- safe to return.
      const result = { secrets: listResult.value };
      // Dev-mode residency canary: `value` / `plaintext` are intentionally
      // absent from SecretMetadataSchema in
      // packages/core/src/api-contracts/secrets.ts (no `.passthrough()`).
      // Default Zod STRIPS unknown keys, so a future change that
      // accidentally adds a `value` field on a row has the value REMOVED
      // from the parsed output BEFORE the response crosses the daemon →
      // CLI boundary. Production skips the parse for cold-start budget
      // compliance; dev/test catches structural drift.
      if (systemGetEnv("NODE_ENV") !== "production") {
        SecretsListContract.response.parse(result);
      }
      return result;
    },

    /**
     * secrets.delete -- remove a secret from the store.
     * Admin only. Rate-limited at 5 deletes/minute. Audit event classified
     * as destructive.
     */
    [SecretsDeleteContract.method]: async (rawParams) => {
      const startMs = systemNowMs();
      // Admin trust check FIRST — separate from the contract schema.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for secrets.delete");
      }

      const bucket = deleteBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          {
            method: "secrets.delete",
            hint: "Secrets delete rate limit exceeded, retry after cooldown",
            errorKind: "validation" as const,
            retryAfterMs: bucket.retryAfterMs,
          },
          "Secrets delete rate limited",
        );
        throw new Error(
          `Secrets delete rate limit exceeded: max 5 deletes per minute. ` +
            `Try again in ${Math.ceil((bucket.retryAfterMs ?? 0) / 1000)} seconds.`,
        );
      }

      const nameRaw = rawParams.name as string | undefined;
      if (!nameRaw || typeof nameRaw !== "string") {
        throw new Error("Missing required parameter: name");
      }
      if (nameRaw.length > MAX_NAME_LENGTH) {
        throw new Error(
          `Name exceeds maximum length of ${MAX_NAME_LENGTH} characters`,
        );
      }
      if (!SECRET_NAME_PATTERN.test(nameRaw)) {
        throw new Error(
          `Invalid name format: "${nameRaw}". Names must start with an uppercase letter ` +
            `and contain only uppercase letters, digits, and underscores.`,
        );
      }

      // Strip + contract-parse for type narrowing.
      const userParams = stripInternalFields(rawParams);
      const params = SecretsDeleteContract.request.parse(userParams);
      const name = params.name;

      // Additive restart rule: check BEFORE store delete to know if this
      // name was live-tracked. Must be pre-delete so the Map reflects current state.
      const existed = deps.container.secretManager.has(name);

      const delResult = deps.secretStore.delete(name);
      if (!delResult.ok) {
        deps.container.eventBus.emit("audit:event", {
          timestamp: systemNowMs(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "secrets.delete",
          // AUDIT-04 / M1: security-signal kind for the secret mutation.
          kind: "secret_access",
          classification: "destructive",
          outcome: "failure",
          metadata: { name, error: "delete_failed" },
        });
        deps.logger.error(
          {
            method: "secrets.delete",
            name,
            durationMs: systemNowMs() - startMs,
            outcome: "failure",
            err: delResult.error,
            hint: "Check secrets.db permissions",
            errorKind: "config" as const,
          },
          "Secret delete failed",
        );
        throw new Error(`Failed to delete secret "${name}": ${delResult.error.message}`);
      }

      deps.container.eventBus.emit("audit:event", {
        timestamp: systemNowMs(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "secrets.delete",
        // AUDIT-04 / M1: security-signal kind for the secret mutation.
        kind: "secret_access",
        classification: "destructive",
        outcome: "success",
        metadata: { name, existed: delResult.value },
      });
      deps.logger.info(
        {
          method: "secrets.delete",
          name,
          existed: delResult.value,
          durationMs: systemNowMs() - startMs,
          outcome: "success",
        },
        "Secret deleted",
      );

      // Delete live-apply: only emit if the name was actually tracked.
      // No-op deletes (name absent from Map) skip both remove and secret:changed.
      if (existed) {
        // Remove from live Map to keep it consistent with the store.
        deps.mutableSecretManager.remove(name);
        // Emit secret:changed — metadata only, never the value (residency).
        deps.container.eventBus.emit("secret:changed", {
          name,
          action: "removed" as const,
          timestamp: systemNowMs(),
        });
      }

      // Use existed || delResult.value for deleted so the response is internally
      // consistent: if the Map tracked the name (existed=true), deletion is
      // authoritative regardless of any store soft-delete quirk. This prevents
      // the { deleted: false, restarting: true } contradictory state.
      const result = { name, deleted: existed || delResult.value, restarting: false as const };
      if (systemGetEnv("NODE_ENV") !== "production") {
        SecretsDeleteContract.response.parse(result);
      }
      return result;
    },
  };
}
