// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted secret management RPC handlers.
 *
 * Provides:
 *   - `secrets.set <name> <value>`    -- store a secret (admin-only, rate-limited, values never logged)
 *   - `secrets.get <name>`            -- retrieve a secret (admin-only; plaintext returned to the authenticated caller only)
 *   - `secrets.list`                  -- list secret NAMES + metadata (admin-only, values NEVER returned)
 *   - `secrets.delete <name>`         -- remove a secret (admin-only, audited)
 *
 * (`secrets.import` is composed at the CLI side as N x `secrets.set` per
 * Phase 31 Open Question #4 -- no new RPC method.)
 *
 * Reviewers: see core/src/security/SECRET-RPC-CHECKLIST.md before merging
 * any change. The residency invariant (MEM-CTX-PORTS-14) hinges on this
 * file passing both the source-rule AST walker (plan 31-08) and the
 * test/integration/secret-rpc-residency.test.ts behavioral test (plan 31-13).
 *
 * Storage: SecretStorePort (encrypted secrets.db via AES-256-GCM). Plaintext
 * never leaves the handler closure; the return-path is the SOLE output.
 *
 * Phase 35 Wave C (Plan 35-08): refactored to use the `@comis/core`
 * contract registry. Method keys are computed-property names
 * (`[SecretsGetContract.method]:`) so the bidirectional 1:1 architecture
 * test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/secrets.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (D-04
 * pitfall 6 — never model internals in the contract schema). The admin
 * trust check reads `rawParams._trustLevel` BEFORE the strip step (the
 * gate stays separate from the contract schema per D-04).
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

import {
  SecretsSetContract,
  SecretsGetContract,
  SecretsListContract,
  SecretsDeleteContract,
  stripInternalFields,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Rate limiter (per-handler scope; mirrors env-handlers.ts pattern verbatim).
// Do NOT extract to a shared module in this plan -- per-handler scope is
// deliberate (KISS / YAGNI).
// ---------------------------------------------------------------------------

/**
 * Token bucket rate limiter.
 * Allows maxTokens operations per windowMs. Refills continuously.
 */
function createTokenBucket(maxTokens: number, windowMs: number) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryConsume(): { allowed: boolean; retryAfterMs?: number } {
      const now = Date.now();
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
 * Re-aliased from the cluster slice in api/types.ts (Plan 34-08a; alias retarget
 * in Plan 34-08c). Single source of truth: AuthApiDeps (shared with auth-handlers
 * + token-handlers). The cluster slice was widened in 34-08c to cover
 * secrets-handler fields (container, logger). DAEMON-API-03 Option A retarget —
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
      const startMs = Date.now();
      // Admin trust check FIRST — separate from the contract schema (D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for secrets.get");
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

      // Strip dispatcher-injected _X internals BEFORE contract parse
      // (D-04 + 35-RESEARCH.md Pitfall 6). Then type-narrow via the
      // contract — defense-in-depth; the bespoke guard above already
      // ensures `name` is a valid non-empty pattern-matching string.
      const userParams = stripInternalFields(rawParams);
      const params = SecretsGetContract.request.parse(userParams);
      const name = params.name;

      if (!deps.secretStore) {
        throw new Error(
          "Encrypted secrets store not configured (SECRETS_MASTER_KEY missing). " +
            "Run `comis secrets init --write` then restart the daemon.",
        );
      }

      const decryptResult = deps.secretStore.getDecrypted(name);
      if (!decryptResult.ok) {
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "secrets.get",
          classification: "neutral",
          outcome: "failure",
          metadata: { name, error: "decryption_failed" },
        });
        deps.logger.warn(
          {
            method: "secrets.get",
            name,
            durationMs: Date.now() - startMs,
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
        timestamp: Date.now(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "secrets.get",
        classification: "neutral",
        outcome: "success",
        metadata: { name, exists: decryptResult.value !== undefined },
      });
      deps.logger.info(
        {
          method: "secrets.get",
          name,
          durationMs: Date.now() - startMs,
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
      // a boolean). Production skips for cold-start budget (D-10).
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
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
      const startMs = Date.now();
      // Admin trust check FIRST — separate from the contract schema (D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for secrets.set");
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
        valueRaw === "[REDACTED]" ||
        REDACTION_PLACEHOLDER_PATTERN.test(valueRaw)
      ) {
        throw new Error(
          `Refusing to persist secret "${nameRaw}": value appears to be a ` +
            `redaction placeholder, not a real secret. Provide the actual value.`,
        );
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse
      // (D-04 + 35-RESEARCH.md Pitfall 6). The contract parse runs AFTER
      // the bespoke guards and serves as type-narrowing + defense-in-depth.
      const userParams = stripInternalFields(rawParams);
      const params = SecretsSetContract.request.parse(userParams);
      const name = params.name;
      const value = params.value;
      const provider = params.provider;
      const description = params.description;
      const expiresAt = params.expiresAt;

      if (!deps.secretStore) {
        throw new Error(
          "Encrypted secrets store not configured (SECRETS_MASTER_KEY missing). " +
            "Run `comis secrets init --write` then restart the daemon.",
        );
      }

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
          timestamp: Date.now(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "secrets.set",
          classification: "destructive",
          outcome: "failure",
          metadata: { name, error: "store_failed" },
        });
        deps.logger.error(
          {
            method: "secrets.set",
            name,
            durationMs: Date.now() - startMs,
            outcome: "failure",
            err: setResult.error,
            hint: "Check secrets store backend and master key configuration",
            errorKind: "config" as const,
          },
          "Secret store failed",
        );
        throw new Error(`Failed to store secret "${name}"`);
      }

      deps.container.eventBus.emit("audit:event", {
        timestamp: Date.now(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "secrets.set",
        classification: "destructive",
        outcome: "success",
        metadata: { name, provider: provider ?? null },
      });
      deps.logger.info(
        {
          method: "secrets.set",
          name,
          durationMs: Date.now() - startMs,
          outcome: "success",
        },
        "Secret stored",
      );

      const result = { name, stored: true };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        SecretsSetContract.response.parse(result);
      }
      return result;
    },

    /**
     * secrets.list -- enumerate secret metadata (name + provider + timestamps).
     * Admin only. Plaintext values are NEVER part of SecretMetadata.
     */
    [SecretsListContract.method]: async (rawParams) => {
      const startMs = Date.now();
      // Admin trust check FIRST — separate from the contract schema (D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for secrets.list");
      }

      // Strip + contract-parse for type narrowing (request has no fields;
      // parse is defense-in-depth + future-proofs against new fields).
      const userParams = stripInternalFields(rawParams);
      SecretsListContract.request.parse(userParams);

      if (!deps.secretStore) {
        // No master key configured -- return empty list, not an error.
        deps.logger.debug(
          { method: "secrets.list", durationMs: Date.now() - startMs },
          "Secrets list returning empty (no encrypted store configured)",
        );
        const emptyResult = { secrets: [] };
        // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
        if (process.env.NODE_ENV !== "production") {
          SecretsListContract.response.parse(emptyResult);
        }
        return emptyResult;
      }

      const listResult = deps.secretStore.list();
      if (!listResult.ok) {
        deps.logger.error(
          {
            method: "secrets.list",
            durationMs: Date.now() - startMs,
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
          durationMs: Date.now() - startMs,
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
      // compliance (WEB-CONTRACTS-17); dev/test catches structural drift.
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
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
      const startMs = Date.now();
      // Admin trust check FIRST — separate from the contract schema (D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for secrets.delete");
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

      if (!deps.secretStore) {
        throw new Error(
          "Encrypted secrets store not configured (SECRETS_MASTER_KEY missing).",
        );
      }

      const delResult = deps.secretStore.delete(name);
      if (!delResult.ok) {
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "secrets.delete",
          classification: "destructive",
          outcome: "failure",
          metadata: { name, error: "delete_failed" },
        });
        deps.logger.error(
          {
            method: "secrets.delete",
            name,
            durationMs: Date.now() - startMs,
            outcome: "failure",
            err: delResult.error,
            hint: "Check secrets.db permissions",
            errorKind: "config" as const,
          },
          "Secret delete failed",
        );
        throw new Error(`Failed to delete secret "${name}"`);
      }

      deps.container.eventBus.emit("audit:event", {
        timestamp: Date.now(),
        agentId: "system",
        tenantId: deps.container.config.tenantId ?? "default",
        actionType: "secrets.delete",
        classification: "destructive",
        outcome: "success",
        metadata: { name, existed: delResult.value },
      });
      deps.logger.info(
        {
          method: "secrets.delete",
          name,
          existed: delResult.value,
          durationMs: Date.now() - startMs,
          outcome: "success",
        },
        "Secret deleted",
      );

      const result = { name, deleted: delResult.value };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        SecretsDeleteContract.response.parse(result);
      }
      return result;
    },
  };
}
